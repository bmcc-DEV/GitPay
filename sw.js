const CACHE_NAME = 'gitpay-v4';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './icon.svg',
  './js/bitcoin.min.js',
  './js/nostr.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  'https://unpkg.com/lucide@latest'
];

// Install and cache
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate and cleanup
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch events intercept
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || event.request.url.includes('mempool.space')) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.status === 200 && event.request.url.startsWith(self.location.origin)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Background Sync
self.addEventListener('sync', event => {
  if (event.tag === 'gitpay-poll') {
    event.waitUntil(pollAndNotifyNostr());
  }
});

// Cryptography Helpers for Service Worker
async function sha256Hex(message) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await self.crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function deriveInvoiceKey(masterKeyHex, index) {
  return await sha256Hex(`${masterKeyHex}-${index}`);
}

async function decryptAesGcm(ciphertextBase64, ivBase64, hexKey) {
  try {
    const rawKey = new Uint8Array(hexKey.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    const key = await self.crypto.subtle.importKey(
      'raw',
      rawKey.buffer,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    const ciphertext = new Uint8Array(atob(ciphertextBase64).split('').map(c => c.charCodeAt(0)));
    const iv = new Uint8Array(atob(ivBase64).split('').map(c => c.charCodeAt(0)));
    
    const decryptedBuffer = await self.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      ciphertext
    );
    return new TextDecoder().decode(decryptedBuffer);
  } catch (err) {
    throw new Error('Decryption failed');
  }
}

// Fetch invoices from Nostr relays in SW using basic WebSockets
function fetchNostrInvoices(relays, pubkey) {
  return new Promise((resolve) => {
    const invoices = [];
    let activeConnections = 0;
    const targetRelays = relays.slice(0, 3);
    
    if (targetRelays.length === 0) resolve([]);
    
    const timeout = setTimeout(() => {
      resolve(invoices);
    }, 5000);
    
    targetRelays.forEach(url => {
      try {
        const ws = new WebSocket(url);
        activeConnections++;
        
        ws.onopen = () => {
          const subId = `sw-${Math.random().toString(36).substring(2, 9)}`;
          ws.send(JSON.stringify(['REQ', subId, { authors: [pubkey], kinds: [30023] }]));
        };
        
        ws.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data);
            if (msg[0] === 'EVENT') {
              const event = msg[2];
              if (!invoices.some(i => i.id === event.id)) {
                invoices.push(event);
              }
            }
          } catch(err) {}
        };
        
        ws.onclose = ws.onerror = () => {
          activeConnections--;
          if (activeConnections <= 0) {
            clearTimeout(timeout);
            resolve(invoices);
          }
        };
      } catch(err) {
        activeConnections--;
      }
    });
  });
}

// Publish event to Nostr relays in SW
function publishNostrEvent(relays, event) {
  const payload = JSON.stringify(['EVENT', event]);
  relays.slice(0, 3).forEach(url => {
    try {
      const ws = new WebSocket(url);
      ws.onopen = () => {
        ws.send(payload);
        setTimeout(() => ws.close(), 1000);
      };
    } catch(e) {}
  });
}

async function pollAndNotifyNostr() {
  console.log('[SW] Background Sync started');
  try {
    const settingsRaw = await getFromIndexedDB('gitpay_settings');
    if (!settingsRaw) return;
    const settings = JSON.parse(settingsRaw);
    if (!settings.nostrNsec || !settings.nostrNpub || !settings.extendedKey) return;

    // Load libraries for cryptographic functions in service worker
    self.importScripts('./js/bitcoin.min.js');

    const relayUrls = (settings.nostrRelays || '')
      .split('\n')
      .map(r => r.trim())
      .filter(r => r.startsWith('wss://') || r.startsWith('ws://'));

    const events = await fetchNostrInvoices(relayUrls, settings.nostrNpub);
    
    for (const event of events) {
      let decrypted = null;
      try {
        const indexTag = event.tags.find(t => t[0] === 'index');
        if (indexTag) {
          const index = parseInt(indexTag[1]);
          const invoiceKey = await deriveInvoiceKey(settings.masterKey, index);
          const contentObj = JSON.parse(event.content);
          const decryptedPayloadRaw = await decryptAesGcm(contentObj.ciphertext, contentObj.iv, invoiceKey);
          decrypted = JSON.parse(decryptedPayloadRaw);
        }
      } catch(e) { continue; }

      if (decrypted && decrypted.status === 'pending') {
        const network = decrypted.network === 'testnet' ? 'testnet/' : '';
        const mempoolRes = await fetch(`https://mempool.space/${network}api/address/${decrypted.address}`);
        if (!mempoolRes.ok) continue;
        const mempoolData = await mempoolRes.json();
        
        const confirmed = mempoolData.chain_stats.funded_txo_sum || 0;
        const unconfirmed = mempoolData.mempool_stats.funded_txo_sum || 0;
        const totalReceived = confirmed + unconfirmed;

        const tolerance = settings.tolerance || 99.5;
        const thresholdSats = decrypted.amount_sats * (tolerance / 100);

        if (totalReceived >= thresholdSats) {
          // Update status payload
          const updatedPayload = { ...decrypted, status: 'paid' };
          const invoiceKey = await deriveInvoiceKey(settings.masterKey, decrypted.index);
          const encryption = await encryptAesGcm(JSON.stringify(updatedPayload), invoiceKey);
          const dTag = await sha256Hex(decrypted.address);

          const updatedEvent = {
            kind: 30023,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ['d', dTag],
              ['index', String(decrypted.index)],
              ['p', settings.nostrNpub]
            ],
            content: JSON.stringify({
              ciphertext: encryption.ciphertext,
              iv: encryption.iv
            })
          };

          // Use the imported GitPayLib inside the SW
          self.GitPayLib.signNostrEvent(updatedEvent, settings.nostrNsec);
          publishNostrEvent(relayUrls, updatedEvent);

          self.registration.showNotification('GitPay Payment Alert', {
            body: `Invoice #${decrypted.index} paid successfully! ${totalReceived.toLocaleString()} sats received.`,
            icon: '/icon.svg'
          });
        }
      }
    }
  } catch (err) {
    console.error('[SW] Background Sync failed:', err);
  }
}

function getFromIndexedDB(key) {
  return new Promise((resolve) => {
    const request = indexedDB.open('gitpay_db', 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('keyvalue')) db.createObjectStore('keyvalue');
    };
    request.onsuccess = (e) => {
      const db = e.target.result;
      try {
        const transaction = db.transaction('keyvalue', 'readonly');
        const store = transaction.objectStore('keyvalue');
        const getReq = store.get(key);
        getReq.onsuccess = () => resolve(getReq.result || null);
        getReq.onerror = () => resolve(null);
      } catch (err) { resolve(null); }
    };
    request.onerror = () => resolve(null);
  });
}
