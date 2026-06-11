# 🪙 GitPay (v3.0 — Zero Actions)

> A **zero-cost, non-custodial, and fully private** Bitcoin payment processor powered entirely by GitHub Pages, Issues, and serverless Cloudflare Workers. No servers, no database, no GitHub Actions minutes limit.

GitPay is a highly competent, production-ready implementation of *"GitHub as a Backend"* (GitaaB). It allows developers and sovereign merchants to process on-chain Bitcoin payments and manage a secure ledger without databases, hosting costs, or intermediate custodians. Version 3.0 eliminates all dependencies on GitHub Actions, operating fully client-side and using an optional serverless Cloudflare Worker for 24/7 payment tracking.

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
└───────────┬───────────────────────────────────────┬─────────┘
            │                                       │
            │ (Pings paid status)                   │ POST (with PAT)
            ▼                                       ▼
┌───────────────────────────┐             ┌───────────────────┐
│  CLOUDFLARE WORKER        │             │  GITHUB ISSUES    │
│  ───────────────────      │             │  ─────────────    │
│  • Optional 24/7 sync     │             │  • Invoice Ledger │
│  • POST /invoice registry │             │  • Labels: paid,  │
│  • POST /check (checkout) │             │    pending,       │
│  • Cron (every 5 min)     │             │    expired        │
└─────┬──────────────┬──────┘             └───────────────────┘
      │              │
      ▼              ▼
┌───────────┐  ┌────────────┐
│ Discord   │  │ Telegram   │
│ Notifications│ Bot Alerts │
└───────────┘  └────────────┘
```

---

## 🛡️ Sovereign Security & Privacy Design

1. **Non-Custodial**: Your keys, your coins. The frontend only requires your Extended Public Key (e.g. `xpub`/`ypub`/`zpub`). Private keys are never touched, imported, or exposed.
2. **Local Settings**: Configuration settings (like your GitHub PAT, repository path, and extended public key) are saved **exclusively in your browser's local storage** (`localStorage`) and synced securely to browser IndexedDB for PWA service worker background tasks.
3. **Zero Metadata Leaks (AES-GCM Encryption)**: 
   - When generating an invoice, the description is encrypted client-side using a key derived deterministically from the invoice index and the **Merchant Master Encryption Key**.
   - The ciphertext is saved in the GitHub Issue body. The GitHub platform and external observers **never see what was purchased or who the customer is**.
   - The decryption key is passed to the customer via the URL fragment/hash (`#key=...`), which is **never sent to any server** (remains in the browser).
   - The merchant can decrypt all descriptions on their Dashboard automatically using the local Master Key.
4. **Anonymous Client View**: The customer checkout page (`/?invoice=XX#key=...`) queries the public GitHub API and blockchain explorer anonymously without requiring any API tokens.

---

## ⚡ Key Features (v3.0)

*   **Zero Actions Dependency**: No more GitHub Actions delay, cron limitations, or repo permission warnings. 
*   **Active Sync**: The **Merchant Dashboard actively polls the blockchain** for pending invoices in the background using the Page Visibility API while open. If a payment is detected, the dashboard updates the GitHub Issue state *instantly* using the merchant's API token.
*   **Manual Verification**: Instantly check any invoice state directly from the dashboard with the **Verify** button.
*   **Instant Checkout settlement**: When the customer's page detects payment, it pings the Cloudflare Worker (`POST /check`) to instantly close the GitHub Issue, eliminating Cron triggers waiting periods.
*   **PWA Support**: Install the GitPay Dashboard directly to your mobile or desktop device. Includes a Service Worker (`sw.js`) and Background Sync capability.
*   **Payment Tolerance & Underpayment Handling**:
    *   **Tolerance**: Easily adjust payment tolerance (e.g., `99.5%` to tolerate minor exchange or wallet fee deductions).
    *   **Underpayment UI**: If a client sends a partial payment (e.g., 50% of the invoice), the checkout screen flags a warning and instructs the customer to send the remaining amount to the same address.

---

## 🚀 Step-by-Step Setup Guide

### 1. Create a Repository
1. Create a new public repository on GitHub (e.g., `yourusername/gitpay`).
2. Clone this repository to your local system or upload the GitPay files.

### 2. Generate a GitHub Personal Access Token (PAT)
To allow the Merchant Dashboard to write new invoices and update issue labels, you need a Token:
1. Go to **GitHub Settings** ➔ **Developer Settings** ➔ **Personal Access Tokens** ➔ **Tokens (classic)**.
2. Click **Generate new token (classic)**.
3. Name it `GitPay Gateway` and select the **`public_repo`** scope.
4. Copy the token. You will paste this into the GitPay settings page in your browser.

### 3. Enable GitHub Pages
1. In your repository on GitHub, go to **Settings** ➔ **Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Select your main branch (e.g., `main`) and root folder (`/`), then click **Save**.
4. GitHub will give you a public URL (e.g., `https://yourusername.github.io/gitpay/`).

### 4. Deploy the 24/7 Cloudflare Worker (Optional)
For 24/7 automated monitoring when your dashboard is closed:
1. Navigate to the `worker/` directory: `cd worker`
2. Follow the deployment guide inside the [Worker README](worker/README.md) to set up Cloudflare KV and publish the worker.
3. Copy the deployed worker URL and save it in your Settings.

---

## 💻 How to Use

### 🪙 Merchant View (Dashboard)
1. Open the GitPay Pages URL in your browser (or open `index.html` locally).
2. Go to **Settings** and input:
   - **GitHub Personal Access Token**
   - **Repository Path** (e.g., `yourusername/gitpay`)
   - **Extended Public Key** (xpub, ypub, or zpub)
   - **Network Mode** (Mainnet / Testnet)
   - **Cloudflare Worker URL** (Optional, for 24/7 check fallback)
   - **Merchant Master Encryption Key** (Back this key up! Without it, you cannot view invoice descriptions on other devices).
   - **Payment Tolerance** (e.g. `99.5%`)
3. Save settings.
4. Go to **Create Invoice**, input the amount (will convert to Sats in real-time), description, and click **Generate Invoice**.
5. GitPay will automatically copy the customer payment link to your clipboard!

### 🛒 Customer Payment View
1. Send the payment link to your client.
2. The client will see a beautiful checkout page featuring the amount in sats, the derived address, a countdown timer (15 minutes), and a QR Code.
3. **Instant Feedback:** The page polls the blockchain via `mempool.space` every 8 seconds. As soon as the payment hits the mempool, the screen transitions to a green success state and updates the merchant's ledger immediately.

---

## 🛠️ Local Development & Testing

To bundle the client-side Bitcoin library yourself after editing `lib-entry.js`:
```bash
npm install
npm run build:lib
npm run minify:lib
```

---

*Disclaimer: This project is meant for educational and small-scale sovereign merchant purposes. Always secure your xpub privacy, as exposing it allows third parties to trace your wallet balances.*
