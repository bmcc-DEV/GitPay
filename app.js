// Global State Variables
let gitPaySettings = {
  ghToken: '',
  ghRepo: '',
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

let btcPrice = 0.0;
let qrCodeInstance = null;
let customerPollInterval = null;
let customerTimerInterval = null;
let cachedIssues = [];

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  // Initialize Lucide Icons
  lucide.createIcons();
  
  // Load settings from localStorage
  loadSettings();

  // Check URL parameters for customer invoice view
  const urlParams = new URLSearchParams(window.location.search);
  const invoiceId = urlParams.get('invoice');

  if (invoiceId) {
    // Customer Payment Mode
    setupCustomerView();
    loadCustomerInvoice(invoiceId);
  } else {
    // Merchant Dashboard Mode
    setupMerchantView();
  }
});

// ================= CRYPTOGRAPHY HELPERS (AES-GCM WebCrypto) =================

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

// Derives a determinist key for an invoice based on merchant masterKey and invoice index
async function deriveInvoiceKey(masterKeyHex, index) {
  return await sha256Hex(`${masterKeyHex}-${index}`);
}

async function encryptAesGcm(text, hexKey) {
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
    syncInvoicesList();
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
    syncInvoicesList();
  } else if (tabName === 'create') {
    fetchBtcPrice();
    calculateNextDerivationIndex();
  }
}

// ================= SETTINGS MANAGEMENT =================

function loadSettings() {
  const saved = localStorage.getItem('gitpay_settings');
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
    localStorage.setItem('gitpay_settings', JSON.stringify(gitPaySettings));
  }
  if (!gitPaySettings.tolerance) {
    gitPaySettings.tolerance = 99.5;
  }

  // Populate form fields
  document.getElementById('setting-gh-token').value = gitPaySettings.ghToken || '';
  document.getElementById('setting-gh-repo').value = gitPaySettings.ghRepo || '';
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
}

