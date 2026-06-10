# 🪙 GitPay (v2.0)

> A **zero-cost, non-custodial, and fully private** Bitcoin payment processor powered entirely by GitHub Pages, Issues, and Actions.

GitPay is a highly competent, production-ready implementation of *"GitHub as a Backend"* (GitaaB). It allows developers and sovereign merchants to process on-chain Bitcoin payments and manage a secure ledger without databases, hosting costs, or intermediate custodians.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  GITHUB PAGES (Frontend client-side)                        │
│  ───────────────────────────────────                        │
│  • Merchant Dashboard: Configures settings & manages keys   │
│  • AES-GCM Engine: Encrypts/decrypts descriptions locally   │
│  • BIP32 Engine: Derives segwit/legacy addresses from xpub  │
│  • Active Sync: Checks blockchain & updates GitHub ledger   │
│  • Customer View: Shows QR Code, address, and live timer     │
└──────────────────────┬──────────────────────────────────────┘
                       │ POST (GitHub API with PAT)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  GITHUB ISSUES (Private Metadata Ledger)                     │
│  ───────────────────────────────────────                     │
│  • Each open Issue represents a pending invoice             │
│  • Labels: `pending`, `paid`, `expired`, `invalid`          │
│  • Description is encrypted (AES-GCM); amount/address public│
└──────────────────────┬──────────────────────────────────────┘
                       │ trigger (cron schedule / active sync)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  GITHUB ACTIONS (Blockchain Poller Workflow)                │
│  ───────────────────────────────────────────                │
│  • Runs every 5 minutes (crontab fallback)                  │
│  • Checks mempool.space for address status                  │
│  • Underpayment: logs partial amount, leaves invoice open   │
│  • Tolerance (e.g. 99.5%): marks as Paid and closes issue   │
│  • Notifications: Webhooks, Discord Embeds, Telegram Bots   │
└─────────────────────────────────────────────────────────────┘
```

---

## 🛡️ Sovereign Security & Privacy Design

1. **Non-Custodial**: Your keys, your coins. The frontend only requires your Extended Public Key (e.g. `xpub`/`ypub`/`zpub`). Private keys are never touched, imported, or exposed.
2. **Local Settings**: Configuration settings (like your GitHub PAT, repository path, and extended public key) are saved **exclusively in your browser's local storage** (`localStorage`).
3. **Zero Metadata Leaks (AES-GCM Encryption)**: 
   - When generating an invoice, the description is encrypted client-side using a key derived deterministically from the invoice index and the **Merchant Master Encryption Key**.
   - The ciphertext is saved in the GitHub Issue body. The GitHub platform and external observers **never see what was purchased or who the customer is**.
   - The decryption key is passed to the customer via the URL fragment/hash (`#key=...`), which is **never sent to the server** (remains in the browser).
   - The merchant can decrypt all descriptions on their Dashboard automatically using the local Master Key.
4. **Anonymous Client View**: The customer checkout page (`/?invoice=XX#key=...`) queries the public GitHub API and blockchain explorer anonymously without requiring any API tokens.

---

## ⚡ Key Features (v2.0)

*   **Mitigation of Actions Delay (Active Sync)**: Since GitHub Actions cron jobs can delay up to 10-15 minutes, the **Merchant Dashboard actively checks the blockchain** for pending invoices in background while open. If a payment is detected, the dashboard updates the GitHub Issue state *instantly* using the merchant's API token.
*   **Payment Tolerance & Underpayment Handling**:
    *   **Tolerance**: Easily adjust payment tolerance (e.g., `99.5%` to tolerate minor exchange or wallet fee deductions).
    *   **Underpayment UI**: If a client sends a partial payment (e.g., 50% of the invoice), the checkout screen flags a warning and instructs the customer to send the remaining amount to the same address, keeping the timer active.
*   **Structured Notifications**: The poller script supports rich webhooks and native notifications:
    *   **Discord**: Rich embeds with payment status, requested vs received amounts, and direct transaction links.
    *   **Telegram**: Automated messages from a custom Telegram bot to your private chat/channel.

