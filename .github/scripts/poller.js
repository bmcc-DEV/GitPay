const { Octokit } = require('@octokit/rest');

// Initialize Octokit. GitHub Actions provides GITHUB_REPOSITORY and GH_TOKEN.
const token = process.env.GH_TOKEN;
if (!token) {
  console.error('❌ Error: GH_TOKEN environment variable is not defined.');
  process.exit(1);
}

const repository = process.env.GITHUB_REPOSITORY;
if (!repository) {
  console.error('❌ Error: GITHUB_REPOSITORY environment variable is not defined.');
  process.exit(1);
}

const [owner, repo] = repository.split('/');
const octokit = new Octokit({ auth: token });

async function pollInvoices() {
  console.log(`🔍 Scanning repository ${owner}/${repo} for pending invoices...`);

  // 1. Fetch open issues with the label 'pending'
  let issues = [];
  try {
    const { data } = await octokit.rest.issues.listForRepo({
      owner,
      repo,
      labels: 'pending',
      state: 'open',
      per_page: 100
    });
    issues = data;
  } catch (error) {
    console.error('❌ Failed to fetch issues from GitHub:', error.message);
    process.exit(1);
  }

  console.log(`Found ${issues.length} pending invoices to process.`);

  for (const issue of issues) {
    console.log(`\n--- Processing Issue #${issue.number} ---`);
    
    // 2. Extract invoice JSON from issue body
    let invoice;
    try {
      const jsonMatch = issue.body.match(/```json\s*([\s\S]*?)\s*```/);
      if (!jsonMatch) {
        throw new Error('No JSON code block found in issue body.');
      }
      invoice = JSON.parse(jsonMatch[1].trim());
      
      if (!invoice.address || !invoice.amount_sats || !invoice.created_at) {
        throw new Error('Missing required invoice fields (address, amount_sats, created_at).');
      }
    } catch (error) {
      console.error(`⚠️ Issue #${issue.number} has invalid or missing invoice data:`, error.message);
      
      // Mark as invalid to avoid reprocessing
      try {
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: issue.number,
          body: `⚠️ **System Note:** This issue could not be processed because the invoice data is missing or corrupted. Error: ${error.message}`
        });
        await octokit.rest.issues.update({
          owner,
          repo,
          issue_number: issue.number,
          labels: ['invalid', 'invoice'],
          state: 'closed'
        });
        console.log(`Marked Issue #${issue.number} as invalid and closed it.`);
      } catch (ghError) {
        console.error(`Failed to close invalid issue #${issue.number}:`, ghError.message);
      }
      continue;
    }

    console.log(`Invoice index: ${invoice.index}`);
    console.log(`Bitcoin Address: ${invoice.address}`);
    console.log(`Target Amount: ${invoice.amount_sats} sats`);
    console.log(`Created At: ${new Date(invoice.created_at).toUTCString()}`);

    try {
      // 3. Query mempool.space for the address
      const isTestnet = invoice.network === 'testnet';
      const mempoolUrl = isTestnet 
        ? `https://mempool.space/testnet/api/address/${invoice.address}`
        : `https://mempool.space/api/address/${invoice.address}`;

      console.log(`Querying ${mempoolUrl}...`);
      const response = await fetch(mempoolUrl);
      if (!response.ok) {
        throw new Error(`Mempool API returned status ${response.status}`);
      }
      
      const data = await response.json();
      
      // Calculate total funded sats (confirmed + unconfirmed in mempool)
      const confirmed = data.chain_stats.funded_txo_sum || 0;
      const unconfirmed = data.mempool_stats.funded_txo_sum || 0;
      const totalReceived = confirmed + unconfirmed;

      // Extract invoice-specific payment tolerance (default to 99.5% if not set)
      const tolerance = invoice.tolerance || 99.5;
      const thresholdSats = invoice.amount_sats * (tolerance / 100);

      console.log(`Received funds: ${totalReceived} sats (Confirmed: ${confirmed}, Unconfirmed: ${unconfirmed}). Threshold target: ${thresholdSats} sats.`);

      // 4. Verify payment against threshold
      if (totalReceived >= thresholdSats) {
        console.log(`✅ Payment detected for invoice #${invoice.index}!`);

        const isFullyConfirmed = confirmed >= thresholdSats;
        const confirmMsg = isFullyConfirmed 
          ? `✅ Payment confirmed on-chain!` 
          : `⏳ Payment detected in the mempool! (0/1 confirmations)`;

        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: issue.number,
          body: `### 🎉 Payment Detected!\n\n- **Received:** \`${totalReceived} sats\` (Requested: \`${invoice.amount_sats} sats\`)\n- **Status:** ${confirmMsg}\n- **Transaction History:** [View on Mempool.space](${isTestnet ? 'https://mempool.space/testnet' : 'https://mempool.space'}/address/${invoice.address})`
        });

        await octokit.rest.issues.update({
          owner,
          repo,
          issue_number: issue.number,
          labels: ['paid', 'invoice'],
          state: 'closed'
        });

        console.log(`Updated GitHub Issue #${issue.number} to 'paid' and closed it.`);

        // Dispatch notifications (Generic webhook, Discord, Telegram)
        await sendNotifications('invoice.paid', issue.number, invoice, totalReceived);

      } 
      // 5. Handle Underpayment / Partial Payments
      else if (totalReceived > 0) {
        console.log(`⚠️ Partial payment of ${totalReceived} sats detected for invoice #${invoice.index}. Leaving open.`);
        
        // Scan comments to prevent duplicate comments on the same partial amount
        const comments = await octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number: issue.number
        });

        const partialMatchStr = `Partial payment detected: ${totalReceived} sats`;
        const alreadyNotified = comments.data.some(c => c.body.includes(partialMatchStr));

        if (!alreadyNotified) {
          const remainingSats = invoice.amount_sats - totalReceived;
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: issue.number,
            body: `⚠️ **Partial Payment Detected!**\n\n- **Partial payment detected:** Received \`${totalReceived} sats\`\n- **Remaining:** \`${remainingSats.toLocaleString()} sats\` still required to complete.\n- **Status:** Leaving invoice pending until full payment or expiration.\n- [View on Mempool.space](${isTestnet ? 'https://mempool.space/testnet' : 'https://mempool.space'}/address/${invoice.address})`
          });
          console.log(`Logged partial payment on GitHub Issue #${issue.number}.`);
        }
      }
      // 6. Expiry check: 15 minutes = 900,000 milliseconds
      else {
        const timeElapsed = Date.now() - invoice.created_at;
        const expiryLimit = 15 * 60 * 1000;
        
        if (timeElapsed > expiryLimit) {
          console.log(`⏰ Invoice #${invoice.index} has expired.`);

          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: issue.number,
            body: `⏰ **Invoice Expired**\n\nNo payment was detected within the 15-minute window. This invoice is now closed.`
          });

          await octokit.rest.issues.update({
            owner,
            repo,
            issue_number: issue.number,
            labels: ['expired', 'invoice'],
            state: 'closed'
          });

          console.log(`Updated GitHub Issue #${issue.number} to 'expired' and closed it.`);

          // Dispatch notifications (Generic webhook, Discord, Telegram)
          await sendNotifications('invoice.expired', issue.number, invoice, totalReceived);
        } else {
          const minutesLeft = Math.round((expiryLimit - timeElapsed) / 60000);
          console.log(`Invoice #${invoice.index} is still pending. Time left: ~${minutesLeft} minute(s).`);
        }
      }
    } catch (err) {
      console.error(`❌ Error processing blockchain logic for Issue #${issue.number}:`, err.message);
    }
  }

  console.log('\n✅ Invoice polling finished.');
}

