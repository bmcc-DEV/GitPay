// Global State Variables
let gitPaySettings = {
  nostrNsec: '',
  nostrNpub: '',
  nostrRelays: 'wss://nos.lol\nwss://relay.damus.io\nwss://relay.snort.social',
  extendedKey: '',
  network: 'mainnet',
  fiatCurrency: 'USD',
  masterKey: '',
  tolerance: 99.5,
  localWebhook: '',
  localDiscord: '',
  localTgToken: '',
  localTgChat: ''
};

// Hardcoded developer public xpub for the 1% fee routing
const DEVELOPER_XPUB = 'tpubD6NzVbkrYhZ4X3K35Y822cW2qJ7yFasS47H4y8nUUrk6B9s4MQLv62uA1a8j2iV986o8r8aT9oU85M45aB';

let nostr = null;
let btcPrice = 0.0;
let qrCodeInstance = null;
let customerPollInterval = null;
let customerTimerInterval = null;
let cachedInvoices = [];
let activeSyncInterval = null;
let receiptsSubId = null;

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  // Initialize Lucide Icons
  lucide.createIcons();
  
  // Load settings from localStorage
  loadSettings();

  // Register Service Worker for PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => {
        console.log('[PWA] Service Worker registered successfully:', reg.scope);
        syncSettingsToIndexedDB(gitPaySettings);
      })
      .catch(err => console.warn('[PWA] Service Worker registration failed:', err));
  }

  // Check URL parameters for customer invoice view
  const urlParams = new URLSearchParams(window.location.search);
  const invoiceAddress = urlParams.get('invoice');

  if (invoiceAddress) {
    // Customer Payment Mode
    setupCustomerView();
    loadCustomerInvoice(invoiceAddress);
  } else {
    // Merchant Dashboard Mode
    setupMerchantView();
  }
});

// ================= CRYPTOGRAPHY HELPERS (AES-GCM WebCrypto with XOR fallback) =================

const isWebCryptoSupported = typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';

function generateRandomHex(length) {
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(message) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Fallback XOR encryption/decryption for non-secure contexts (HTTP, local files)
function xorEncryptDecrypt(text, hexKey) {
  let result = '';
  const keyBytes = [];
  for (let i = 0; i < hexKey.length; i += 2) {
    keyBytes.push(parseInt(hexKey.substr(i, 2), 16) || 0);
  }
  if (keyBytes.length === 0) keyBytes.push(42);

  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    const keyByte = keyBytes[i % keyBytes.length];
    const xorValue = charCode ^ keyByte;
    result += String.fromCharCode(xorValue);
  }
  return result;
}

// Derives a deterministic key for an invoice based on merchant masterKey and invoice index
async function deriveInvoiceKey(masterKeyHex, index) {
  const message = `${masterKeyHex}-${index}`;
  if (!isWebCryptoSupported) {
    let hash = 0;
    for (let i = 0; i < message.length; i++) {
      hash = (hash << 5) - hash + message.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16).repeat(8).substring(0, 64).padEnd(64, 'f');
  }
  return await sha256Hex(message);
}