function handleSaveSettings(event) {
  event.preventDefault();

  const token = document.getElementById('setting-gh-token').value.trim();
  const repo = document.getElementById('setting-gh-repo').value.trim();
  const xkey = document.getElementById('setting-extended-key').value.trim();
  const net = document.getElementById('setting-network').value;
  const fiat = document.getElementById('setting-fiat-currency').value;
  const masterKey = document.getElementById('setting-master-key').value.trim();
  const tolerance = parseFloat(document.getElementById('setting-tolerance').value);
  const localWebhook = document.getElementById('setting-local-webhook').value.trim();
  const localDiscord = document.getElementById('setting-local-discord').value.trim();
  const localTgToken = document.getElementById('setting-local-tg-token').value.trim();
  const localTgChat = document.getElementById('setting-local-tg-chat').value.trim();

  if (!repo.includes('/')) {
    showToast('Error: Repository path must be in "owner/repo" format.', 'danger');
    return;
  }

  if (masterKey.length !== 64) {
    showToast('Error: Master Key must be exactly 64 hex characters (32 bytes).', 'danger');
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
    ghToken: token,
    ghRepo: repo,
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

  localStorage.setItem('gitpay_settings', JSON.stringify(gitPaySettings));
  updateFiatSymbol(fiat);

  document.getElementById('setup-warning-card').style.display = 'none';
  showToast('Settings saved & key validated! ✅', 'success');

  fetchBtcPrice();
  switchTab('dashboard');
}

function triggerGenerateNewMasterKey() {
  if (confirm('Warning: Generating a new Master Key will make it impossible to decrypt description of invoices created with the previous key. Are you sure?')) {
    document.getElementById('setting-master-key').value = generateRandomHex(32);
    showToast('New Master Encryption Key generated. Click Save to apply.', 'info');
  }
}

function validateSettings(settings) {
  return settings.ghToken && settings.ghRepo && settings.extendedKey;
}

function updateFiatSymbol(currency) {
  const symbols = { 'USD': '$', 'BRL': 'R$', 'EUR': '€', 'GBP': '£' };
  document.getElementById('fiat-symbol-icon').innerText = symbols[currency] || '$';
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

// ================= INVOICE GENERATOR & GITHUB =================

async function fetchGitHubIssues() {
  if (!validateSettings(gitPaySettings)) return [];

  const [owner, repo] = gitPaySettings.ghRepo.split('/');
  const token = gitPaySettings.ghToken;

  const url = `https://api.github.com/repos/${owner}/${repo}/issues?labels=invoice&state=all&per_page=100`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub API returned status ${response.status}: ${response.statusText}`);
  }

  return await response.json();
}

async function syncInvoicesList() {
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
        Syncing with GitHub ledger...
      </td>
    </tr>
  `;
  lucide.createIcons();

  try {
    cachedIssues = await fetchGitHubIssues();
    await renderInvoicesTable(cachedIssues);
    updateDashboardStats(cachedIssues);
    
    // Kick off automatic local blockchain checks (Mitigates Action Cron Delay)
    triggerLocalBlockchainCheck(cachedIssues);
  } catch (error) {
    showToast(`Sync Error: ${error.message}`, 'danger');
    tableBody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center" style="color: var(--danger-color); padding: 2rem;">
          <i data-lucide="x-circle" style="margin-bottom: 0.5rem; display: block; margin-left: auto; margin-right: auto;"></i>
          Failed to sync invoices. Verify your GitHub Token and Repository path.
        </td>
      </tr>
    `;
    lucide.createIcons();
  }
}

async function renderInvoicesTable(issues) {
  const tableBody = document.getElementById('invoices-list-body');
  
  if (issues.length === 0) {
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
  for (const issue of issues) {
    let invoiceData = {};
    try {
      const jsonMatch = issue.body.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        invoiceData = JSON.parse(jsonMatch[1].trim());
      }
    } catch (e) {
      console.warn(`Could not parse JSON from issue #${issue.number}`, e);
    }

    let description = invoiceData.description || 'Bitcoin Payment';
    
    // Decrypt description if encrypted data exists
    if (invoiceData.encrypted_desc && invoiceData.iv) {
      if (gitPaySettings.masterKey) {
        // Derive invoice key deterministically
        const key = await deriveInvoiceKey(gitPaySettings.masterKey, invoiceData.index);
        description = await decryptAesGcm(invoiceData.encrypted_desc, invoiceData.iv, key);
      } else {
        description = '[🔒 Encrypted Description - Key Required]';
      }
    }

    const address = invoiceData.address || 'Unknown';
    const amount = invoiceData.amount_sats || 0;
    const createdAt = invoiceData.created_at ? new Date(invoiceData.created_at).toLocaleString() : 'N/A';
    
    // Determine status badge
    let statusBadge = '<span class="badge badge-pending">Pending</span>';
    const labels = issue.labels.map(l => typeof l === 'object' ? l.name : l);
    
    if (labels.includes('paid')) {
      statusBadge = '<span class="badge badge-paid">Paid</span>';
    } else if (labels.includes('expired')) {
      statusBadge = '<span class="badge badge-expired">Expired</span>';
    } else if (labels.includes('invalid')) {
      statusBadge = '<span class="badge badge-invalid">Invalid</span>';
    }

    const checkoutUrl = `${window.location.origin}${window.location.pathname}?invoice=${issue.number}`;
    
    // Append derived key for customer if encrypted
    let customerUrl = checkoutUrl;
    if (invoiceData.encrypted_desc && gitPaySettings.masterKey) {
      const key = await deriveInvoiceKey(gitPaySettings.masterKey, invoiceData.index);
      customerUrl += `#key=${key}`;
    }

    html += `
      <tr id="invoice-row-${issue.number}">
        <td class="nowrap"><strong>#${issue.number}</strong></td>
        <td>${escapeHtml(description)}</td>
        <td class="nowrap" style="font-family: monospace; font-size: 0.8rem;" title="${address}">
          ${address.substring(0, 8)}...${address.substring(address.length - 8)}
        </td>
        <td class="text-right nowrap" style="font-family: monospace; font-weight: 600;">
          ${amount.toLocaleString()}
        </td>
        <td class="text-center nowrap" id="invoice-status-cell-${issue.number}">${statusBadge}</td>
        <td class="nowrap" style="font-size: 0.8rem; color: var(--text-secondary);">${createdAt}</td>
        <td class="text-center nowrap">
          <button class="btn" style="padding: 0.35rem 0.65rem; font-size: 0.8rem;" onclick="copyPaymentLink('${customerUrl}')" title="Copy Customer Payment Link">
            <i data-lucide="link" style="width: 14px; height: 14px;"></i> Copy Link
          </button>
        </td>
      </tr>
    `;
  }

  tableBody.innerHTML = html;
  lucide.createIcons();
}

function updateDashboardStats(issues) {
  let paid = 0;
  let pending = 0;
  let expired = 0;

  issues.forEach(issue => {
    const labels = issue.labels.map(l => typeof l === 'object' ? l.name : l);
    if (labels.includes('paid')) paid++;
    else if (labels.includes('pending') && issue.state === 'open') pending++;
    else if (labels.includes('expired')) expired++;
  });

  document.getElementById('stat-paid-count').innerText = paid;
  document.getElementById('stat-pending-count').innerText = pending;
  document.getElementById('stat-expired-count').innerText = expired;
}

// Mitigate Cron Delay: Scans pending invoices locally from merchant browser
// and updates the ledger on GitHub immediately if a payment is detected.
async function triggerLocalBlockchainCheck(issues) {
  const pendingIssues = issues.filter(issue => {
    const labels = issue.labels.map(l => typeof l === 'object' ? l.name : l);
    return labels.includes('pending') && issue.state === 'open';
  });

  for (const issue of pendingIssues) {
    let invoiceData = {};
    try {
      const jsonMatch = issue.body.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        invoiceData = JSON.parse(jsonMatch[1].trim());
      }
    } catch (e) {
      continue;
    }

    if (!invoiceData.address || !invoiceData.amount_sats) continue;

    const isTestnet = invoiceData.network === 'testnet';
    const mempoolUrl = isTestnet 
      ? `https://mempool.space/testnet/api/address/${invoiceData.address}`
      : `https://mempool.space/api/address/${invoiceData.address}`;

    try {
      const response = await fetch(mempoolUrl);
      if (!response.ok) continue;

      const data = await response.json();
      const confirmed = data.chain_stats.funded_txo_sum || 0;
      const unconfirmed = data.mempool_stats.funded_txo_sum || 0;
      const totalReceived = confirmed + unconfirmed;

      const targetSats = invoiceData.amount_sats;
      const tolerance = gitPaySettings.tolerance || 99.5;
      const thresholdSats = targetSats * (tolerance / 100);

      if (totalReceived >= thresholdSats) {
        console.log(`Local detection: Invoice #${issue.number} has been paid on-chain! Updating ledger...`);
        
        // Visual indicator in table
        const statusCell = document.getElementById(`invoice-status-cell-${issue.number}`);
        if (statusCell) {
          statusCell.innerHTML = `<span class="badge badge-paid" style="animation: pulse 1s infinite;"><i data-lucide="loader-2" style="animation: spin 1s infinite linear; width: 12px; height: 12px;"></i> Saving...</span>`;
          lucide.createIcons();
        }

        // Push confirmation to GitHub using Merchant's PAT
        await confirmPaymentOnGitHub(issue.number, invoiceData, totalReceived, confirmed >= thresholdSats);
      }
    } catch (err) {
      console.error(`Failed local ledger check for issue #${issue.number}:`, err);
    }
  }
}

