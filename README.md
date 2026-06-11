# 🪙 GitPay

> A **zero-cost, non-custodial, and fully decentralized** Bitcoin payment processor running entirely in the browser and powered by a Nostr Relay Network. No servers, no database, no GitHub APIs, and no centralized intermediaries.

GitPay  implements a sovereign, serverless payment gateway that uses **Nostr** as a P2P messaging ledger (NostraaB - Nostr as a Backend) and aligns with the cryptographic axioms of the **Aetheris Manifesto** for metadata-blind, untraceable transactions.

---

## 🏗️ Architecture (Nostr + Aetheris Layer III)

```
┌─────────────────────────────────────────────────────────────┐
│  GITHUB PAGES (Frontend client-side Dashboard / Checkout)   │
│  ────────────────────────────────────────────────────────   │
│  • BIP32 Address Derivation client-side                     │
│  • AES-GCM-256 Client Encryption (Aetheris Layer III)       │
│  • Active Sync: Real-time relay synchronization             │
└──────────────┬───────────────────────────────▲──────────────┘
               │                               │
               │ 1. Publish Event (Kind 30023) │ 4. Read Invoices & Receipts
               ▼                               │
┌──────────────────────────────────────────────┴──────────────┐
│  DECENTRALIZED NOSTR RELAYS (Blind Intermediaries)          │
│  ──────────────────────────────────────────────────         │
│  • Invoices (Kind 30023 replaceable, indexed by Address Hash)│
│  • Payment Receipts (Kind 23001 P2P instant checkouts)      │
│  • Relays see only encrypted payload blobs and address hashes│
└──────────────────────────────────────────────┬──────────────┘
                                               │
                                               │ 2. Check derived address
                                               ▼
┌─────────────────────────────────────────────────────────────┐
│  BITCOIN BLOCKCHAIN (mempool.space / Electrum WS)           │
│  ────────────────────────────────────────────────           │
│  • Checked client-side to verify transactions                │
└─────────────────────────────────────────────────────────────┘
```

---

## 🛡️ Sovereign Security & Privacy Axioms

1. **Non-Custodial**: Your keys, your coins. The gateway derives addresses from your master Extended Public Key (`xpub`/`ypub`/`zpub`). Private keys are never imported, exposed, or transmitted.
2. **Local Identity**: Your store private key (`nsec`) remains stored **exclusively in your browser's local storage and IndexedDB** (for PWA service worker background checks).
3. **Probabilistic Fee Routing (1% Fee)**: 
   - Out of 100 generated invoices, exactly 1 invoice (selected with a **1% probability**) will derive its receiving address from the developer's public xpub (`DEVELOPER_XPUB`) rather than the merchant's.
   - This eliminates dust split transaction outputs, halves network transaction fees, and eliminates all central collection servers or escrow contracts, keeping the code fully serverless.
4. **Aetheris Layer III: Blind Metadata Communications**:
   - **Address Hashing (`d` tag)**: The invoice's primary index tag on Nostr relays is `sha256(derived_address)`. The raw Bitcoin payment address is never stored in plain text on the relays, preventing network metadata mapping.
   - **Payload Encryption**: All invoice metadata (amounts, raw Bitcoin addresses, networks, and descriptions) is fully encrypted using AES-GCM-256 with the invoice key.
   - **Zero-Knowledge Relays**: Intermediaries (relays) are mathematically blind to transaction details, status updates (pending/paid/expired), or buyer/seller identities.
5. **Decentralized Receipting**: The customer's checkout browser acts as a temporary peer, publishing a signed payment receipt (Kind 23001) to Nostr relays when a transaction is seen, resulting in immediate ledger syncs.

---

## 🚀 Setup Guide

### 1. Build and Deploy
1. Clone this repository.
2. Build and bundle the Bitcoin/Nostr library:
   ```bash
   npm install
   npm run build:lib
   npm run minify:lib
   ```
3. Deploy the files to any static host (e.g., GitHub Pages, Vercel, Netlify, or self-host on a private server).

### 2. Configure Settings
1. Open the GitPay homepage in your browser.
2. Go to **Settings** and configure:
   - **Store Private Key (nsec)**: Click the generate button to generate a new store identity keypair. Save this key safely!
   - **Extended Public Key**: Input your `xpub`/`ypub`/`zpub` (Mainnet) or `tpub`/`upub`/`vpub` (Testnet).
   - **Nostr Relays**: Enter a list of public or private Nostr relays to connect to (defaults are provided).
3. Click **Save Configuration**.

---

## 💻 How to Use

### 🪙 Merchant View (Dashboard)
1. Go to **Create Invoice**, input the amount, description, and click **Generate Invoice**.
2. GitPay will derive the address, encrypt the invoice payload, sign the event, publish it to the relays, and copy the customer payment link to your clipboard.

### 🛒 Customer Payment View
1. Send the payment link to your client (e.g. `https://yourdomain.com/?invoice=<address>#key=<invoice_key>`).
2. The client fetches the encrypted invoice from Nostr, decrypts it client-side with the key in the URL, and displays the payment interface.
3. Once paid, the client's browser publishes a signed payment receipt to the Nostr relays. The merchant's open dashboard receives the WebSocket notification instantly, verifies the payment on the blockchain, and replaces the invoice event status with "paid".

---

*Disclaimer: This project is meant for educational and small-scale sovereign merchant purposes. Always secure your private keys and xpubs.*