async function encryptAesGcm(text, hexKey) {
  if (!isWebCryptoSupported) {
    console.warn('WebCrypto not supported in this context. Using XOR obfuscation fallback.');
    try {
      const ciphertext = btoa(unescape(encodeURIComponent(xorEncryptDecrypt(text, hexKey))));
      return { ciphertext: ciphertext, iv: 'xor-fallback' };
    } catch (e) {
      return { ciphertext: btoa(xorEncryptDecrypt(text, hexKey)), iv: 'xor-fallback' };
    }
  }

  const encoder = new TextEncoder();
  const cleanKey = hexKey.trim();
  const rawKey = new Uint8Array(cleanKey.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
  
  const key = await crypto.subtle.importKey(
    'raw',
    rawKey.buffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    encoder.encode(text)
  );
  
  const ciphertextBase64 = btoa(String.fromCharCode(...new Uint8Array(ciphertextBuffer)));
  const ivBase64 = btoa(String.fromCharCode(...iv));
  
  return { ciphertext: ciphertextBase64, iv: ivBase64 };
}

async function decryptAesGcm(ciphertextBase64, ivBase64, hexKey) {
  if (ivBase64 === 'xor-fallback' || !isWebCryptoSupported) {
    try {
      const decodedText = decodeURIComponent(escape(xorEncryptDecrypt(atob(ciphertextBase64), hexKey)));
      return decodedText;
    } catch (e) {
      return xorEncryptDecrypt(atob(ciphertextBase64), hexKey);
    }
  }

  try {
    const decoder = new TextDecoder();
    const cleanKey = hexKey.trim();
    const rawKey = new Uint8Array(cleanKey.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    
    const key = await crypto.subtle.importKey(
      'raw',
      rawKey.buffer,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    
    const ciphertext = new Uint8Array(atob(ciphertextBase64).split('').map(c => c.charCodeAt(0)));
    const iv = new Uint8Array(atob(ivBase64).split('').map(c => c.charCodeAt(0)));
    
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      ciphertext
    );
    
    return decoder.decode(decryptedBuffer);
  } catch (err) {
    console.error('Decryption failed', err);
    return '[Encrypted Description - Decryption Key Required]';
  }
}

// ================= LAYOUT CONFIGURATION =================

function setupMerchantView() {
  document.getElementById('merchant-header').style.display = 'block';
  document.getElementById('view-dashboard').classList.add('active');
  document.getElementById('view-customer').style.display = 'none';

  // Check if settings are valid, if not show setup warning
  if (!validateSettings(gitPaySettings)) {
    document.getElementById('setup-warning-card').style.display = 'flex';
    switchTab('settings');
  } else {
    document.getElementById('setup-warning-card').style.display = 'none';
    startActiveSync();
  }

  // Load BTC exchange rates
  fetchBtcPrice();
}

function setupCustomerView() {
  document.getElementById('merchant-header').style.display = 'none';
  
  // Hide all merchant tabs
  const tabs = document.querySelectorAll('.view-section');
  tabs.forEach(tab => tab.classList.remove('active'));
  
  // Show customer view
  const customerView = document.getElementById('view-customer');
  customerView.classList.add('active');
  document.getElementById('main-content').style.padding = '1rem';
}

function switchTab(tabName) {
  // Update nav buttons
  const navButtons = document.querySelectorAll('.nav-btn');
  navButtons.forEach(btn => {
    if (btn.id === `nav-${tabName}`) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Update sections
  const sections = document.querySelectorAll('.view-section');
  sections.forEach(sec => {
    if (sec.id === `view-${tabName}`) {
      sec.classList.add('active');
    } else {
      sec.classList.remove('active');
    }
  });

  // Specific triggers
  if (tabName === 'dashboard') {
    startActiveSync();
  } else if (tabName === 'create') {
    fetchBtcPrice();
    calculateNextDerivationIndex();
  }
}

// ================= SETTINGS MANAGEMENT =================

function loadSettings() {
  const saved = localStorage.getItem('gitpay_settings_nostr');
  if (saved) {
    try {
      gitPaySettings = { ...gitPaySettings, ...JSON.parse(saved) };
    } catch (e) {
      console.error('Failed to parse settings', e);
    }
  }

  // Auto-generate key if not set
  if (!gitPaySettings.masterKey) {
    gitPaySettings.masterKey = generateRandomHex(32);
    localStorage.setItem('gitpay_settings_nostr', JSON.stringify(gitPaySettings));
  }
  if (!gitPaySettings.tolerance) {
    gitPaySettings.tolerance = 99.5;
  }

  // Auto-generate Nostr Store Keys if not set
  if (!gitPaySettings.nostrNsec) {
    gitPaySettings.nostrNsec = GitPayLib.generateNostrPrivateKey();
    gitPaySettings.nostrNpub = GitPayLib.getNostrPublicKey(gitPaySettings.nostrNsec);
    localStorage.setItem('gitpay_settings_nostr', JSON.stringify(gitPaySettings));
  }

  // Populate form fields
  document.getElementById('setting-nostr-nsec').value = gitPaySettings.nostrNsec || '';
  document.getElementById('setting-nostr-npub').value = gitPaySettings.nostrNpub || '';
  document.getElementById('setting-nostr-relays').value = gitPaySettings.nostrRelays || '';
  document.getElementById('setting-extended-key').value = gitPaySettings.extendedKey || '';
  document.getElementById('setting-network').value = gitPaySettings.network || 'mainnet';
  document.getElementById('setting-fiat-currency').value = gitPaySettings.fiatCurrency || 'USD';
  document.getElementById('setting-master-key').value = gitPaySettings.masterKey || '';
  document.getElementById('setting-tolerance').value = gitPaySettings.tolerance || 99.5;
  document.getElementById('setting-local-webhook').value = gitPaySettings.localWebhook || '';
  document.getElementById('setting-local-discord').value = gitPaySettings.localDiscord || '';
  document.getElementById('setting-local-tg-token').value = gitPaySettings.localTgToken || '';
  document.getElementById('setting-local-tg-chat').value = gitPaySettings.localTgChat || '';

  updateFiatSymbol(gitPaySettings.fiatCurrency);
  
  // Initialize relays connections
  initNostr();
}

function initNostr() {
  if (nostr) {
    nostr.disconnectAll();
  }
  
  const relayUrls = (gitPaySettings.nostrRelays || '')
    .split('\n')
    .map(r => r.trim())
    .filter(r => r.startsWith('wss://') || r.startsWith('ws://'));
    
  nostr = new NostrClient(relayUrls);
  nostr.connectAll();
}

function handleSaveSettings(event) {
  event.preventDefault();

  const nsec = document.getElementById('setting-nostr-nsec').value.trim();
  const relays = document.getElementById('setting-nostr-relays').value.trim();
  const xkey = document.getElementById('setting-extended-key').value.trim();
  const net = document.getElementById('setting-network').value;
  const fiat = document.getElementById('setting-fiat-currency').value;
  const masterKey = document.getElementById('setting-master-key').value.trim();
  const tolerance = parseFloat(document.getElementById('setting-tolerance').value);
  const localWebhook = document.getElementById('setting-local-webhook').value.trim();
  const localDiscord = document.getElementById('setting-local-discord').value.trim();
  const localTgToken = document.getElementById('setting-local-tg-token').value.trim();
  const localTgChat = document.getElementById('setting-local-tg-chat').value.trim();

  if (masterKey.length !== 64) {
    showToast('Error: Master Key must be exactly 64 hex characters (32 bytes).', 'danger');
    return;
  }

  if (nsec.length !== 64) {
    showToast('Error: Nostr private key must be exactly 64 hex characters.', 'danger');
    return;
  }

  let derivedNpub = '';
  try {
    derivedNpub = GitPayLib.getNostrPublicKey(nsec);
  } catch (e) {
    showToast('Error: Invalid Nostr private key.', 'danger');
    return;
  }

  // Validate the public key prefix using GitPayLib
  try {
    const testDerivation = GitPayLib.deriveAddress({
      extendedKey: xkey,
      index: 0,
      networkType: net
    });
    console.log('Wallet derived address successfully:', testDerivation.address);
  } catch (err) {
    showToast(`Wallet Error: ${err.message}`, 'danger');
    return;
  }

  // Save state
  gitPaySettings = {
    nostrNsec: nsec,
    nostrNpub: derivedNpub,
    nostrRelays: relays,
    extendedKey: xkey,
    network: net,
    fiatCurrency: fiat,
    masterKey: masterKey,
    tolerance: tolerance,
    localWebhook: localWebhook,
    localDiscord: localDiscord,
    localTgToken: localTgToken,
    localTgChat: localTgChat
  };

  localStorage.setItem('gitpay_settings_nostr', JSON.stringify(gitPaySettings));
  syncSettingsToIndexedDB(gitPaySettings);
  updateFiatSymbol(fiat);

  document.getElementById('setup-warning-card').style.display = 'none';
  showToast('Settings saved & key validated! ✅', 'success');

  initNostr();
  fetchBtcPrice();
  switchTab('dashboard');
}

function triggerGenerateNostrKeys() {
  if (confirm('Warning: Generating a new Nostr Private Key will change your store identity. You will no longer view invoices created under the old identity on this device. Continue?')) {
    const nsec = GitPayLib.generateNostrPrivateKey();
    document.getElementById('setting-nostr-nsec').value = nsec;
    deriveNostrPubKey();
    showToast('New Nostr keys generated. Click Save to apply.', 'info');
  }
}

function deriveNostrPubKey() {
  const nsecInput = document.getElementById('setting-nostr-nsec').value.trim();
  const npubInput = document.getElementById('setting-nostr-npub');
  
  if (nsecInput.length === 64) {
    try {
      const npub = GitPayLib.getNostrPublicKey(nsecInput);
      npubInput.value = npub;
    } catch (e) {
      npubInput.value = 'Invalid Private Key';
    }
  } else {
    npubInput.value = '';
  }
}

function validateSettings(settings) {
  return settings.nostrNsec && settings.extendedKey;
}

function updateFiatSymbol(currency) {
  const symbols = { 'USD': '$', 'BRL': 'R$', 'EUR': '€', 'GBP': '£' };
  document.getElementById('fiat-symbol-icon').innerText = symbols[currency] || '$';
}

// ================= Active Sync Timer (Visibility API) =================

function startActiveSync() {
  if (activeSyncInterval) clearInterval(activeSyncInterval);
  // Initial sync
  syncInvoicesList();
  // Poll every 8 seconds
  activeSyncInterval = setInterval(() => {
    if (!document.hidden && validateSettings(gitPaySettings)) {
      console.log('[ActiveSync] Automatically checking pending invoices...');
      triggerLocalBlockchainCheck(cachedInvoices);
    }
  }, 8000);
}

function stopActiveSync() {
  if (activeSyncInterval) {
    clearInterval(activeSyncInterval);
    activeSyncInterval = null;
  }
}

document.addEventListener('visibilitychange', () => {
  const isMerchantView = document.getElementById('view-dashboard') && 
                         (document.getElementById('view-dashboard').classList.contains('active') ||
                          document.getElementById('view-create').classList.contains('active') ||
                          document.getElementById('view-settings').classList.contains('active'));
  if (document.hidden) {
    console.log('[ActiveSync] Tab backgrounded, pausing sync');
    stopActiveSync();
  } else if (isMerchantView) {
    console.log('[ActiveSync] Tab focused, resuming sync');
    startActiveSync();
  }
});

function syncSettingsToIndexedDB(settings) {
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
      const transaction = db.transaction('keyvalue', 'readwrite');
      const store = transaction.objectStore('keyvalue');
      store.put(JSON.stringify(settings), 'gitpay_settings');
    } catch (err) {
      console.warn('Failed to sync settings to IndexedDB:', err);
    }
  };
}

// ================= FIAT CONVERSION =================

async function fetchBtcPrice() {
  const currency = gitPaySettings.fiatCurrency || 'USD';
  try {
    const response = await fetch(`https://api.coinbase.com/v2/prices/BTC-${currency}/spot`);
    if (response.ok) {
      const json = await response.json();
      btcPrice = parseFloat(json.data.amount);
      convertFiatToSats();
    }
  } catch (error) {
    console.error('Failed to fetch Bitcoin exchange rate', error);
  }
}

function convertFiatToSats() {
  const fiatVal = parseFloat(document.getElementById('invoice-amount-fiat').value);
  if (!isNaN(fiatVal) && btcPrice > 0) {
    const sats = Math.round((fiatVal / btcPrice) * 100000000);
    document.getElementById('invoice-amount-sats').value = sats;
    updateBtcEquivalent(sats);
  } else if (document.getElementById('invoice-amount-fiat').value === '') {
    document.getElementById('invoice-amount-sats').value = '';
    updateBtcEquivalent(0);
  }
}

function convertSatsToFiat() {
  const satsVal = parseInt(document.getElementById('invoice-amount-sats').value);
  if (!isNaN(satsVal) && btcPrice > 0) {
    const fiat = ((satsVal / 100000000) * btcPrice).toFixed(2);
    document.getElementById('invoice-amount-fiat').value = fiat;
    updateBtcEquivalent(satsVal);
  } else if (document.getElementById('invoice-amount-sats').value === '') {
    document.getElementById('invoice-amount-fiat').value = '';
    updateBtcEquivalent(0);
  }
}

function updateBtcEquivalent(sats) {
  const btcVal = (sats / 100000000).toFixed(8);
  document.getElementById('btc-equivalent-value').innerText = `${btcVal} BTC`;
}

// ================= INVOICE GENERATOR & NOSTR LEDGER =================

function syncInvoicesList() {
  const tableBody = document.getElementById('invoices-list-body');
  
  if (!validateSettings(gitPaySettings)) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center" style="color: var(--text-muted); padding: 2rem;">
          <i data-lucide="alert-circle" style="margin-bottom: 0.5rem; display: block; margin-left: auto; margin-right: auto;"></i>
          Please configure GitPay in Settings first.
        </td>
      </tr>
    `;
    lucide.createIcons();
    return;
  }

  // Show loading indicator
  tableBody.innerHTML = `
    <tr>
      <td colspan="7" class="text-center" style="color: var(--text-muted); padding: 3rem;">
        <i data-lucide="loader-2" style="animation: spin 1s infinite linear; margin-bottom: 0.5rem; display: block; margin-left: auto; margin-right: auto; width: 24px; height: 24px;"></i>
        Syncing with Nostr decentralized ledger...
      </td>
    </tr>
  `;
  lucide.createIcons();

  try {
    if (!nostr) initNostr();

    // Query Kind 30023 events published by the merchant's pubkey
    const subId = `merchant-invoices-${Math.random().toString(36).substring(2, 9)}`;
    const filter = {
      authors: [gitPaySettings.nostrNpub],
      kinds: [30023],
      limit: 100
    };

    cachedInvoices = [];

    // Set a timeout to render what we get if relays are slow
    const renderTimeout = setTimeout(() => {
      nostr.unsubscribe(subId);
      renderInvoicesTable(cachedInvoices);
      updateDashboardStats(cachedInvoices);
      triggerLocalBlockchainCheck(cachedInvoices);
    }, 2500);

    nostr.subscribe(subId, filter, async (event) => {
      // Avoid duplicate event processing
      if (cachedInvoices.some(inv => inv.id === event.id)) return;
      
      // Decrypt the Aetheris payload
      let decrypted = null;
      try {
        const indexTag = event.tags.find(t => t[0] === 'index');
        if (indexTag) {
          const index = parseInt(indexTag[1]);
          const invoiceKey = await deriveInvoiceKey(gitPaySettings.masterKey, index);
          
          const contentObj = JSON.parse(event.content);
          const decryptedPayloadRaw = await decryptAesGcm(contentObj.ciphertext, contentObj.iv, invoiceKey);
          decrypted = JSON.parse(decryptedPayloadRaw);
        }
      } catch (err) {
        console.warn(`[Nostr] Failed to decrypt event ${event.id}:`, err);
      }

      if (decrypted) {
        // Build simulated invoice object
        const invoice = {
          id: event.id,
          number: decrypted.index,
          pubkey: event.pubkey,
          created_at: decrypted.created_at,
          address: decrypted.address,
          amount_sats: decrypted.amount_sats,
          network: decrypted.network,
          tolerance: decrypted.tolerance,
          status: decrypted.status || 'pending',
          description: decrypted.description,
          event: event
        };

        cachedInvoices.push(invoice);
        
        // Sort invoices by index descending
        cachedInvoices.sort((a, b) => b.number - a.number);

        // Update view
        renderInvoicesTable(cachedInvoices);
        updateDashboardStats(cachedInvoices);
        
        // Subscribe to client payment receipts dynamically
        subscribeToReceipts(cachedInvoices);
      }
    });

  } catch (error) {
    showToast(`Sync Error: ${error.message}`, 'danger');
    tableBody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center" style="color: var(--danger-color); padding: 2rem;">
          <i data-lucide="x-circle" style="margin-bottom: 0.5rem; display: block; margin-left: auto; margin-right: auto;"></i>
          Failed to sync invoices. Verify your Nostr configurations.
        </td>
      </tr>
    `;
    lucide.createIcons();
  }
}

function subscribeToReceipts(invoices) {
  const pendingInvoices = invoices.filter(inv => inv.status === 'pending');
  if (pendingInvoices.length === 0) return;
  
  if (receiptsSubId) {
    nostr.unsubscribe(receiptsSubId);
  }
  
  const pendingIds = pendingInvoices.map(inv => inv.id);
  receiptsSubId = `merchant-receipts-${Math.random().toString(36).substring(2, 9)}`;
  const filter = {
    kinds: [23001],
    '#e': pendingIds
  };
  
  nostr.subscribe(receiptsSubId, filter, async (event) => {
    const invoiceEventId = event.tags.find(t => t[0] === 'e')[1];
    const inv = pendingInvoices.find(i => i.id === invoiceEventId);
    
    if (inv && inv.status === 'pending') {
      console.log(`[Nostr] Received receipt for invoice #${inv.number}. Verifying blockchain...`);
      verifyInvoiceManually(inv.number);
    }
  });
}

async function renderInvoicesTable(invoices) {
  const tableBody = document.getElementById('invoices-list-body');
  
  if (invoices.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center" style="color: var(--text-muted); padding: 3rem;">
          No invoices found. Click on "Create Invoice" to generate one.
        </td>
      </tr>
    `;
    return;
  }

  let html = '';
  for (const inv of invoices) {
    const checkoutUrl = `${window.location.origin}${window.location.pathname}?invoice=${inv.address}`;
    const invoiceKey = await deriveInvoiceKey(gitPaySettings.masterKey, inv.number);
    const customerUrl = `${checkoutUrl}#key=${invoiceKey}`;

    // Determine status badge
    let statusBadge = '<span class="badge badge-pending">Pending</span>';
    if (inv.status === 'paid') {
      statusBadge = '<span class="badge badge-paid">Paid</span>';
    } else if (inv.status === 'expired') {
      statusBadge = '<span class="badge badge-expired">Expired</span>';
    }

    const shortAddress = `${inv.address.substring(0, 8)}...${inv.address.substring(inv.address.length - 8)}`;
    const createdAtStr = new Date(inv.created_at).toLocaleString();

    html += `
      <tr id="invoice-row-${inv.number}">
        <td class="nowrap"><strong>#${inv.number}</strong></td>
        <td>${escapeHtml(inv.description)}</td>
        <td class="nowrap" style="font-family: monospace; font-size: 0.8rem;" title="${inv.address}">
          ${shortAddress}
        </td>
        <td class="text-right nowrap" style="font-family: monospace; font-weight: 600;">
          ${inv.amount_sats.toLocaleString()}
        </td>
        <td class="text-center nowrap" id="invoice-status-cell-${inv.number}">${statusBadge}</td>
        <td class="nowrap" style="font-size: 0.8rem; color: var(--text-secondary);">${createdAtStr}</td>
        <td class="text-center nowrap">
          <button class="btn" style="padding: 0.35rem 0.65rem; font-size: 0.8rem;" onclick="copyPaymentLink('${customerUrl}')" title="Copy Customer Payment Link">
            <i data-lucide="link" style="width: 14px; height: 14px;"></i> Link
          </button>
          ${inv.status === 'pending' ? `
          <button class="btn btn-secondary" style="padding: 0.35rem 0.65rem; font-size: 0.8rem; margin-left: 0.25rem;" onclick="verifyInvoiceManually(${inv.number})" id="btn-verify-${inv.number}" title="Manually verify this payment">
            <i data-lucide="refresh-cw" style="width: 12px; height: 12px;"></i> Verify
          </button>
          ` : ''}
        </td>
      </tr>
    `;
  }

  tableBody.innerHTML = html;
  lucide.createIcons();
}

function updateDashboardStats(invoices) {
  let paid = 0;
  let pending = 0;
  let expired = 0;

  invoices.forEach(inv => {
    if (inv.status === 'paid') paid++;
    else if (inv.status === 'pending') pending++;
    else if (inv.status === 'expired') expired++;
  });

  document.getElementById('stat-paid-count').innerText = paid;
  document.getElementById('stat-pending-count').innerText = pending;
  document.getElementById('stat-expired-count').innerText = expired;
}

// Scans pending invoices locally from merchant browser
// and updates the ledger on Nostr immediately if a payment is detected.
async function triggerLocalBlockchainCheck(invoices) {
  const pendingInvoices = invoices.filter(inv => inv.status === 'pending');

  for (const inv of pendingInvoices) {
    const isTestnet = inv.network === 'testnet';
    const mempoolUrl = isTestnet 
      ? `https://mempool.space/testnet/api/address/${inv.address}`
      : `https://mempool.space/api/address/${inv.address}`;

    try {
      const response = await fetch(mempoolUrl);
      if (!response.ok) continue;

      const data = await response.json();
      const confirmed = data.chain_stats.funded_txo_sum || 0;
      const unconfirmed = data.mempool_stats.funded_txo_sum || 0;
      const totalReceived = confirmed + unconfirmed;

      const targetSats = inv.amount_sats;
      const tolerance = gitPaySettings.tolerance || 99.5;
      const thresholdSats = targetSats * (tolerance / 100);

      if (totalReceived >= thresholdSats) {
        console.log(`Local detection: Invoice #${inv.number} has been paid on-chain! Updating Nostr...`);
        
        const statusCell = document.getElementById(`invoice-status-cell-${inv.number}`);
        if (statusCell) {
          statusCell.innerHTML = `<span class="badge badge-paid" style="animation: pulse 1s infinite;"><i data-lucide="loader-2" style="animation: spin 1s infinite linear; width: 12px; height: 12px;"></i> Saving...</span>`;
          lucide.createIcons();
        }

        await confirmPaymentOnNostr(inv, totalReceived);
      }
    } catch (err) {
      console.error(`Failed local ledger check for Invoice #${inv.number}:`, err);
    }
  }
}

async function confirmPaymentOnNostr(inv, receivedSats) {
  try {
    const updatedPayload = {
      index: inv.number,
      amount_sats: inv.amount_sats,
      address: inv.address,
      created_at: inv.created_at,
      network: inv.network,
      tolerance: inv.tolerance,
      description: inv.description,
      status: 'paid'
    };

    const invoiceKey = await deriveInvoiceKey(gitPaySettings.masterKey, inv.number);
    const encryption = await encryptAesGcm(JSON.stringify(updatedPayload), invoiceKey);
    const dTag = await sha256Hex(inv.address);

    const event = {
      kind: 30023,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', dTag],
        ['index', String(inv.number)],
        ['p', gitPaySettings.nostrNpub]
      ],
      content: JSON.stringify({
        ciphertext: encryption.ciphertext,
        iv: encryption.iv
      })
    };

    GitPayLib.signNostrEvent(event, gitPaySettings.nostrNsec);
    nostr.publish(event);

    showToast(`Invoice #${inv.number} marked as Paid!`, 'success');
    
    // Update local state
    inv.status = 'paid';
    renderInvoicesTable(cachedInvoices);
    updateDashboardStats(cachedInvoices);

    // Dispatch local notifications
    await sendLocalNotifications('invoice.paid', inv.number, inv, receivedSats);
  } catch (err) {
    console.error('Error confirming payment on Nostr:', err);
  }
}

