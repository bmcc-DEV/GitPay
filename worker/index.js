// Cloudflare Worker for GitPay v3.0
// Zero Server, 24/7 background check and webhook processor

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // POST /invoice - Register a new invoice for tracking
    if (url.pathname === '/invoice' && request.method === 'POST') {
      try {
        const invoice = await request.json();
        
        if (!invoice.issue_number || !invoice.address || !invoice.amount_sats) {
          return new Response(JSON.stringify({ error: 'Missing required fields' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // Store invoice in KV namespace (expiring in 2 hours to cover the 15-minute checkout window and extra buffer)
        await env.GITPAY_KV.put(
          `invoice:${invoice.issue_number}`,
          JSON.stringify({
            ...invoice,
            created_at: invoice.created_at || Date.now(),
            checks: 0
          }),
          { expirationTtl: 7200 } 
        );

        console.log(`[Worker] Invoice #${invoice.issue_number} registered in KV.`);
        
        // Run first check asynchronously
        await checkInvoice(invoice.issue_number, env);

        return new Response(JSON.stringify({ status: 'registered' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // POST /check - Force immediate check for an invoice
    if (url.pathname === '/check' && request.method === 'POST') {
      try {
        const body = await request.json();
        const issueNumber = body.issue_number;
        
        if (!issueNumber) {
          return new Response(JSON.stringify({ error: 'Missing issue_number' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        console.log(`[Worker] Direct check request received for Issue #${issueNumber}`);
        const result = await checkInvoice(issueNumber, env);

        return new Response(JSON.stringify({ status: 'check_processed', result }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // GET /health - Check if worker is live
    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'ok', time: new Date().toISOString() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  },

  // Cron scheduled task: Runs every N minutes (e.g. 5 minutes)
  async scheduled(event, env, ctx) {
    console.log('[Worker] Cron Triggered. Scanning KV for pending invoices...');
    
    // List all invoices stored in KV
    const list = await env.GITPAY_KV.list({ prefix: 'invoice:' });
    
    for (const key of list.keys) {
      const issueNumber = key.name.replace('invoice:', '');
      ctx.waitUntil(checkInvoice(issueNumber, env));
    }
  }
};

async function checkInvoice(issueNumber, env) {
  const kvKey = `invoice:${issueNumber}`;
  const data = await env.GITPAY_KV.get(kvKey);
  
  if (!data) {
    console.log(`[Worker] Invoice #${issueNumber} not found in KV (already processed or expired).`);
    return { status: 'not_found' };
  }

  const invoice = JSON.parse(data);
  const now = Date.now();
  const timeElapsed = now - invoice.created_at;
  const expiryLimit = 15 * 60 * 1000; // 15 minutes in milliseconds

  // 1. Check Expiration
  if (timeElapsed > expiryLimit) {
    console.log(`[Worker] Invoice #${issueNumber} has expired. Closing on GitHub...`);
    await markExpiredOnGitHub(issueNumber, env);
    await env.GITPAY_KV.delete(kvKey);
    await notifyExternalServices('invoice.expired', issueNumber, invoice, 0, env);
    return { status: 'expired' };
  }

  // 2. Fetch transaction state from mempool.space API
  const network = invoice.network === 'testnet' ? 'testnet/' : '';
  const mempoolUrl = `https://mempool.space/${network}api/address/${invoice.address}`;

  try {
    const mempoolRes = await fetch(mempoolUrl);
    if (!mempoolRes.ok) {
      throw new Error(`Mempool API returned status ${mempoolRes.status}`);
    }
    
    const blockData = await mempoolRes.json();
    const confirmed = blockData.chain_stats.funded_txo_sum || 0;
    const unconfirmed = blockData.mempool_stats.funded_txo_sum || 0;
    const totalReceived = confirmed + unconfirmed;

    const tolerance = invoice.tolerance || 99.5;
    const thresholdSats = invoice.amount_sats * (tolerance / 100);

    console.log(`[Worker] Issue #${issueNumber}: Address ${invoice.address} has ${totalReceived} sats. Target: ${invoice.amount_sats}. Threshold: ${thresholdSats}`);

    // 3. Paid confirmation
    if (totalReceived >= thresholdSats) {
      console.log(`[Worker] Invoice #${issueNumber} paid successfully on-chain!`);
      const isFullyConfirmed = confirmed >= thresholdSats;
      
      const updated = await confirmPaymentOnGitHub(issueNumber, invoice, totalReceived, isFullyConfirmed, env);
      if (updated) {
        await env.GITPAY_KV.delete(kvKey);
        await notifyExternalServices('invoice.paid', issueNumber, invoice, totalReceived, env);
        return { status: 'paid', received: totalReceived };
      }
    } 
    // 4. Partial Payment check
    else if (totalReceived > 0) {
      console.log(`[Worker] Partial payment of ${totalReceived} sats detected for invoice #${issueNumber}`);
      await logPartialPaymentOnGitHub(issueNumber, invoice, totalReceived, env);
      
      // Update check count and save back to KV
      invoice.checks = (invoice.checks || 0) + 1;
      invoice.last_received = totalReceived;
      await env.GITPAY_KV.put(kvKey, JSON.stringify(invoice), { expirationTtl: 7200 });
      return { status: 'partial_payment', received: totalReceived };
    }
    
    // 5. Still pending
    invoice.checks = (invoice.checks || 0) + 1;
    await env.GITPAY_KV.put(kvKey, JSON.stringify(invoice), { expirationTtl: 7200 });
    return { status: 'pending', received: totalReceived };

  } catch (err) {
    console.error(`[Worker] Error checking blockchain for Invoice #${issueNumber}:`, err.message);
    return { status: 'error', error: err.message };
  }
}

async function confirmPaymentOnGitHub(issueNumber, invoice, receivedSats, isFullyConfirmed, env) {
  const repo = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;
  
  if (!repo || !token) {
    console.error('[Worker] GITHUB_REPO or GITHUB_TOKEN environment variable is missing.');
    return false;
  }

  const isTestnet = invoice.network === 'testnet';
  const confirmMsg = isFullyConfirmed 
    ? `✅ Payment confirmed on-chain!` 
    : `⏳ Payment detected in the mempool! (0/1 confirmations)`;

  try {
    // 1. Post a confirmation comment
    await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'GitPay-Worker-Poller',
        'Accept': 'application/vnd.github.v3+json'
      },
      body: JSON.stringify({
        body: `### 🎉 Payment Detected (Auto-Sync via Cloudflare Worker)\n\n- **Received:** \`${receivedSats} sats\` (Requested: \`${invoice.amount_sats} sats\`)\n- **Status:** ${confirmMsg}\n- **Transaction History:** [View on Mempool.space](${isTestnet ? 'https://mempool.space/testnet' : 'https://mempool.space'}/address/${invoice.address})`
      })
    });

    // 2. Update status labels and close the Issue
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'GitPay-Worker-Poller',
        'Accept': 'application/vnd.github.v3+json'
      },
      body: JSON.stringify({
        labels: ['paid', 'invoice'],
        state: 'closed'
      })
    });

    return res.ok;
  } catch (e) {
    console.error(`[Worker] Failed to update GitHub Issue #${issueNumber}:`, e.message);
    return false;
  }
}

async function logPartialPaymentOnGitHub(issueNumber, invoice, receivedSats, env) {
  const repo = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;

  if (!repo || !token) return;

  try {
    // Scan comments to prevent duplicates
    const commentsRes = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'GitPay-Worker-Poller',
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    
    if (!commentsRes.ok) return;
    const comments = await commentsRes.json();
    
    const partialMatchStr = `Partial payment detected: ${receivedSats} sats`;
    const alreadyNotified = comments.some(c => c.body.includes(partialMatchStr));
    
    if (!alreadyNotified) {
      const isTestnet = invoice.network === 'testnet';
      const remainingSats = invoice.amount_sats - receivedSats;
      
      await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'GitPay-Worker-Poller',
          'Accept': 'application/vnd.github.v3+json'
        },
        body: JSON.stringify({
          body: `⚠️ **Partial Payment Detected (Cloudflare Worker)**\n\n- **Partial payment detected:** Received \`${receivedSats.toLocaleString()} sats\`\n- **Remaining:** \`${remainingSats.toLocaleString()} sats\` still required to complete.\n- [View on Mempool.space](${isTestnet ? 'https://mempool.space/testnet' : 'https://mempool.space'}/address/${invoice.address})`
        })
      });
    }
  } catch (e) {
    console.error(`[Worker] Failed to log partial comment for Issue #${issueNumber}:`, e.message);
  }
}

async function markExpiredOnGitHub(issueNumber, invoice, env) {
  const repo = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;
  
  if (!repo || !token) return;

  try {
    // 1. Comment on issue
    await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'GitPay-Worker-Poller',
        'Accept': 'application/vnd.github.v3+json'
      },
      body: JSON.stringify({
        body: `⏰ **Invoice Expired (Auto-Sync via Cloudflare Worker)**\n\nNo payment was detected within the 15-minute window. This invoice is now closed.`
      })
    });

    // 2. Update labels and close
    await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'GitPay-Worker-Poller',
        'Accept': 'application/vnd.github.v3+json'
      },
      body: JSON.stringify({
        labels: ['expired', 'invoice'],
        state: 'closed'
      })
    });
  } catch (e) {
    console.error(`[Worker] Failed to mark expired on GitHub for Issue #${issueNumber}:`, e.message);
  }
}

