"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ethers } from "ethers";

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: After deploying InvoiceChain.sol on Arc Testnet via Remix,
//         replace the address below with your new contract address.
// ─────────────────────────────────────────────────────────────────────────────
const CONTRACT_ADDRESS = "0xBF1E0f8573A19F9D4B39eCF3665DF9397138590E";

// ─── Arc Testnet config ───────────────────────────────────────────────────────
const ARC_CHAIN_ID_HEX  = "0x4CEF52"; // decimal: 5042002
const ARC_TESTNET_PARAMS = {
  chainId:            ARC_CHAIN_ID_HEX,
  chainName:          "Arc Testnet",
  nativeCurrency:     { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls:            ["https://rpc.testnet.arc.network"],
  blockExplorerUrls:  [],
};

// ─── ABI — must match InvoiceChain.sol exactly ────────────────────────────────
// Verified selectors (keccak256):
//   createInvoice(string,string,uint256)  → 0x9c898203
//   payInvoice(uint256)                   → 0x5f2586fe
//   getInvoice(uint256)                   → 0x02ef9774
//   getInvoicesByCreator(address)         → 0xd39635c0
//   invoiceCount()                        → 0x5f4ed400
const CONTRACT_ABI = [
  "function createInvoice(string calldata title, string calldata description, uint256 amount) external returns (uint256)",
  "function payInvoice(uint256 invoiceId) external payable",
  "function getInvoice(uint256 invoiceId) external view returns (address creator, string memory title, string memory description, uint256 amount, bool paid, uint256 createdAt)",
  "function getInvoicesByCreator(address creator) external view returns (uint256[] memory)",
  "function isPaid(uint256 invoiceId) external view returns (bool)",
  "function invoiceCount() external view returns (uint256)",
  "event InvoiceCreated(uint256 indexed invoiceId, address indexed creator, uint256 amount, string title)",
  "event InvoicePaid(uint256 indexed invoiceId, address indexed payer, address indexed creator, uint256 amount)",
];

// ─── Amount helpers ───────────────────────────────────────────────────────────
// Arc Testnet native token is USDC (18 decimals, same encoding as ETH/wei).
// • User types "0.05"  → stored on-chain as 50000000000000000 (smallest unit)
// • On-chain 50000000000000000 → displayed as "0.05 USDC"
const toWei    = (usdc: string): bigint => ethers.parseEther(usdc);
const fromWei  = (wei: bigint): string  => ethers.formatEther(wei);
const fmtUsdc  = (usdc: string): string => {
  const n = parseFloat(usdc);
  if (isNaN(n)) return "0 USDC";
  return n.toFixed(6).replace(/\.?0+$/, "") + " USDC";
};

// ─── Types ────────────────────────────────────────────────────────────────────
interface Invoice {
  id:          number;
  creator:     string;
  title:       string;
  description: string;
  amount:      string;  // USDC string, e.g. "0.05"
  paid:        boolean;
  createdAt:   number;  // unix timestamp
}

type Tab = "dashboard" | "create" | "pay";

type EthProvider = {
  request:        (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on:             (event: string, cb: (...a: unknown[]) => void) => void;
  removeListener: (event: string, cb: (...a: unknown[]) => void) => void;
};

// ─── Small helpers ────────────────────────────────────────────────────────────
const truncate   = (a: string) => `${a.slice(0,6)}…${a.slice(-4)}`;
const fmtDate    = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" });
const shareLink  = (id: number) =>
  typeof window === "undefined"
    ? ""
    : `${window.location.origin}${window.location.pathname}?pay=${id}`;

// Format invoice ID as a random-looking alphanumeric string (e.g. 4 → "IC-7K3M9P")
// Uses a deterministic hash so the same on-chain ID always produces the same display ID.
// The on-chain ID is still a plain number — this is purely cosmetic.
const fmtInvoiceId = (id: number): string => {
  // Simple deterministic hash: mix the id with a prime seed
  let h = (id + 1) * 2654435761;
  h = ((h ^ (h >>> 16)) * 0x45d9f3b) >>> 0;
  h = ((h ^ (h >>> 16)) * 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I (ambiguous)
  let result = "";
  let n = h;
  for (let i = 0; i < 6; i++) {
    result += chars[n % chars.length];
    n = Math.floor(n / chars.length);
    if (i === 2) result += "-"; // insert dash after 3 chars: ABC-DEF
  }
  return "IC-" + result; // e.g. IC-A3F-7K2
};

// Extract numeric ID from a full payment URL (e.g. "https://…?pay=4" → "4")
// Returns the raw string so it can be passed to loadSingleInvoice.
const extractIdFromLink = (input: string): string => {
  const trimmed = input.trim();
  // If it looks like a URL, pull the ?pay= param
  if (trimmed.startsWith("http") || trimmed.includes("?pay=")) {
    try {
      const url = new URL(trimmed.includes("://") ? trimmed : `https://x.com/${trimmed}`);
      const p = url.searchParams.get("pay");
      if (p !== null) return p;
    } catch { /* fall through */ }
  }
  // If it looks like IC-XXX-XXX display ID, we can't reverse it — links carry the real numeric ID
  // so just fall through to treating the input as a plain number or URL
  // Otherwise assume it's already a plain number
  return trimmed;
};

// ─── Component ────────────────────────────────────────────────────────────────
export default function InvoiceDApp() {
  const [account,        setAccount]        = useState<string | null>(null);
  const [contract,       setContract]       = useState<ethers.Contract | null>(null);
  const [tab,            setTab]            = useState<Tab>("dashboard");
  const [invoices,       setInvoices]       = useState<Invoice[]>([]);
  const [invLoading,     setInvLoading]     = useState(false);
  const [connectLoading, setConnectLoading] = useState(false);
  const [txLoading,      setTxLoading]      = useState(false);
  const [toast,          setToast]          = useState<{ type:"success"|"error"|"info"; msg:string }|null>(null);
  const [copied,         setCopied]         = useState<number|null>(null);
  const [payId,          setPayId]          = useState("");
  const [linkInput,      setLinkInput]      = useState("");
  const [payInv,         setPayInv]         = useState<Invoice|null>(null);
  const [payLoading,     setPayLoading]     = useState(false);
  const [debugErr,       setDebugErr]       = useState<string|null>(null);
  const [form,           setForm]           = useState({ title:"", description:"", amount:"" });
  const pollRef = useRef<ReturnType<typeof setInterval>|null>(null);

  // ── Toast ──
  const toast$ = useCallback((type:"success"|"error"|"info", msg:string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 5500);
  }, []);

  // ── URL param ?pay= ──
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("pay");
    if (id) {
      setPayId(id);
      setLinkInput(window.location.href); // show full URL in the paste box
      setTab("pay");
    }
  }, []);

  // ── Ensure Arc Testnet ──
  const ensureNetwork = useCallback(async (eth: EthProvider): Promise<boolean> => {
    const current = (await eth.request({ method: "eth_chainId" })) as string;
    if (current.toLowerCase() === ARC_CHAIN_ID_HEX.toLowerCase()) return true;
    try {
      await eth.request({ method:"wallet_switchEthereumChain", params:[{ chainId: ARC_CHAIN_ID_HEX }] });
      return true;
    } catch (e: unknown) {
      const code = (e as { code?:number })?.code;
      if (code === 4902 || code === -32603) {
        try {
          await eth.request({ method:"wallet_addEthereumChain", params:[ARC_TESTNET_PARAMS] });
          await eth.request({ method:"wallet_switchEthereumChain", params:[{ chainId: ARC_CHAIN_ID_HEX }] });
          return true;
        } catch (ae) {
          console.error("addEthereumChain failed:", ae);
          toast$("error", "Could not add Arc Testnet. Please add it manually in MetaMask settings.");
          return false;
        }
      }
      if ((e as {code?:number})?.code === 4001) {
        toast$("error", "Network switch rejected. Please switch to Arc Testnet.");
      } else {
        toast$("error", "Failed to switch to Arc Testnet. Please do it manually.");
      }
      return false;
    }
  }, [toast$]);

  // ── Core invoice fetcher (takes args directly — no stale state) ──
  const loadInvoices = useCallback(async (ctr: ethers.Contract, addr: string) => {
    setInvLoading(true);
    setDebugErr(null);
    try {
      console.log("[IC] Fetching invoices for", addr);
      const ids: bigint[] = await ctr.getInvoicesByCreator(addr);
      console.log("[IC] IDs:", ids.map(String));
      if (ids.length === 0) { setInvoices([]); setInvLoading(false); return; }
      const list: Invoice[] = await Promise.all(ids.map(async (id) => {
        const inv = await ctr.getInvoice(id);
        return {
          id:          Number(id),
          creator:     inv[0] as string,
          title:       inv[1] as string,
          description: inv[2] as string,
          amount:      fromWei(inv[3] as bigint),
          paid:        inv[4] as boolean,
          createdAt:   Number(inv[5]),
        };
      }));
      setInvoices([...list].reverse());
    } catch (err: unknown) {
      const msg = (err as { message?:string })?.message ?? JSON.stringify(err);
      console.error("[IC] loadInvoices error:", msg);
      setDebugErr(msg.slice(0, 300));
      toast$("error", "Could not load invoices. See debug info below.");
    }
    setInvLoading(false);
  }, [toast$]);

  // ── Connect wallet — always shows popup ──
  const connectWallet = useCallback(async () => {
    const rawEth = (window as Window & { ethereum?:unknown }).ethereum;
    if (!rawEth) {
      toast$("error", "No wallet found. Please install MetaMask or Rabby and refresh.");
      return;
    }
    const eth = rawEth as EthProvider;
    setConnectLoading(true);
    setDebugErr(null);
    try {
      // Force the wallet account-selection popup every time
      await eth.request({ method:"wallet_requestPermissions", params:[{ eth_accounts:{} }] });
      const accs = (await eth.request({ method:"eth_accounts" })) as string[];
      if (!accs?.length) {
        toast$("error", "No account selected. Please try again.");
        setConnectLoading(false);
        return;
      }
      const ok = await ensureNetwork(eth);
      if (!ok) { setConnectLoading(false); return; }

      const prov  = new ethers.BrowserProvider(rawEth as Parameters<typeof ethers.BrowserProvider>[0]);
      const signer = await prov.getSigner();
      const addr   = await signer.getAddress();
      const ctr    = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);

      setAccount(addr);
      setContract(ctr);
      toast$("success", `Connected: ${truncate(addr)}`);
      loadInvoices(ctr, addr);
    } catch (err: unknown) {
      const code = (err as { code?:number })?.code;
      const msg  = (err as { message?:string })?.message ?? "";
      console.error("[IC] connectWallet:", err);
      if (code === 4001 || msg.includes("rejected") || msg.includes("denied")) {
        toast$("error", "Connection cancelled — you rejected the wallet prompt.");
      } else {
        const detail = msg.slice(0,150) || JSON.stringify(err).slice(0,150);
        setDebugErr(detail);
        toast$("error", "Connection failed. See debug info below.");
      }
    }
    setConnectLoading(false);
  }, [ensureNetwork, toast$, loadInvoices]);

  // ── Listen for wallet changes ──
  useEffect(() => {
    const rawEth = (window as Window & { ethereum?:unknown }).ethereum as EthProvider|undefined;
    if (!rawEth) return;
    const onAccounts = async (accs: unknown) => {
      const list = accs as string[];
      if (!list?.length) {
        setAccount(null); setContract(null); setInvoices([]);
        if (pollRef.current) clearInterval(pollRef.current);
        toast$("info", "Wallet disconnected.");
        return;
      }
      try {
        const prov  = new ethers.BrowserProvider(rawEth as Parameters<typeof ethers.BrowserProvider>[0]);
        const signer = await prov.getSigner();
        const addr   = await signer.getAddress();
        const ctr    = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
        setAccount(addr); setContract(ctr);
        loadInvoices(ctr, addr);
      } catch { /* silent */ }
    };
    const onChain = () => {
      toast$("info", "Network changed — please reconnect.");
      setAccount(null); setContract(null); setInvoices([]);
      if (pollRef.current) clearInterval(pollRef.current);
    };
    rawEth.on("accountsChanged", onAccounts);
    rawEth.on("chainChanged",    onChain);
    return () => {
      rawEth.removeListener("accountsChanged", onAccounts);
      rawEth.removeListener("chainChanged",    onChain);
    };
  }, [toast$, loadInvoices]);

  // ── Refresh dashboard when tab changes ──
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (contract && account && tab === "dashboard") loadInvoices(contract, account); }, [tab]);

  // ── Auto-poll every 15 s → catches client payments automatically ──
  useEffect(() => {
    if (!contract || !account) return;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => loadInvoices(contract, account), 15_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [contract, account, loadInvoices]);

  // ── Create invoice ──
  const createInvoice = useCallback(async () => {
    if (!contract || !account) { toast$("error", "Please connect your wallet first."); return; }
    if (!form.title.trim())    { toast$("error", "Invoice title is required."); return; }
    const amt = parseFloat(form.amount);
    if (!form.amount || isNaN(amt) || amt <= 0) { toast$("error", "Enter a valid USDC amount greater than 0."); return; }
    setTxLoading(true);
    setDebugErr(null);
    try {
      const amtWei = toWei(form.amount);
      console.log("[IC] createInvoice — wei:", amtWei.toString());
      const tx = await contract.createInvoice(form.title.trim(), form.description.trim(), amtWei);
      toast$("info", "Transaction sent — waiting for confirmation…");
      console.log("[IC] TX hash:", tx.hash);
      await tx.wait();
      console.log("[IC] TX confirmed");
      toast$("success", "Invoice created on-chain! ✓");
      setForm({ title:"", description:"", amount:"" });
      setTab("dashboard");
      setTimeout(() => loadInvoices(contract, account), 2500);
    } catch (err: unknown) {
      const code   = (err as { code?:number })?.code;
      const msg    = (err as { message?:string })?.message ?? "";
      const reason = (err as { reason?:string })?.reason;
      console.error("[IC] createInvoice error:", err);
      if (code === 4001 || msg.includes("rejected") || msg.includes("denied")) {
        toast$("error", "Transaction cancelled — you rejected in your wallet.");
      } else if (reason) {
        setDebugErr(reason); toast$("error", `Contract error: ${reason}`);
      } else {
        const d = msg.slice(0,200) || JSON.stringify(err).slice(0,200);
        setDebugErr(d); toast$("error", "Transaction failed. See debug info below.");
      }
    }
    setTxLoading(false);
  }, [contract, account, form, toast$, loadInvoices]);

  // ── Load single invoice ──
  // Uses wallet contract if connected, or a read-only public RPC if not.
  // This lets clients view invoice details before connecting their wallet.
  const loadSingleInvoice = useCallback(async (id: string) => {
    if (!id) return;
    setPayLoading(true); setDebugErr(null);

    let ctr = contract;
    // If no wallet connected, create a read-only provider from public RPC
    if (!ctr) {
      try {
        const readProvider = new ethers.JsonRpcProvider("https://rpc.testnet.arc.network");
        ctr = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, readProvider);
      } catch (e) {
        console.error("[IC] read-only provider failed:", e);
        toast$("error", "Connect your wallet to look up invoices.");
        setPayLoading(false);
        return;
      }
    }

    try {
      const inv = await ctr.getInvoice(Number(id));
      console.log("[IC] single invoice:", inv);
      setPayInv({
        id:          Number(id),
        creator:     inv[0] as string,
        title:       inv[1] as string,
        description: inv[2] as string,
        amount:      fromWei(inv[3] as bigint),
        paid:        inv[4] as boolean,
        createdAt:   Number(inv[5]),
      });
    } catch (err: unknown) {
      const msg = (err as { message?:string })?.message ?? JSON.stringify(err);
      console.error("[IC] loadSingleInvoice:", msg);
      if (msg.includes("InvoiceNotFound")) {
        toast$("error", `Invoice #${id} does not exist. Check the ID and try again.`);
      } else {
        setDebugErr(msg.slice(0,200));
        toast$("error", "Could not load invoice. See debug info below.");
      }
      setPayInv(null);
    }
    setPayLoading(false);
  }, [contract, toast$]);

  useEffect(() => {
    if (tab === "pay" && payId) loadSingleInvoice(payId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, payId]);

  // ── Pay invoice ──
  const payInvoice = useCallback(async () => {
    if (!contract || !payInv) return;
    setTxLoading(true); setDebugErr(null);
    try {
      const amtWei = toWei(payInv.amount);
      console.log("[IC] payInvoice #", payInv.id, "— wei:", amtWei.toString());
      const tx = await contract.payInvoice(payInv.id, { value: amtWei });
      toast$("info", "Payment submitted — confirming on-chain…");
      await tx.wait();
      toast$("success", "Payment confirmed! ✓ Invoice is now PAID.");
      setPayInv({ ...payInv, paid: true });
      if (account) loadInvoices(contract, account);
    } catch (err: unknown) {
      const code   = (err as { code?:number })?.code;
      const msg    = (err as { message?:string })?.message ?? "";
      const reason = (err as { reason?:string })?.reason ?? "";
      console.error("[IC] payInvoice error:", err);

      // Already paid — show it gracefully instead of an error
      if (msg.includes("InvoiceAlreadyPaid") || reason.includes("InvoiceAlreadyPaid")) {
        setPayInv({ ...payInv, paid: true });
        toast$("info", "This invoice has already been paid.");
      } else if (msg.includes("IncorrectPaymentAmount") || reason.includes("IncorrectPaymentAmount")) {
        toast$("error", "Payment amount does not match the invoice. Please refresh and try again.");
      } else if (msg.includes("InvoiceNotFound") || reason.includes("InvoiceNotFound")) {
        toast$("error", "Invoice not found on-chain.");
      } else if (code === 4001 || msg.includes("rejected") || msg.includes("denied")) {
        toast$("error", "Payment cancelled — you rejected in your wallet.");
      } else if (reason) {
        setDebugErr(reason);
        toast$("error", `Contract error: ${reason}`);
      } else {
        const d = msg.slice(0,200) || JSON.stringify(err).slice(0,200);
        setDebugErr(d);
        toast$("error", "Payment failed. See debug info below.");
      }
    }
    setTxLoading(false);
  }, [contract, payInv, account, toast$, loadInvoices]);

  // ── Copy share link ──
  const copyLink = (id: number) => {
    navigator.clipboard.writeText(shareLink(id));
    setCopied(id);
    setTimeout(() => setCopied(null), 2500);
  };

  // ── Disconnect ──
  const disconnect = () => {
    setAccount(null); setContract(null); setInvoices([]);
    setPayInv(null); setDebugErr(null);
    if (pollRef.current) clearInterval(pollRef.current);
  };

  // ── Go home (logo click) ──
  const goHome = () => {
    setTab("dashboard");
    if (contract && account) loadInvoices(contract, account);
  };

  // ─── RENDER ───────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#080B12] text-white" style={{ fontFamily:"'DM Sans',system-ui,sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600&family=DM+Mono:wght@400;500&display=swap');
        *,*::before,*::after{box-sizing:border-box}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-thumb{background:#1e2535;border-radius:4px}
        .row:hover{background:rgba(255,255,255,.025)}
        .tab-btn{transition:color .15s,background .15s}
        .ifield{transition:border-color .2s,background .2s}
        .ifield:focus{outline:none;border-color:#2563eb!important;background:rgba(37,99,235,.06)!important}
        .btn-connect{background:linear-gradient(135deg,#1a3a8f,#2563eb);transition:opacity .15s,transform .15s}
        .btn-connect:hover:not(:disabled){opacity:.85;transform:translateY(-1px)}
        .btn-blue{transition:background .15s,transform .15s}
        .btn-blue:hover:not(:disabled){background:#1d4ed8;transform:translateY(-1px)}
        .btn-green{transition:background .15s,border-color .15s}
        .btn-green:hover:not(:disabled){background:rgba(74,222,128,.12);border-color:#22c55e}
        .cpbtn{transition:all .15s}
        .cpbtn:hover{background:rgba(37,99,235,.12);border-color:#2563eb;color:#60a5fa}
        .logo-btn{transition:opacity .15s}
        .logo-btn:hover{opacity:.75}
        @keyframes fadeUp{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes spin{to{transform:rotate(360deg)}}
        .toast-in{animation:fadeUp .2s ease}
        .blink{animation:blink 1.8s ease infinite}
        .spin{animation:spin .75s linear infinite}
        .grid-bg{
          background-image:
            linear-gradient(rgba(37,99,235,.04) 1px,transparent 1px),
            linear-gradient(90deg,rgba(37,99,235,.04) 1px,transparent 1px);
          background-size:40px 40px
        }
      `}</style>

      {/* ── Toast ── */}
      {toast && (
        <div className={`toast-in fixed top-4 right-4 z-50 flex items-start gap-3 px-4 py-3 rounded-xl border text-[13px] font-medium max-w-sm shadow-2xl ${
          toast.type==="success" ? "bg-[#0b1f10] border-[#166534] text-[#4ade80]"
          : toast.type==="info"  ? "bg-[#0b1020] border-[#1e3a8a] text-[#60a5fa]"
          :                        "bg-[#1c0b0b] border-[#7f1d1d] text-[#f87171]"
        }`}>
          <span className="flex-shrink-0 text-[15px] mt-px">
            {toast.type==="success"?"✓":toast.type==="info"?"ℹ":"✕"}
          </span>
          <span className="leading-snug">{toast.msg}</span>
        </div>
      )}

      {/* ── Header ── */}
      <header className="sticky top-0 z-40 border-b border-white/[.06] bg-[#080B12]/90 backdrop-blur-xl">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">

          {/* Logo — clicking goes to home/dashboard */}
          <button onClick={goHome} className="logo-btn flex items-center gap-3 flex-shrink-0">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="white" strokeWidth="1.5"/>
                <path d="M5 5.5h6M5 8h4M5 10.5h2.5" stroke="white" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
            </div>
            <span className="font-semibold tracking-tight text-[15px] text-white">InvoiceChain</span>
          </button>

          <div className="flex items-center gap-3">
            {/* Testnet badge */}
            <span className="hidden sm:inline-flex items-center gap-1.5 text-[10px] font-medium bg-blue-500/10 border border-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full">
              <span className="blink w-1.5 h-1.5 bg-blue-400 rounded-full inline-block"></span>
              Arc Testnet · USDC
            </span>

            {account ? (
              <>
                <div className="hidden sm:flex items-center gap-2 bg-white/[.04] border border-white/[.08] rounded-lg px-3 py-1.5">
                  <div className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0"></div>
                  <span className="text-[12px] text-gray-300 font-mono">{truncate(account)}</span>
                </div>
                <button onClick={disconnect} className="text-[11px] text-gray-600 hover:text-gray-400 transition-colors px-2 py-1">
                  Disconnect
                </button>
              </>
            ) : (
              <button
                onClick={connectWallet}
                disabled={connectLoading}
                className="btn-connect flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-semibold text-white disabled:opacity-50"
              >
                {connectLoading && <svg className="spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="white" strokeWidth="3" opacity=".25"/><path fill="white" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" opacity=".75"/></svg>}
                {connectLoading ? "Connecting…" : "Connect Wallet"}
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ── Landing / not connected ── */}
      {!account && (
        <div className="grid-bg">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-24 pb-24 text-center">
            <div className="inline-flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 rounded-full px-3 py-1 text-[11px] font-medium text-blue-400 mb-6">
              <span className="blink w-1.5 h-1.5 bg-blue-400 rounded-full inline-block"></span>
              Arc Testnet · Chain ID 5042002 · Native token: USDC
            </div>
            <h1 className="text-4xl sm:text-[52px] font-semibold tracking-tight leading-tight mb-5">
              Onchain Invoices,<br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-blue-500 to-indigo-500">
                Trustless Payments
              </span>
            </h1>
            <p className="text-gray-400 text-[17px] max-w-lg mx-auto mb-10 leading-relaxed">
              Create invoices secured by smart contracts. Share a link with your client — when they pay on-chain, your dashboard updates automatically.
            </p>
            <button
              onClick={connectWallet}
              disabled={connectLoading}
              className="btn-connect inline-flex items-center gap-2 px-8 py-4 rounded-2xl font-semibold text-white text-[15px] disabled:opacity-50"
            >
              {connectLoading && <svg className="spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="white" strokeWidth="3" opacity=".25"/><path fill="white" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" opacity=".75"/></svg>}
              {connectLoading ? "Connecting…" : "Connect Wallet to Get Started"}
            </button>
            <p className="text-[11px] text-gray-600 mt-3">MetaMask & Rabby · You will confirm in your wallet · Network added automatically</p>

            {/* Info cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-16 text-left">
              {[
                { icon:"📄", title:"Create Invoices", body:"Fill in title, description and amount. Sign once — stored permanently on-chain." },
                { icon:"🔗", title:"Share Payment Link", body:"Copy the link and send it to your client. They open it, connect their wallet, and pay." },
                { icon:"✓",  title:"Auto PAID Status", body:"The moment your client pays, your dashboard flips to PAID. No manual checking." },
              ].map(c => (
                <div key={c.title} className="bg-white/[.03] border border-white/[.07] rounded-2xl p-5">
                  <div className="text-2xl mb-3">{c.icon}</div>
                  <p className="font-semibold text-[14px] mb-1">{c.title}</p>
                  <p className="text-[12px] text-gray-500 leading-relaxed">{c.body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Debug error ── */}
      {debugErr && (
        <div className="max-w-5xl mx-auto px-4 sm:px-6 mt-4">
          <div className="bg-red-950/30 border border-red-800/40 rounded-xl px-4 py-3 flex items-start gap-3">
            <span className="text-red-400 flex-shrink-0 mt-0.5">⚠</span>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-semibold text-red-400 mb-1">Error details — open browser DevTools (F12) → Console for full trace</p>
              <p className="text-[11px] text-red-300/60 font-mono break-all leading-relaxed">{debugErr}</p>
            </div>
            <button onClick={() => setDebugErr(null)} className="text-red-600 hover:text-red-400 text-xl leading-none flex-shrink-0">×</button>
          </div>
        </div>
      )}

      {/* ── App shell (connected) ── */}
      {account && (
        <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">

          {/* Tabs */}
          <div className="flex items-center gap-1 bg-white/[.03] border border-white/[.07] rounded-xl p-1 w-fit mb-8">
            {([
              { key:"dashboard" as Tab, label:"My Invoices"    },
              { key:"create"    as Tab, label:"Create Invoice"  },
              { key:"pay"       as Tab, label:"Pay Invoice"     },
            ]).map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`tab-btn px-4 py-2 rounded-lg text-[13px] font-medium ${
                  tab === t.key
                    ? "bg-white/[.08] text-white"
                    : "text-gray-500 hover:text-gray-300"
                }`}
              >
                {t.label}
                {t.key==="dashboard" && invoices.length>0 && (
                  <span className="ml-1.5 text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full">
                    {invoices.length}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* ═══════════ DASHBOARD ═══════════ */}
          {tab === "dashboard" && (
            <section>
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-xl font-semibold">My Invoices</h2>
                  <p className="text-[13px] text-gray-500 mt-0.5">
                    Auto-refreshes every 15 s · {invoices.length} total
                  </p>
                </div>
                <button
                  onClick={() => loadInvoices(contract!, account)}
                  disabled={invLoading}
                  className="flex items-center gap-2 text-[12px] text-gray-400 hover:text-white border border-white/[.08] rounded-lg px-3 py-1.5 transition-colors disabled:opacity-40"
                >
                  <svg className={`w-3.5 h-3.5 ${invLoading?"spin":""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                  </svg>
                  {invLoading ? "Loading…" : "Refresh"}
                </button>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-3 gap-3 mb-6">
                {[
                  { label:"Total",   val:invoices.length,                        color:"text-white"     },
                  { label:"Paid",    val:invoices.filter(i=>i.paid).length,      color:"text-green-400" },
                  { label:"Pending", val:invoices.filter(i=>!i.paid).length,     color:"text-amber-400" },
                ].map(s => (
                  <div key={s.label} className="bg-white/[.03] border border-white/[.07] rounded-xl p-4">
                    <p className="text-[11px] text-gray-500 mb-1">{s.label}</p>
                    <p className={`text-2xl font-semibold ${s.color}`}>{s.val}</p>
                  </div>
                ))}
              </div>

              {/* List */}
              {invLoading && invoices.length===0 ? (
                <div className="space-y-3">
                  {[1,2,3].map(i=><div key={i} className="h-[72px] bg-white/[.03] rounded-xl animate-pulse"/>)}
                </div>
              ) : invoices.length===0 ? (
                <div className="border border-dashed border-white/[.08] rounded-2xl py-20 text-center">
                  <div className="w-12 h-12 mx-auto mb-4 bg-white/[.03] rounded-xl flex items-center justify-center">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="1.5">
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                      <polyline points="14,2 14,8 20,8"/>
                      <line x1="16" y1="13" x2="8" y2="13"/>
                      <line x1="16" y1="17" x2="8" y2="17"/>
                    </svg>
                  </div>
                  <p className="text-gray-500 text-[13px]">No invoices yet</p>
                  <button onClick={()=>setTab("create")} className="mt-3 text-blue-400 hover:text-blue-300 text-[13px] transition-colors">
                    Create your first invoice →
                  </button>
                </div>
              ) : (
                <div className="border border-white/[.07] rounded-2xl overflow-hidden">
                  {invoices.map((inv,idx)=>(
                    <div key={inv.id} className={`row flex flex-col px-4 sm:px-5 py-4 gap-3 ${idx>0?"border-t border-white/[.05]":""}`}>
                      {/* Top row: title + amount + status */}
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-medium truncate">{inv.title}</p>
                          <p className="text-[11px] text-gray-500 mt-0.5 truncate">
                            {inv.description ? `${inv.description} · ` : ""}{fmtDate(inv.createdAt)}
                          </p>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="text-[13px] font-semibold font-mono">{fmtUsdc(inv.amount)}</p>
                          <span className={`mt-1 inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                            inv.paid
                              ? "bg-green-500/10 text-green-400 border border-green-500/20"
                              : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                          }`}>
                            {inv.paid ? "✓ PAID" : "UNPAID"}
                          </span>
                        </div>
                      </div>
                      {/* Bottom row: invoice ID + share buttons */}
                      <div className="flex items-center justify-between gap-3">
                        {/* ID badge — always visible */}
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-gray-600 font-medium uppercase tracking-wider">Invoice ID</span>
                          <span className="font-mono text-[12px] text-gray-300 bg-white/[.04] border border-white/[.08] px-2 py-0.5 rounded-md">{fmtInvoiceId(inv.id)}</span>
                        </div>
                        {/* Share buttons — only for unpaid */}
                        {!inv.paid ? (
                          <div className="flex items-center gap-2">
                            <button
                              onClick={()=>copyLink(inv.id)}
                              className="cpbtn flex items-center gap-1.5 text-[11px] border border-white/[.1] rounded-lg px-3 py-1.5 text-gray-500"
                            >
                              {copied===inv.id
                                ? <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20,6 9,17 4,12"/></svg>Copied!</>
                                : <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>Copy Link</>
                              }
                            </button>
                          </div>
                        ) : (
                          <span className="text-[11px] text-gray-700">Payment received on-chain</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* ═══════════ CREATE ═══════════ */}
          {tab === "create" && (
            <section className="max-w-xl">
              <h2 className="text-xl font-semibold mb-1">Create Invoice</h2>
              <p className="text-[13px] text-gray-500 mb-8">
                Fill in the details and sign the transaction to publish on-chain permanently.
              </p>

              {/* Testnet notice */}
              <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl px-4 py-3 mb-6 flex items-start gap-3">
                <span className="text-blue-400 flex-shrink-0 text-[15px] mt-0.5">ℹ</span>
                <div>
                  <p className="text-[12px] font-medium text-blue-300 mb-0.5">You are on Arc Testnet</p>
                  <p className="text-[11px] text-blue-400/60 leading-relaxed">
                    Amounts are in <strong>USDC</strong> — Arc Testnet&apos;s native token.
                    This is test USDC — no real money. The same contract works on mainnet with real USDC.
                  </p>
                </div>
              </div>

              <div className="space-y-5">
                <div>
                  <label className="block text-[13px] font-medium text-gray-300 mb-2">
                    Invoice Title <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Website Design — Phase 1"
                    value={form.title}
                    onChange={e=>setForm(f=>({...f,title:e.target.value}))}
                    className="ifield w-full bg-white/[.03] border border-white/[.1] rounded-xl px-4 py-3 text-[13px] text-white placeholder-gray-600"
                  />
                </div>

                <div>
                  <label className="block text-[13px] font-medium text-gray-300 mb-2">
                    Description <span className="text-gray-600 font-normal">(optional)</span>
                  </label>
                  <textarea
                    placeholder="What is this invoice for? Add details for your client."
                    value={form.description}
                    onChange={e=>setForm(f=>({...f,description:e.target.value}))}
                    rows={3}
                    className="ifield w-full bg-white/[.03] border border-white/[.1] rounded-xl px-4 py-3 text-[13px] text-white placeholder-gray-600 resize-none"
                  />
                </div>

                <div>
                  <label className="block text-[13px] font-medium text-gray-300 mb-2">
                    Amount (USDC) <span className="text-red-400">*</span>
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      placeholder="e.g. 0.05"
                      min="0"
                      step="0.001"
                      value={form.amount}
                      onChange={e=>setForm(f=>({...f,amount:e.target.value}))}
                      className="ifield w-full bg-white/[.03] border border-white/[.1] rounded-xl px-4 py-3 text-[13px] text-white placeholder-gray-600 pr-14"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[11px] font-medium text-gray-500 font-mono">USDC</span>
                  </div>
                </div>

                {/* Live preview */}
                {(form.title || form.amount) && (
                  <div className="bg-white/[.02] border border-white/[.07] rounded-xl p-4">
                    <p className="text-[10px] text-gray-600 uppercase tracking-wider font-semibold mb-3">Invoice Preview</p>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium">{form.title||"—"}</p>
                        {form.description && <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">{form.description}</p>}
                      </div>
                      <p className="text-[13px] font-semibold font-mono text-blue-400 flex-shrink-0">
                        {form.amount ? fmtUsdc(form.amount) : "—"}
                      </p>
                    </div>
                    <div className="mt-3 pt-3 border-t border-white/[.06] flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0"></span>
                      <span className="text-[11px] text-gray-500">
                        Starts as UNPAID · flips to ✓ PAID the moment your client pays
                      </span>
                    </div>
                  </div>
                )}

                <button
                  onClick={createInvoice}
                  disabled={txLoading || !form.title.trim() || !form.amount || parseFloat(form.amount)<=0}
                  className="btn-blue w-full bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl py-3.5 text-[13px] font-semibold flex items-center justify-center gap-2"
                >
                  {txLoading ? (
                    <><svg className="spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="white" strokeWidth="3" opacity=".25"/><path fill="white" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" opacity=".75"/></svg>Creating on-chain…</>
                  ) : "Create Invoice"}
                </button>
                <p className="text-[11px] text-gray-600 text-center">
                  MetaMask will ask you to confirm · a small gas fee applies
                </p>
              </div>
            </section>
          )}

          {/* ═══════════ PAY ═══════════ */}
          {tab === "pay" && (
            <section className="max-w-xl">
              <h2 className="text-xl font-semibold mb-1">Pay Invoice</h2>
              <p className="text-[13px] text-gray-500 mb-8">
                Paste the payment link you received below to load and pay the invoice.
              </p>

              {/* Paste link box */}
              <div className="space-y-3 mb-8">
                <label className="block text-[13px] font-medium text-gray-300">
                  Payment Link
                </label>
                <div className="flex gap-3">
                  <input
                    type="text"
                    placeholder="Paste the invoice link here — e.g. https://yoursite.com?pay=4"
                    value={linkInput}
                    onChange={e => { setLinkInput(e.target.value); setPayInv(null); }}
                    className="ifield flex-1 bg-white/[.03] border border-white/[.1] rounded-xl px-4 py-3 text-[13px] text-white placeholder-gray-600"
                  />
                  <button
                    onClick={() => {
                      const id = extractIdFromLink(linkInput);
                      setPayId(id);
                      loadSingleInvoice(id);
                    }}
                    disabled={payLoading || !linkInput.trim()}
                    className="btn-blue bg-blue-600 disabled:opacity-40 px-5 rounded-xl text-[13px] font-medium flex items-center gap-2"
                  >
                    {payLoading && <svg className="spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="white" strokeWidth="3" opacity=".25"/><path fill="white" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" opacity=".75"/></svg>}
                    {payLoading ? "Loading…" : "Load Invoice"}
                  </button>
                </div>
                <p className="text-[11px] text-gray-600">
                  The creator sends you a link. Paste the full link above and click Load Invoice.
                </p>
              </div>

              {payLoading && !payInv && <div className="h-52 bg-white/[.03] rounded-2xl animate-pulse"/>}

              {payInv && (
                <div className="border border-white/[.08] rounded-2xl overflow-hidden">
                  <div className="bg-white/[.03] px-6 py-5 border-b border-white/[.07]">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-[16px]">{payInv.title}</p>
                        {payInv.description && <p className="text-[13px] text-gray-400 mt-1 leading-relaxed">{payInv.description}</p>}
                      </div>
                      <span className={`flex-shrink-0 text-[10px] font-semibold px-2.5 py-1 rounded-full ${
                        payInv.paid
                          ? "bg-green-500/10 text-green-400 border border-green-500/20"
                          : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                      }`}>
                        {payInv.paid ? "✓ PAID" : "UNPAID"}
                      </span>
                    </div>
                  </div>
                  <div className="px-6 py-5 space-y-3">
                    <div className="flex justify-between text-[13px]">
                      <span className="text-gray-500">Invoice ID</span>
                      <span className="font-mono text-gray-300">{fmtInvoiceId(payInv.id)}</span>
                    </div>
                    <div className="flex justify-between text-[13px]">
                      <span className="text-gray-500">Issued by</span>
                      <span className="font-mono text-gray-300">{truncate(payInv.creator)}</span>
                    </div>
                    <div className="flex justify-between text-[13px]">
                      <span className="text-gray-500">Date</span>
                      <span>{fmtDate(payInv.createdAt)}</span>
                    </div>
                    <div className="flex justify-between items-baseline border-t border-white/[.07] pt-4 mt-1">
                      <span className="text-[13px] text-gray-500">Amount Due</span>
                      <span className="text-[22px] font-bold font-mono text-white">{fmtUsdc(payInv.amount)}</span>
                    </div>
                  </div>
                  <div className="px-6 pb-6">
                    {!payInv.paid ? (
                      <>
                        {!account ? (
                          <button
                            onClick={connectWallet}
                            disabled={connectLoading}
                            className="btn-connect w-full flex items-center justify-center gap-2 rounded-xl py-3.5 text-[13px] font-semibold text-white disabled:opacity-50"
                          >
                            {connectLoading && <svg className="spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="white" strokeWidth="3" opacity=".25"/><path fill="white" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" opacity=".75"/></svg>}
                            {connectLoading ? "Connecting…" : "Connect Wallet to Pay"}
                          </button>
                        ) : (
                          <button
                            onClick={payInvoice}
                            disabled={txLoading}
                            className="btn-green w-full border border-green-500/25 text-green-400 bg-green-500/5 rounded-xl py-3.5 text-[13px] font-semibold flex items-center justify-center gap-2 disabled:opacity-40"
                          >
                            {txLoading ? (
                              <><svg className="spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity=".25"/><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" opacity=".75"/></svg>Processing…</>
                            ) : (
                              <><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Pay {fmtUsdc(payInv.amount)}</>
                            )}
                          </button>
                        )}
                        <p className="text-[11px] text-center text-gray-600 mt-3">
                          Payment goes directly to the creator · Confirmed on Arc Testnet · Final
                        </p>
                      </>
                    ) : (
                      <div className="flex items-center justify-center gap-2 text-green-400 bg-green-500/5 border border-green-500/20 rounded-xl py-4">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20,6 9,17 4,12"/></svg>
                        <span className="text-[13px] font-medium">Invoice paid — confirmed on-chain</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}

        </main>
      )}

      {/* ── Footer ── */}
      <footer className="border-t border-white/[.05] mt-20 py-8">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <button onClick={goHome} className="logo-btn flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center flex-shrink-0">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                <path d="M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="white" strokeWidth="1.5"/>
                <path d="M5 6h6M5 8.5h3" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            </div>
            <span className="text-[11px] text-gray-600">InvoiceChain · Arc Testnet</span>
          </button>
          <div className="flex flex-col sm:flex-row items-center gap-2 sm:gap-4 text-[11px]">
            <span className="text-gray-700">ethers.js v6 · Next.js 14 · Solidity 0.8.20</span>
            <span className="hidden sm:inline text-gray-800">·</span>
            <span className="text-gray-500 font-medium">© Copyright Beauty Benedict</span>
          </div>
        </div>
      </footer>
    </div>
  );
}