async function verifyInvoiceManually(index) {
  const btn = document.getElementById(`btn-verify-${index}`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2" style="animation: spin 1s infinite linear; width: 12px; height: 12px;"></i> checking...`;
    lucide.createIcons();
  }

  const inv = cachedInvoices.find(i => i.number === index);
  if (!inv) {
    showToast('Failed to find invoice details.', 'danger');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="refresh-cw" style="width: 12px; height: 12px;"></i> Verify`;
      lucide.createIcons();
    }
    return;
  }

  const isTestnet = inv.network === 'testnet';
  const mempoolUrl = isTestnet 
    ? `https://mempool.space/testnet/api/address/${inv.address}`
    : `https://mempool.space/api/address/${inv.address}`;

  try {
    const response = await fetch(mempoolUrl);
    if (!response.ok) throw new Error(`Mempool API returned status ${response.status}`);

    const data = await response.json();
    const confirmed = data.chain_stats.funded_txo_sum || 0;
    const unconfirmed = data.mempool_stats.funded_txo_sum || 0;
    const totalReceived = confirmed + unconfirmed;

    const targetSats = inv.amount_sats;
    const tolerance = gitPaySettings.tolerance || 99.5;
    const thresholdSats = targetSats * (tolerance / 100);

    if (totalReceived >= thresholdSats) {
      showToast(`Payment of ${totalReceived} sats detected!`, 'success');
      await confirmPaymentOnNostr(inv, totalReceived);
    } else {
      // Expiry check (15 mins)
      const timeElapsed = Date.now() - inv.created_at;
      const expiryLimit = 15 * 60 * 1000;
      
      if (timeElapsed > expiryLimit) {
        showToast('Invoice expired. Marking expired on Nostr...', 'info');
        await markExpiredOnNostr(inv);
      } else {
        const minutesLeft = Math.round((expiryLimit - timeElapsed) / 60000);
        showToast(`Still pending: ${totalReceived.toLocaleString()} / ${targetSats.toLocaleString()} sats received. ~${minutesLeft}m left.`, 'info');
      }
    }
  } catch (err) {
    showToast(`Verification failed: ${err.message}`, 'danger');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="refresh-cw" style="width: 12px; height: 12px;"></i> Verify`;
      lucide.createIcons();
    }
  }
}

async function markExpiredOnNostr(inv) {
  try {
    const updatedPayload = {
      index: inv.number,
      amount_sats: inv.amount_sats,
      address: inv.address,
      created_at: inv.created_at,
      network: inv.network,
      tolerance: inv.tolerance,
      description: inv.description,
      status: 'expired'
    };

    const invoiceKey = await deriveInvoiceKey(gitPaySettings.masterKey, inv.number);
    const encryption = await encryptAesGcm(JSON.stringify(updatedPayload), invoiceKey);
    const dTag = await sha256Hex(inv.address);

    const event = {
      kind: 30023,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', dTag],
        ['index', String(inv.number)],
        ['p', gitPaySettings.nostrNpub]
      ],
      content: JSON.stringify({
        ciphertext: encryption.ciphertext,
        iv: encryption.iv
      })
    };

    GitPayLib.signNostrEvent(event, gitPaySettings.nostrNsec);
    nostr.publish(event);

    showToast(`Invoice #${inv.number} marked as Expired!`, 'info');
    
    inv.status = 'expired';
    renderInvoicesTable(cachedInvoices);
    updateDashboardStats(cachedInvoices);
    
    await sendLocalNotifications('invoice.expired', inv.number, inv, 0);
  } catch (err) {
    console.error('Error marking expired on Nostr:', err);
  }
}

async function sendLocalNotifications(event, indexNumber, invoice, receivedSats = 0) {
  const isTestnet = invoice.network === 'testnet';
  const explorerUrl = isTestnet 
    ? `https://mempool.space/testnet/address/${invoice.address}`
    : `https://mempool.space/address/${invoice.address}`;
  
  const statusText = event === 'invoice.paid' ? 'PAID ✅' : 'EXPIRED ⏰';
  const color = event === 'invoice.paid' ? 1095553 : 15680572; // Hex: 0x10b981 (green) vs 0xef4444 (red)

  // 1. Generic HTTP POST Webhook
  const webhookUrl = gitPaySettings.localWebhook;
  if (webhookUrl) {
    console.log(`Triggering local generic webhook...`);
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event,
          index: indexNumber,
          invoice: {
            ...invoice,
            received_sats: receivedSats,
            completed_at: Date.now()
          }
        })
      });
    } catch (e) { console.error('Local webhook failed:', e.message); }
  }

  // 2. Discord Webhook Notification
  const discordUrl = gitPaySettings.localDiscord;
  if (discordUrl) {
    console.log(`Sending local Discord notification...`);
    try {
      const embed = {
        title: `GitPay Invoice Alert (Local Trigger) - ${statusText}`,
        color: color,
        fields: [
          { name: 'Invoice', value: `#${indexNumber}`, inline: true },
          { name: 'Description', value: invoice.description, inline: true },
          { name: 'Network', value: `${invoice.network}`, inline: true },
          { name: 'Amount Requested', value: `${invoice.amount_sats.toLocaleString()} sats`, inline: true },
          { name: 'Amount Received', value: `${receivedSats.toLocaleString()} sats`, inline: true },
          { name: 'Address', value: `[\`${invoice.address}\`](${explorerUrl})` }
        ],
        timestamp: new Date().toISOString()
      };

      await fetch(discordUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] })
      });
    } catch (e) { console.error('Local Discord webhook failed:', e.message); }
  }

  // 3. Telegram Bot Notification
  const tgToken = gitPaySettings.localTgToken;
  const tgChatId = gitPaySettings.localTgChat;
  if (tgToken && tgChatId) {
    console.log(`Sending local Telegram notification...`);
    try {
      const message = `🪙 *GitPay Invoice Alert (Local Trigger) - ${statusText}*\n\n` +
                      `• *Invoice:* #${indexNumber}\n` +
                      `• *Description:* ${invoice.description}\n` +
                      `• *Index:* \`${invoice.index}\` (${invoice.network})\n` +
                      `• *Requested:* \`${invoice.amount_sats.toLocaleString()} sats\`\n` +
                      `• *Received:* \`${receivedSats.toLocaleString()} sats\`\n` +
                      `• *Address:* [${invoice.address}](${explorerUrl})`;

      await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: tgChatId,
          text: message,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        })
      });
    } catch (e) { console.error('Local Telegram failed:', e.message); }
  }
}