async function confirmPaymentOnGitHub(issueNumber, invoice, receivedSats, isFullyConfirmed) {
  const [owner, repo] = gitPaySettings.ghRepo.split('/');
  const token = gitPaySettings.ghToken;
  const isTestnet = invoice.network === 'testnet';

  const confirmMsg = isFullyConfirmed 
    ? `✅ Payment confirmed on-chain!` 
    : `⏳ Payment detected in the mempool! (0/1 confirmations)`;

  try {
    // 1. Create a comment
    await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json'
      },
      body: JSON.stringify({
        body: `### 🎉 Payment Detected (Auto-Sync via Merchant Dashboard)\n\n- **Received:** \`${receivedSats} sats\`\n- **Status:** ${confirmMsg}\n- **Transaction History:** [View on Mempool.space](${isTestnet ? 'https://mempool.space/testnet' : 'https://mempool.space'}/address/${invoice.address})`
      })
    });

    // 2. Update labels and close the issue
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json'
      },
      body: JSON.stringify({
        labels: ['paid', 'invoice'],
        state: 'closed'
      })
    });

    if (response.ok) {
      console.log(`Successfully synced paid invoice #${issueNumber} to GitHub.`);
      showToast(`Invoice #${issueNumber} marked as Paid & closed!`, 'success');
      
      // Update local state without full reload
      const statusCell = document.getElementById(`invoice-status-cell-${issueNumber}`);
      if (statusCell) {
        statusCell.innerHTML = `<span class="badge badge-paid">Paid</span>`;
      }
      
      // Update stats
      const paidEl = document.getElementById('stat-paid-count');
      const pendingEl = document.getElementById('stat-pending-count');
      if (paidEl && pendingEl) {
        paidEl.innerText = parseInt(paidEl.innerText) + 1;
        pendingEl.innerText = Math.max(0, parseInt(pendingEl.innerText) - 1);
      }

      // Dispatch local notifications directly from the browser!
      await sendLocalNotifications('invoice.paid', issueNumber, invoice, receivedSats);
    }
  } catch (error) {
    console.error(`Error updating GitHub ledger for paid invoice #${issueNumber}:`, error);
  }
}