async function sendNotifications(event, issueNumber, invoice, receivedSats = 0) {
  const isTestnet = invoice.network === 'testnet';
  const explorerUrl = isTestnet 
    ? `https://mempool.space/testnet/address/${invoice.address}`
    : `https://mempool.space/address/${invoice.address}`;
  
  const issueUrl = `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
  const statusText = event === 'invoice.paid' ? 'PAID ✅' : 'EXPIRED ⏰';
  const color = event === 'invoice.paid' ? 1095553 : 15680572; // Hex: 0x10b981 (green) vs 0xef4444 (red)

  // 1. Generic HTTP POST Webhook
  const webhookUrl = process.env.WEBHOOK_URL;
  if (webhookUrl) {
    console.log(`Triggering generic webhook...`);
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'GitPay-Invoice-Poller'
        },
        body: JSON.stringify({
          event,
          repository: `${owner}/${repo}`,
          issue_number: issueNumber,
          invoice: {
            ...invoice,
            received_sats: receivedSats,
            completed_at: Date.now()
          }
        })
      });
      console.log(`Webhook responded with status ${response.status}`);
    } catch (hookError) {
      console.error(`Failed to dispatch generic webhook:`, hookError.message);
    }
  }

  // 2. Discord Webhook Notification
  const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (discordWebhookUrl) {
    console.log(`Sending Discord notification...`);
    try {
      const embed = {
        title: `GitPay Invoice Notification - ${statusText}`,
        color: color,
        fields: [
          { name: 'Issue', value: `[#${issueNumber}](${issueUrl})`, inline: true },
          { name: 'Index', value: `${invoice.index}`, inline: true },
          { name: 'Network', value: `${invoice.network}`, inline: true },
          { name: 'Amount Requested', value: `${invoice.amount_sats.toLocaleString()} sats`, inline: true },
          { name: 'Amount Received', value: `${receivedSats.toLocaleString()} sats`, inline: true },
          { name: 'Address', value: `[\`${invoice.address}\`](${explorerUrl})` }
        ],
        timestamp: new Date().toISOString()
      };

      const response = await fetch(discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] })
      });
      console.log(`Discord responded with status ${response.status}`);
    } catch (discordError) {
      console.error(`Failed to dispatch Discord webhook:`, discordError.message);
    }
  }

  // 3. Telegram Bot Notification
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChatId = process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChatId) {
    console.log(`Sending Telegram notification...`);
    try {
      const message = `🪙 *GitPay Invoice Notification - ${statusText}*\n\n` +
                      `• *Issue:* [#${issueNumber}](${issueUrl})\n` +
                      `• *Index:* \`${invoice.index}\` (${invoice.network})\n` +
                      `• *Requested:* \`${invoice.amount_sats.toLocaleString()} sats\`\n` +
                      `• *Received:* \`${receivedSats.toLocaleString()} sats\`\n` +
                      `• *Address:* [${invoice.address}](${explorerUrl})`;

      const response = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: tgChatId,
          text: message,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        })
      });
      console.log(`Telegram responded with status ${response.status}`);
    } catch (tgError) {
      console.error(`Failed to dispatch Telegram message:`, tgError.message);
    }
  }
}

pollInvoices().catch(console.error);