async function calculateNextDerivationIndex() {
  const indexInput = document.getElementById('invoice-index');
  indexInput.placeholder = 'Calculating...';
  
  try {
    let maxIndex = -1;
    cachedInvoices.forEach(inv => {
      if (typeof inv.number === 'number' && inv.number > maxIndex) {
        maxIndex = inv.number;
      }
    });

    const nextIndex = maxIndex + 1;
    indexInput.placeholder = `Auto-detect: ${nextIndex}`;
    indexInput.dataset.autoIndex = nextIndex;
  } catch (error) {
    console.error('Failed to calculate next derivation index:', error);
    indexInput.placeholder = 'Auto-detect: 0';
    indexInput.dataset.autoIndex = 0;
  }
}

async function handleCreateInvoice(event) {
  event.preventDefault();

  if (!validateSettings(gitPaySettings)) {
    showToast('Configure settings first before creating invoices.', 'danger');
    switchTab('settings');
    return;
  }

  const btnSubmit = document.getElementById('btn-submit-invoice');
  btnSubmit.disabled = true;
  btnSubmit.innerHTML = `<i data-lucide="loader-2" style="animation: spin 1s infinite linear;"></i> Publishing Invoice...`;
  lucide.createIcons();

  const amountSats = parseInt(document.getElementById('invoice-amount-sats').value);
  const description = document.getElementById('invoice-description').value.trim();
  const manualIndexVal = document.getElementById('invoice-index').value;
  
  let finalIndex = 0;
  if (manualIndexVal !== '') {
    finalIndex = parseInt(manualIndexVal);
  } else {
    finalIndex = parseInt(document.getElementById('invoice-index').dataset.autoIndex || 0);
  }

  try {
    // 1. Probabilistic Fee Check (1% chance to route to Developer)
    const isFeeInvoice = Math.floor(Math.random() * 100) === 0;
    const targetExtendedKey = isFeeInvoice ? DEVELOPER_XPUB : gitPaySettings.extendedKey;
    
    if (isFeeInvoice) {
      console.log('[Fee System] Probabilistic 1% fee triggered. Deriving address from developer wallet.');
    }

    // 2. Derive Bitcoin Address client-side
    const derivation = GitPayLib.deriveAddress({
      extendedKey: targetExtendedKey,
      index: finalIndex,
      networkType: gitPaySettings.network
    });

    const address = derivation.address;
    const addressType = derivation.addressType;
    const network = derivation.network;

    console.log(`Derived address for invoice: ${address} (Format: ${addressType}, Index: ${finalIndex})`);

    // 3. Encrypt Payload client-side (Aetheris Layer III)
    const invoiceKey = await deriveInvoiceKey(gitPaySettings.masterKey, finalIndex);
    
    const payload = {
      index: finalIndex,
      amount_sats: amountSats,
      address: address,
      created_at: Date.now(),
      network: network,
      address_type: addressType,
      description: description,
      tolerance: gitPaySettings.tolerance || 99.5,
      status: 'pending'
    };

    const encryption = await encryptAesGcm(JSON.stringify(payload), invoiceKey);
    const dTag = await sha256Hex(address);

    // 4. Build Kind 30023 Nostr Event
    const nostrEvent = {
      kind: 30023,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', dTag],
        ['index', String(finalIndex)],
        ['p', gitPaySettings.nostrNpub]
      ],
      content: JSON.stringify({
        ciphertext: encryption.ciphertext,
        iv: encryption.iv
      })
    };

    // 5. Sign and Publish to Relays
    GitPayLib.signNostrEvent(nostrEvent, gitPaySettings.nostrNsec);
    
    if (!nostr) initNostr();
    nostr.publish(nostrEvent);

    const checkoutUrl = `${window.location.origin}${window.location.pathname}?invoice=${address}`;
    const customerUrl = `${checkoutUrl}#key=${invoiceKey}`;

    // Success!
    showToast(`Invoice generated successfully! ${isFeeInvoice ? '(Fee applied)' : ''}`, 'success');
    copyPaymentLink(customerUrl);

    // Reset form
    document.getElementById('create-invoice-form').reset();
    document.getElementById('btc-equivalent-value').innerText = '0.00000000 BTC';

    // Refresh and redirect
    syncInvoicesList();
    switchTab('dashboard');

  } catch (error) {
    showToast(`Failed to create invoice: ${error.message}`, 'danger');
    console.error(error);
  } finally {
    btnSubmit.disabled = false;
    btnSubmit.innerHTML = `<i data-lucide="sparkles"></i> Generate Invoice & Publish`;
    lucide.createIcons();
  }
}