async function sendLocalNotifications(event, issueNumber, invoice, receivedSats = 0) {
  const [owner, repo] = gitPaySettings.ghRepo.split('/');
  const isTestnet = invoice.network === 'testnet';
  const explorerUrl = isTestnet 
    ? `https://mempool.space/testnet/address/${invoice.address}`
    : `https://mempool.space/address/${invoice.address}`;
  
  const issueUrl = `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
  const statusText = event === 'invoice.paid' ? 'PAID ✅' : 'EXPIRED ⏰';
  const color = event === 'invoice.paid' ? 1095553 : 15680572; // Hex: 0x10b981 (green) vs 0xef4444 (red)

  // Decrypt description if encrypted
  let description = invoice.description || 'Bitcoin Payment';
  if (invoice.encrypted_desc && invoice.iv && gitPaySettings.masterKey) {
    try {
      const key = await deriveInvoiceKey(gitPaySettings.masterKey, invoice.index);
      description = await decryptAesGcm(invoice.encrypted_desc, invoice.iv, key);
    } catch(e) {}
  }

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
          repository: `${owner}/${repo}`,
          issue_number: issueNumber,
          invoice: {
            ...invoice,
            description,
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
          { name: 'Invoice', value: `[#${issueNumber}](${issueUrl})`, inline: true },
          { name: 'Description', value: description, inline: true },
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
                      `• *Invoice:* [#${issueNumber}](${issueUrl})\n` +
                      `• *Description:* ${description}\n` +
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
    let issues = cachedIssues;
    if (issues.length === 0) {
      issues = await fetchGitHubIssues();
    }

    let maxIndex = -1;
    issues.forEach(issue => {
      try {
        const jsonMatch = issue.body.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          const invoice = JSON.parse(jsonMatch[1].trim());
          if (typeof invoice.index === 'number' && invoice.index > maxIndex) {
            maxIndex = invoice.index;
          }
        }
      } catch (e) {}
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
    // 1. Derive Bitcoin Address client-side
    const derivation = GitPayLib.deriveAddress({
      extendedKey: gitPaySettings.extendedKey,
      index: finalIndex,
      networkType: gitPaySettings.network
    });

    const address = derivation.address;
    const addressType = derivation.addressType;
    const network = derivation.network;

    console.log(`Derived address for invoice: ${address} (Format: ${addressType}, Index: ${finalIndex})`);

    // 2. Encrypt Description client-side
    const invoiceKey = await deriveInvoiceKey(gitPaySettings.masterKey, finalIndex);
    const encryption = await encryptAesGcm(description, invoiceKey);

    const createdAt = Date.now();
    const formattedDate = new Date(createdAt).toUTCString();
    
    const issueBody = `### 🪙 GitPay Invoice Details

- **Description:** [🔒 Encrypted description. View using the payment link or Dashboard]
- **Bitcoin Address:** \`${address}\`
- **Amount:** \`${amountSats.toLocaleString()} sats\` (~ ${(amountSats / 100000000).toFixed(8)} BTC)
- **Derivation Index:** \`${finalIndex}\` (Path: \`${derivation.derivationPath}\` using \`${derivation.originalPrefix}\` xpub format)
- **Network:** \`${network}\`
- **Status:** Pending payment ⌛
- **Created At:** ${formattedDate}

---

### ⚙️ Raw Invoice Data
Please do not edit the block below. The poller script reads this JSON payload to verify payments.

\`\`\`json
{
  "amount_sats": ${amountSats},
  "address": "${address}",
  "index": ${finalIndex},
  "created_at": ${createdAt},
  "network": "${network}",
  "address_type": "${addressType}",
  "encrypted_desc": "${encryption.ciphertext}",
  "iv": "${encryption.iv}",
  "tolerance": ${gitPaySettings.tolerance || 99.5}
}
\`\`\`
`;

    // 3. Post to GitHub API
    const [owner, repo] = gitPaySettings.ghRepo.split('/');
    const token = gitPaySettings.ghToken;

    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json'
      },
      body: JSON.stringify({
        title: `Invoice #${finalIndex} - ${amountSats} sats`,
        body: issueBody,
        labels: ['pending', 'invoice']
      })
    });

    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`);
    }

    const issue = await response.json();
    const checkoutUrl = `${window.location.origin}${window.location.pathname}?invoice=${issue.number}`;
    const customerUrl = `${checkoutUrl}#key=${invoiceKey}`;

    // Success!
    showToast(`Invoice #${issue.number} generated successfully!`, 'success');
    
    // Copy the payment link (with secret decrypt key in URL fragment) to clipboard
    copyPaymentLink(customerUrl);

    // Reset form
    document.getElementById('create-invoice-form').reset();
    document.getElementById('btc-equivalent-value').innerText = '0.00000000 BTC';

    // Refresh dashboard and redirect
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

