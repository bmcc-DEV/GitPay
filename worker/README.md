# GitPay Serverless Worker

This directory contains the code for the optional **Cloudflare Worker** that monitors Bitcoin invoice payments 24/7. When configured, it allows the customer checkout screen to trigger instant GitHub updates even if your merchant dashboard is offline.

---

## ⚡ Deployment Guide

### 1. Prerequisite
Make sure you have [Node.js](https://nodejs.org/) installed, then navigate to the `worker/` directory:
```bash
cd worker
```

### 2. Login to Cloudflare
Authenticate wrangler with your Cloudflare account:
```bash
npx wrangler login
```

### 3. Create the KV Namespace
Create a KV namespace named `GITPAY_KV` to store pending invoices:
```bash
npx wrangler kv:namespace create GITPAY_KV
```

**Example Output:**
```text
🌀 Creating namespace with name "gitpay-worker-GITPAY_KV"
✨ Success! Created KV Namespace "gitpay-worker-GITPAY_KV"
{
  binding: "GITPAY_KV",
  id: "45c82de978cf4a1e9488a03f4cf21d20"
}
```

Copy the `id` from the output and update your `wrangler.toml`:
```toml
kv_bindings = [
  { binding = "GITPAY_KV", id = "45c82de978cf4a1e9488a03f4cf21d20" }
]
```

### 4. Set Environment Secrets
Run the following commands to configure your repository settings and GitHub API tokens safely:
```bash
# REQUIRED: Your GitHub Personal Access Token (PAT)
npx wrangler secret put GITHUB_TOKEN

# REQUIRED: Your repository path (e.g., yourusername/yourrepo)
npx wrangler secret put GITHUB_REPO

# OPTIONAL: Webhook Notifications
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put WEBHOOK_URL
```

### 5. Deploy the Worker
Publish your serverless code to Cloudflare:
```bash
npx wrangler deploy
```

Once successfully deployed, copy the **Worker URL** (e.g. `https://gitpay-worker.yourusername.workers.dev`).

---

## ⚙️ Dashboard Configuration
1. Open your GitPay merchant dashboard.
2. Go to **Settings**.
3. Under **Cloudflare Worker (24/7 Sync)**, paste the **Worker URL**.
4. Click **Save Configuration**.

Now, when you create an invoice, GitPay will register it with your Worker. When the customer pays, their checkout screen will ping the Worker, triggering an instant confirmation on GitHub!