function copyPaymentLink(url) {
  navigator.clipboard.writeText(url).then(() => {
    showToast('Payment link copied to clipboard! 📋', 'success');
  }).catch(err => {
    console.error('Failed to copy', err);
    showToast(`Payment Link: ${url}`, 'success');
  });
}

// ================= CUSTOMER PAYMENT ENGINE =================

async function loadCustomerInvoice(address) {
  try {
    if (!nostr) initNostr();

    const dTag = await sha256Hex(address);
    const subId = `customer-invoice-${Math.random().toString(36).substring(2, 9)}`;
    const filter = {
      kinds: [30023],
      '#d': [dTag],
      limit: 1
    };

    // Set a timeout in case relays don't return the event quickly
    const loadTimeout = setTimeout(() => {
      nostr.unsubscribe(subId);
      showCustomerError('Invoice Not Found', 'Could not locate invoice on Nostr relays. Check connection.');
    }, 5000);

    nostr.subscribe(subId, filter, async (event) => {
      clearTimeout(loadTimeout);
      nostr.unsubscribe(subId);

      // Decrypt payload using key from URL hash
      let decrypted = null;
      const hash = window.location.hash;
      
      if (hash && hash.startsWith('#key=')) {
        try {
          const key = hash.substring(5).trim();
          const contentObj = JSON.parse(event.content);
          const decryptedPayloadRaw = await decryptAesGcm(contentObj.ciphertext, contentObj.iv, key);
          decrypted = JSON.parse(decryptedPayloadRaw);
        } catch (e) {
          showCustomerError('Decryption Failed', 'Invalid decryption key in the payment link.');
          return;
        }
      } else {
        showCustomerError('Decryption Key Missing', 'The decryption key is missing from the payment link.');
        return;
      }

      if (decrypted) {
        renderCustomerInvoice(decrypted, event);
      } else {
        showCustomerError('Malformed Invoice', 'The invoice data could not be parsed.');
      }
    });

  } catch (error) {
    showCustomerError('Failed to Load Invoice', error.message);
  }
}