async function loadCustomerInvoice(issueNumber) {
  let ownerRepo = gitPaySettings.ghRepo;
  
  if (!ownerRepo) {
    // Auto-detect from GitHub Pages URL structure
    const hostname = window.location.hostname;
    if (hostname.endsWith('.github.io')) {
      const owner = hostname.split('.')[0];
      const pathParts = window.location.pathname.split('/').filter(p => p !== '');
      const repo = pathParts[0] || 'gitpay';
      ownerRepo = `${owner}/${repo}`;
      console.log(`Auto-detected repository: ${ownerRepo}`);
    } else {
      const urlParams = new URLSearchParams(window.location.search);
      ownerRepo = urlParams.get('repo');
    }
  }

  if (!ownerRepo) {
    showCustomerError(
      'Gateway Configuration Missing',
      'This payment processor is not properly configured. If you are the merchant, configure the repository in Settings first.'
    );
    return;
  }

  const [owner, repo] = ownerRepo.split('/');
  
  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('The requested invoice does not exist or the repository is private.');
      }
      throw new Error(`GitHub API returned status ${response.status}`);
    }

    const issue = await response.json();
    
    // Parse invoice JSON
    const jsonMatch = issue.body.match(/```json\s*([\s\S]*?)\s*```/);
    if (!jsonMatch) {
      throw new Error('Invoice data block is missing or corrupted.');
    }

    const invoice = JSON.parse(jsonMatch[1].trim());
    
    if (!invoice.address || !invoice.amount_sats || !invoice.created_at) {
      throw new Error('Required fields are missing in the invoice registry.');
    }

    // Attempt to decrypt description using key from URL Hash/Fragment
    let decryptedDesc = 'Bitcoin Payment';
    const hash = window.location.hash;
    
    if (invoice.encrypted_desc && invoice.iv) {
      if (hash && hash.startsWith('#key=')) {
        const key = hash.substring(5).trim();
        decryptedDesc = await decryptAesGcm(invoice.encrypted_desc, invoice.iv, key);
      } else {
        decryptedDesc = '[🔒 Encrypted description. Decryption key missing from URL]';
      }
    } else {
      decryptedDesc = invoice.description || 'Payment Request';
    }

    invoice.description = decryptedDesc;
    renderCustomerInvoice(invoice, issue, owner);

  } catch (error) {
    showCustomerError('Failed to Load Invoice', error.message);
  }
}

