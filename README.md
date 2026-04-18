# InvoiceChain — Onchain Invoice Generator dApp

A fully functional Web3 invoice generator built on **Arc Testnet**. Create invoices secured by smart contracts, share payment links with clients, and receive payments directly to your wallet — all on-chain with real-time PAID/UNPAID status tracking.

![InvoiceChain](public/favicon.ico)

## Live Demo

> Deployed on Arc Testnet — Chain ID: 5042002

**Contract Address:** `0xBF1E0f8573A19F9D4B39eCF3665DF9397138590E`

---

## Features

- **Connect Wallet** — MetaMask and Rabby supported. Network added automatically.
- **Create Invoices** — Title, description, and USDC amount stored permanently on-chain.
- **Unique Invoice IDs** — Every invoice gets a unique ID (e.g. `IC-HFF-R94`) generated deterministically from the on-chain index.
- **Shareable Payment Links** — Copy a link and send it to your client. They open it, connect their wallet, and pay.
- **Auto PAID Status** — Dashboard auto-refreshes every 15 seconds. The moment a client pays, status flips from `UNPAID` to `✓ PAID`.
- **Pay by Link** — Client pastes the payment link to load the invoice and pay directly.
- **Direct Payment** — ETH/USDC goes straight to the invoice creator's wallet. Nothing held in the contract.
- **Responsive Design** — Works on desktop and mobile.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 (App Router), TypeScript, Tailwind CSS |
| Blockchain | Solidity 0.8.20, ethers.js v6 |
| Network | Arc Testnet (Chain ID: 5042002) |
| Wallet | MetaMask, Rabby |
| Deployment | Vercel |

---

## Smart Contract

The contract is written in Solidity and deployed on Arc Testnet.

**File:** `InvoiceChain.sol`

### Functions

```solidity
// Create a new invoice
function createInvoice(string title, string description, uint256 amount) 
  returns (uint256 invoiceId)

// Pay an invoice — send exact amount as msg.value
function payInvoice(uint256 invoiceId) payable

// Read a single invoice
function getInvoice(uint256 invoiceId) 
  returns (address creator, string title, string description, uint256 amount, bool paid, uint256 createdAt)

// Get all invoice IDs created by a wallet
function getInvoicesByCreator(address creator) 
  returns (uint256[] ids)
```

### How Payment Works

1. Creator calls `createInvoice()` → invoice stored on-chain, ID returned
2. Creator shares payment link with client
3. Client calls `payInvoice(id)` with exact USDC amount as `msg.value`
4. ETH transfers **directly** to creator's wallet — no funds held in contract
5. `paid` flag set to `true` permanently on-chain

---

## Getting Started

### Prerequisites

- Node.js 18+
- MetaMask or Rabby wallet
- Arc Testnet added to your wallet (the app adds it automatically)

### Installation

```bash
# Clone the repository
git clone https://github.com/BeautyBenedict/invoicechain.git
cd invoicechain

# Install dependencies
npm install

# Run development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Environment

No `.env` file needed. The contract address and network config are in `app/page.tsx`:

```typescript
const CONTRACT_ADDRESS = "0xBF1E0f8573A19F9D4B39eCF3665DF9397138590E";
const ARC_CHAIN_ID_HEX = "0x4CEF52"; // 5042002
```

---

## Deploying Your Own Contract

1. Open [remix.ethereum.org](https://remix.ethereum.org)
2. Create a new file → paste `InvoiceChain.sol`
3. Compiler tab → version `0.8.20` → Compile
4. Deploy tab → Environment: **Injected Provider - MetaMask**
5. Make sure MetaMask is on Arc Testnet
6. Click **Deploy** → confirm in MetaMask
7. Copy the deployed contract address
8. Update `CONTRACT_ADDRESS` in `app/page.tsx`

---

## Deploying to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel
```

Or connect your GitHub repository directly on [vercel.com](https://vercel.com) for automatic deployments.

---

## Project Structure