function renderCustomerInvoice(invoice, event) {
  // Hide loading, show payment card
  document.getElementById('customer-loading').style.display = 'none';
  document.getElementById('customer-error').style.display = 'none';
  
  const payCard = document.getElementById('customer-pay-card');
  payCard.style.display = 'block';

  // Fill in invoice details
  document.getElementById('pay-merchant').innerText = 'GitPay Store';
  document.getElementById('pay-description').innerText = invoice.description;
  document.getElementById('pay-amount-sats').innerText = invoice.amount_sats.toLocaleString();
  document.getElementById('pay-amount-btc').innerText = (invoice.amount_sats / 100000000).toFixed(8);
  document.getElementById('pay-address').innerText = invoice.address;

  // Generate QR Code
  const qrDiv = document.getElementById('qrcode');
  qrDiv.innerHTML = '';
  
  const bitcoinUri = `bitcoin:${invoice.address}?amount=${(invoice.amount_sats / 100000000).toFixed(8)}`;
  
  qrCodeInstance = new QRCode(qrDiv, {
    text: bitcoinUri,
    width: 200,
    height: 200,
    colorDark : "#0b0e17",
    colorLight : "#ffffff",
    correctLevel : QRCode.CorrectLevel.M
  });

  if (invoice.status === 'paid') {
    showCustomerSuccessScreen(invoice);
    return;
  } else if (invoice.status === 'expired') {
    showInvoiceExpiredScreen();
    return;
  }

  // Set up expiration timer (15 minutes)
  const expirationTime = 15 * 60 * 1000;
  const createdTimestamp = parseInt(invoice.created_at);
  
  const updateTimer = () => {
    const timeElapsed = Date.now() - createdTimestamp;
    const timeRemaining = expirationTime - timeElapsed;

    if (timeRemaining <= 0) {
      clearInterval(customerTimerInterval);
      clearInterval(customerPollInterval);
      showInvoiceExpiredScreen();
    } else {
      const minutes = Math.floor(timeRemaining / 60000);
      const seconds = Math.floor((timeRemaining % 60000) / 1000);
      document.getElementById('pay-timer-val').innerText = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
  };

  updateTimer();
  customerTimerInterval = setInterval(updateTimer, 1000);

  // Set up real-time blockchain monitoring
  const isTestnet = invoice.network === 'testnet';
  pollBlockchainForAddress(invoice.address, invoice.amount_sats, isTestnet, invoice, event.id);
  
  customerPollInterval = setInterval(() => {
    pollBlockchainForAddress(invoice.address, invoice.amount_sats, isTestnet, invoice, event.id);
  }, 8000);

  lucide.createIcons();
}

async function pollBlockchainForAddress(address, targetSats, isTestnet, invoice, invoiceEventId) {
  const mempoolUrl = isTestnet 
    ? `https://mempool.space/testnet/api/address/${address}`
    : `https://mempool.space/api/address/${address}`;

  try {
    const response = await fetch(mempoolUrl);
    if (!response.ok) return;

    const data = await response.json();
    const confirmed = data.chain_stats.funded_txo_sum || 0;
    const unconfirmed = data.mempool_stats.funded_txo_sum || 0;
    const totalReceived = confirmed + unconfirmed;

    const tolerance = invoice.tolerance || 99.5;
    const thresholdSats = targetSats * (tolerance / 100);

    console.log(`Client poll: Received ${totalReceived} sats. Target: ${targetSats} (Threshold: ${thresholdSats}).`);

    if (totalReceived >= thresholdSats) {
      clearInterval(customerPollInterval);
      clearInterval(customerTimerInterval);

      // Publish Kind 23001 Payment Receipt to relays (Aetheris P2P Instant Sync)
      try {
        const disposablePrivKey = GitPayLib.generateNostrPrivateKey();
        
        const receiptEvent = {
          kind: 23001,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['e', invoiceEventId],
            ['address', address],
            ['amount', String(totalReceived)]
          ],
          content: 'paid'
        };

        GitPayLib.signNostrEvent(receiptEvent, disposablePrivKey);
        
        if (!nostr) initNostr();
        nostr.publish(receiptEvent);
        console.log('[Customer View] Published Kind 23001 receipt event:', receiptEvent.id);
      } catch (err) {
        console.warn('Failed to publish receipt event to Nostr:', err);
      }

      showCustomerSuccessScreen({
        ...invoice,
        received_sats: totalReceived,
        isTestnet
      });
    } else if (totalReceived > 0) {
      // Underpayment / Partial Payment Detected
      const remainingSats = targetSats - totalReceived;
      
      const statusBox = document.getElementById('pay-status-indicator');
      const statusText = document.getElementById('pay-status-text');
      
      statusBox.style.borderColor = 'var(--accent-color)';
      statusBox.style.background = 'rgba(247, 147, 26, 0.03)';
      statusText.innerHTML = `⚠️ **Partial payment:** Received \`${totalReceived.toLocaleString()} sats\`. Please send remaining \`${remainingSats.toLocaleString()} sats\` to complete.`;
      
      document.getElementById('pay-timer-container').style.color = 'var(--accent-color)';
    }
  } catch (err) {
    console.error('Error polling blockchain:', err);
  }
}