---

## 🚀 Step-by-Step Setup Guide

### 1. Create a Repository
1. Create a new public repository on GitHub (e.g., `yourusername/gitpay`).
2. Clone this repository to your local system or upload the GitPay files.

### 2. Generate a GitHub Personal Access Token (PAT)
To allow the Merchant Dashboard to write new invoices to your repository's Issues, you need to provide a Token:
1. Go to **GitHub Settings** ➔ **Developer Settings** ➔ **Personal Access Tokens** ➔ **Tokens (classic)**.
2. Click **Generate new token (classic)**.
3. Name it `GitPay Gateway` and select the **`public_repo`** scope.
4. Copy the token. Keep it safe! You will paste this into the GitPay settings page in your browser.

### 3. Enable GitHub Pages
1. In your repository on GitHub, go to **Settings** ➔ **Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Select your main branch (e.g., `main`) and root folder (`/`), then click **Save**.
4. GitHub will give you a public URL (e.g., `https://yourusername.github.io/gitpay/`).

### 4. Enable Issues Write Permissions for Actions
GitHub Actions requires explicit write permissions to update the labels and close the issues once paid/expired:
1. Go to your repository **Settings** ➔ **Actions** ➔ **General**.
2. Scroll down to **Workflow permissions**.
3. Select **Read and write permissions** and click **Save**.

### 5. Setup Action Secrets (Optional Notifications)
To configure rich notifications, add these secrets to your repository under **Settings** ➔ **Secrets and variables** ➔ **Actions** ➔ **New repository secret**:
*   `WEBHOOK_URL`: A URL to post JSON payment events to.
*   `DISCORD_WEBHOOK_URL`: Discord webhook URL to send rich payment alerts.
*   `TELEGRAM_BOT_TOKEN`: The API token from `@BotFather`.
*   `TELEGRAM_CHAT_ID`: Your Telegram chat ID (or channel ID) where the bot will post alerts.

---

## 💻 How to Use

### 🪙 Merchant View (Dashboard)
1. Open the GitPay Pages URL in your browser (or open `index.html` locally).
2. Go to **Settings** and input:
   - **GitHub Personal Access Token**
   - **Repository Path** (e.g., `yourusername/gitpay`)
   - **Extended Public Key** (xpub, ypub, or zpub)
   - **Network Mode** (Mainnet / Testnet)
   - **Fiat Currency**
   - **Merchant Master Encryption Key** (Back this key up! Without it, you cannot view invoice descriptions on other devices).
   - **Payment Tolerance** (e.g. `99.5%`)
3. Save settings.
4. Go to **Create Invoice**, input the amount (will convert to Sats in real-time), description, and click **Generate Invoice**.
5. GitPay will automatically copy the customer payment link to your clipboard!

### 🛒 Customer Payment View
1. Send the payment link to your client.
2. The client will see a beautiful checkout page featuring the amount in sats, the derived address, a countdown timer (15 minutes), and a QR Code.
3. **Instant Feedback:** The page polls the blockchain via `mempool.space` every 8 seconds. As soon as the payment hits the mempool, the screen transitions to a green success state, even before the transaction receives a confirmation or the GitHub Action runs!

---

## 🛠️ Local Development & Testing

If you want to test the poller script locally:
1. Install dependencies:
   ```bash
   npm install
   ```
2. Set the required environment variables:
   ```bash
   export GH_TOKEN="your_personal_access_token"
   export GITHUB_REPOSITORY="yourusername/gitpay"
   ```
3. Run the poller script:
   ```bash
   node .github/scripts/poller.js
   ```

To bundle the client-side Bitcoin library yourself after editing `lib-entry.js`:
```bash
npm run build:lib
npm run minify:lib
```

---

*Disclaimer: This project is meant for educational and small-scale sovereign merchant purposes. Always secure your xpub privacy, as exposing it allows third parties to trace your wallet balances.*