function renderCustomerInvoice(invoice, issue, merchantName) {
  // Hide loading, show payment card
  document.getElementById('customer-loading').style.display = 'none';
  document.getElementById('customer-error').style.display = 'none';
  
  const payCard = document.getElementById('customer-pay-card');
  payCard.style.display = 'block';

  // Fill in invoice details
  document.getElementById('pay-merchant').innerText = merchantName;
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

  // Verify status from GitHub Issue Labels
  const labels = issue.labels.map(l => typeof l === 'object' ? l.name : l);
  
  if (labels.includes('paid')) {
    showCustomerSuccessScreen(invoice);
    return;
  } else if (labels.includes('expired')) {
    showInvoiceExpiredScreen();
    return;
  } else if (labels.includes('invalid')) {
    showCustomerError('Invoice Suspended', 'This invoice has been flagged as invalid by the administrator.');
    return;
  }

  // Set up expiration timer
  const expirationTime = 15 * 60 * 1000; // 15 minutes
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
  pollBlockchainForAddress(invoice.address, invoice.amount_sats, isTestnet, invoice);
  
  customerPollInterval = setInterval(() => {
    pollBlockchainForAddress(invoice.address, invoice.amount_sats, isTestnet, invoice);
  }, 8000);

  lucide.createIcons();
}

async function pollBlockchainForAddress(address, targetSats, isTestnet, invoice) {
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

    // Retrieve settings tolerance (fallback to 99.5% if not configured)
    const tolerance = gitPaySettings.tolerance || 99.5;
    const thresholdSats = targetSats * (tolerance / 100);

    console.log(`Client poll: Received ${totalReceived} sats. Target: ${targetSats} sats (Threshold: ${thresholdSats}).`);

    if (totalReceived >= thresholdSats) {
      // Payment successful (either exact or within tolerance)
      clearInterval(customerPollInterval);
      clearInterval(customerTimerInterval);

      showCustomerSuccessScreen({
        ...invoice,
        received_sats: totalReceived,
        isTestnet
      });
    } else if (totalReceived > 0) {
      // Underpayment / Partial Payment Detected!
      const remainingSats = targetSats - totalReceived;
      
      const statusBox = document.getElementById('pay-status-indicator');
      const statusText = document.getElementById('pay-status-text');
      
      statusBox.style.borderColor = 'var(--accent-color)';
      statusBox.style.background = 'rgba(247, 147, 26, 0.03)';
      statusText.innerHTML = `⚠️ **Partial payment:** Received \`${totalReceived.toLocaleString()} sats\`. Please send remaining \`${remainingSats.toLocaleString()} sats\` to complete.`;
      
      // Update timer container color to reflect alert state
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