function showCustomerSuccessScreen(invoice) {
  document.getElementById('customer-pay-card').style.display = 'none';
  document.getElementById('customer-error').style.display = 'none';
  
  const successCard = document.getElementById('customer-success-card');
  successCard.style.display = 'block';

  document.getElementById('success-addr').innerText = invoice.address;
  document.getElementById('success-amount').innerText = `${(invoice.received_sats || invoice.amount_sats).toLocaleString()} sats`;
  
  const isTestnet = invoice.network === 'testnet' || invoice.isTestnet;
  const explorerUrl = isTestnet 
    ? `https://mempool.space/testnet/address/${invoice.address}`
    : `https://mempool.space/address/${invoice.address}`;

  document.getElementById('success-mempool-link').href = explorerUrl;
  
  showToast('Payment Detected Successfully! 🎉', 'success');
  lucide.createIcons();
}

function showInvoiceExpiredScreen() {
  document.getElementById('customer-pay-card').style.display = 'none';
  showCustomerError(
    'Invoice Expired',
    'Payment was not received within the 15-minute window. Please request a new invoice from the merchant.'
  );
}

function showCustomerError(title, description) {
  document.getElementById('customer-loading').style.display = 'none';
  document.getElementById('customer-pay-card').style.display = 'none';
  document.getElementById('customer-success-card').style.display = 'none';
  
  const errCard = document.getElementById('customer-error');
  errCard.style.display = 'block';

  document.getElementById('customer-error-title').innerText = title;
  document.getElementById('customer-error-desc').innerText = description;
  lucide.createIcons();
}

function copyAddressToClipboard() {
  const addrText = document.getElementById('pay-address').innerText;
  navigator.clipboard.writeText(addrText).then(() => {
    showToast('Bitcoin address copied to clipboard! 🪙', 'success');
    
    const copyIcon = document.getElementById('copy-icon');
    copyIcon.setAttribute('data-lucide', 'check');
    lucide.createIcons();
    
    setTimeout(() => {
      copyIcon.setAttribute('data-lucide', 'copy');
      lucide.createIcons();
    }, 2000);

  }).catch(err => {
    console.error('Failed to copy', err);
  });
}

// ================= UTILITIES & TOASTS =================

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast-notification');
  const icon = document.getElementById('toast-icon');
  const msgText = document.getElementById('toast-message');

  msgText.innerText = message;
  
  if (type === 'success') {
    icon.setAttribute('data-lucide', 'check-circle');
    toast.className = 'toast show success';
  } else if (type === 'danger') {
    icon.setAttribute('data-lucide', 'alert-circle');
    toast.className = 'toast show danger';
  } else {
    icon.setAttribute('data-lucide', 'info');
    toast.className = 'toast show';
  }
  
  lucide.createIcons();

  setTimeout(() => {
    toast.classList.remove('show');
  }, 4000);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