async function notifyExternalServices(event, issueNumber, invoice, receivedSats, env) {
  const isTestnet = invoice.network === 'testnet';
  const explorerUrl = isTestnet 
    ? `https://mempool.space/testnet/address/${invoice.address}`
    : `https://mempool.space/address/${invoice.address}`;
  
  const issueUrl = `https://github.com/${env.GITHUB_REPO}/issues/${issueNumber}`;
  const statusText = event === 'invoice.paid' ? 'PAID ✅' : 'EXPIRED ⏰';
  const color = event === 'invoice.paid' ? 1095553 : 15680572; // Hex: 0x10b981 (green) vs 0xef4444 (red)

  // 1. Generic HTTP Webhook (e.g. process.env.WEBHOOK_URL / env.WEBHOOK_URL)
  const webhookUrl = env.WEBHOOK_URL;
  if (webhookUrl) {
    console.log('[Worker] Triggering Webhook notification...');
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event,
          repository: env.GITHUB_REPO,
          issue_number: issueNumber,
          invoice: {
            ...invoice,
            received_sats: receivedSats,
            completed_at: Date.now()
          }
        })
      });
    } catch (e) {
      console.error('[Worker] Webhook failed:', e.message);
    }
  }

  // 2. Discord Webhook
  const discordUrl = env.DISCORD_WEBHOOK_URL;
  if (discordUrl) {
    console.log('[Worker] Triggering Discord Webhook notification...');
    try {
      const embed = {
        title: `GitPay Invoice Alert - ${statusText}`,
        color: color,
        fields: [
          { name: 'Invoice', value: `[#${issueNumber}](${issueUrl})`, inline: true },
          { name: 'Network', value: `${invoice.network}`, inline: true },
          { name: 'Requested', value: `${invoice.amount_sats.toLocaleString()} sats`, inline: true },
          { name: 'Received', value: `${receivedSats.toLocaleString()} sats`, inline: true },
          { name: 'Address', value: `[\`${invoice.address}\`](${explorerUrl})` }
        ],
        timestamp: new Date().toISOString()
      };

      await fetch(discordUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] })
      });
    } catch (e) {
      console.error('[Worker] Discord notification failed:', e.message);
    }
  }

  // 3. Telegram Webhook
  const tgToken = env.TELEGRAM_BOT_TOKEN;
  const tgChatId = env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChatId) {
    console.log('[Worker] Triggering Telegram notification...');
    try {
      const message = `🪙 *GitPay Invoice Alert - ${statusText}*\n\n` +
                      `• *Invoice:* [#${issueNumber}](${issueUrl})\n` +
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
    } catch (e) {
      console.error('[Worker] Telegram notification failed:', e.message);
    }
  }
}
