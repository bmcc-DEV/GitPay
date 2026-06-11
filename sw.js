const CACHE_NAME = 'gitpay-v3';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './icon.svg',
  './js/bitcoin.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  'https://unpkg.com/lucide@latest'
];

// Install Service Worker and cache core files
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[Service Worker] Caching app shell');
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate event - cleanup old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Removing old cache', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event - network first fallback to cache
self.addEventListener('fetch', event => {
  // Bypassing non-GET request and third-party APIs from cache first
  if (event.request.method !== 'GET' || event.request.url.includes('api.github.com') || event.request.url.includes('mempool.space')) {
    return;
  }
  
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache new successful GET requests
        if (response.status === 200 && event.request.url.startsWith(self.location.origin)) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});

// Background Sync for offline merchant tracking
self.addEventListener('sync', event => {
  if (event.tag === 'gitpay-poll') {
    event.waitUntil(pollAndNotify());
  }
});

async function pollAndNotify() {
  console.log('[Service Worker] Background Sync polling started');
  // Safe execution block to avoid breaking SW if indexedDB/settings are empty
  try {
    const settingsRaw = await getFromIndexedDB('gitpay_settings');
    if (!settingsRaw) return;
    const settings = JSON.parse(settingsRaw);
    if (!settings.ghToken || !settings.ghRepo) return;

    // Fetch open issues labelled 'pending' from GitHub
    const [owner, repo] = settings.ghRepo.split('/');
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues?labels=pending&state=open`, {
      headers: {
        'Authorization': `Bearer ${settings.ghToken}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    if (!res.ok) return;
    const issues = await res.json();

    for (const issue of issues) {
      let invoiceData = {};
      try {
        const jsonMatch = issue.body.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) invoiceData = JSON.parse(jsonMatch[1].trim());
      } catch (e) { continue; }

      if (!invoiceData.address || !invoiceData.amount_sats) continue;

      const network = invoiceData.network === 'testnet' ? 'testnet/' : '';
      const mempoolRes = await fetch(`https://mempool.space/${network}api/address/${invoiceData.address}`);
      if (!mempoolRes.ok) continue;
      const mempoolData = await mempoolRes.json();
      
      const confirmed = mempoolData.chain_stats.funded_txo_sum || 0;
      const unconfirmed = mempoolData.mempool_stats.funded_txo_sum || 0;
      const totalReceived = confirmed + unconfirmed;

      const tolerance = settings.tolerance || 99.5;
      const thresholdSats = invoiceData.amount_sats * (tolerance / 100);

      if (totalReceived >= thresholdSats) {
        // Update GitHub
        const updateRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issue.number}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${settings.ghToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            labels: ['paid', 'invoice'],
            state: 'closed'
          })
        });

        if (updateRes.ok) {
          self.registration.showNotification('GitPay Payment Alert', {
            body: `Invoice #${issue.number} has been paid successfully on-chain!`,
            icon: '/icon.svg'
          });
        }
      }
    }
  } catch (err) {
    console.error('[Service Worker] Background Sync failed:', err);
  }
}

// Simple IndexedDB Helper to read settings
function getFromIndexedDB(key) {
  return new Promise((resolve) => {
    const request = indexedDB.open('gitpay_db', 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('keyvalue')) {
        db.createObjectStore('keyvalue');
      }
    };
    request.onsuccess = (e) => {
      const db = e.target.result;
      try {
        const transaction = db.transaction('keyvalue', 'readonly');
        const store = transaction.objectStore('keyvalue');
        const getReq = store.get(key);
        getReq.onsuccess = () => resolve(getReq.result || null);
        getReq.onerror = () => resolve(null);
      } catch (err) {
        resolve(null);
      }
    };
    request.onerror = () => resolve(null);
  });
}
