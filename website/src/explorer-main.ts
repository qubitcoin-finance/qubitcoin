// ---------------------------------------------------------------------------
// QubitCoin Block Explorer - vanilla TS, hash-based routing, polling
// ---------------------------------------------------------------------------

const API = '/api/v1';

// --- Types -----------------------------------------------------------------

interface Status {
  name: string;
  height: number;
  mempoolSize: number;
  utxoCount: number;
  difficulty: string;
  lastBlockTime: number;
  targetBlockTime: number;
  peers: number;
  avgBlockTime: number;
  blockReward: number;
  totalTxs: number;
  hashrate: number;
}

interface TxInput {
  txId: string;
  outputIndex: number;
  publicKey: string;
  signature: string;
}

interface TxOutput {
  address: string;
  amount: number;
}

interface ClaimData {
  btcAddress: string;
  ecdsaPublicKey: string;
  ecdsaSignature: string;
  qcoinAddress: string;
}

interface Transaction {
  id: string;
  inputs: TxInput[];
  outputs: TxOutput[];
  timestamp: number;
  claimData?: ClaimData;
}

interface BlockHeader {
  version: number;
  previousHash: string;
  merkleRoot: string;
  timestamp: number;
  target: string;
  nonce: number;
}

interface Block {
  hash: string;
  height: number;
  header: BlockHeader;
  transactions: Transaction[];
}

interface MempoolTx {
  id: string;
  timestamp: number;
  sender: string | null;
  inputs: { txId: string; outputIndex: number }[];
  outputs: TxOutput[];
  claimData?: ClaimData;
}

interface ClaimStats {
  btcBlockHeight: number;
  totalEntries: number;
  claimed: number;
  unclaimed: number;
  claimedAmount: number;
  unclaimedAmount: number;
}

interface UTXO {
  txId: string;
  outputIndex: number;
  address: string;
  amount: number;
}

// --- API layer -------------------------------------------------------------

async function api<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const fetchStatus = () => api<Status>('/status');
const fetchBlocks = (count = 10) => api<Block[]>(`/blocks?count=${count}`);
const fetchBlock = (hash: string) => api<Block>(`/block/${hash}`);
const fetchTx = (txid: string) => api<Transaction>(`/tx/${txid}`);
const fetchMempoolTxs = (limit?: number) => api<MempoolTx[]>(limit ? `/mempool/txs?limit=${limit}` : '/mempool/txs');
const fetchMempoolStats = () => api<{ size: number }>('/mempool/stats');
const fetchBalance = (addr: string) => api<{ balance: number }>(`/address/${addr}/balance`);
const fetchUtxos = (addr: string) => api<UTXO[]>(`/address/${addr}/utxos`);
const fetchClaimStats = () => api<ClaimStats>('/claims/stats');

// --- Helpers ---------------------------------------------------------------

const COINBASE_TXID = '0'.repeat(64);

function truncHash(hash: string, len = 6): string {
  if (hash.length <= len * 2 + 3) return hash;
  return hash.slice(0, len) + '...' + hash.slice(-len);
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function timeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatHashrate(h: number): string {
  const units: [number, string][] = [
    [1e18, 'EH/s'], [1e15, 'PH/s'], [1e12, 'TH/s'],
    [1e9, 'GH/s'], [1e6, 'MH/s'], [1e3, 'KH/s'],
  ];
  for (const [threshold, label] of units) {
    if (h >= threshold) return (h / threshold).toFixed(3) + ' ' + label;
  }
  return h.toFixed(0) + ' H/s';
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '—';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

function blockEta(lastBlockTime: number, targetBlockTime: number): string {
  const eta = lastBlockTime + targetBlockTime - Date.now();
  // PoW is memoryless — if overdue, expected wait is still the target
  const remaining = eta > 0 ? eta : targetBlockTime;
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  if (mins > 0) return `~${mins}m ${secs}s`;
  return `~${secs}s`;
}

function formatDifficulty(hexTarget: string): string {
  // Count leading zeros in the hex target to derive a relative difficulty
  const clean = hexTarget.replace(/\.+$/, '');
  const leadingZeros = clean.match(/^0*/)?.[0].length ?? 0;
  const firstNonZero = clean.slice(leadingZeros, leadingZeros + 2);
  const frac = firstNonZero ? parseInt(firstNonZero, 16) : 0;
  // difficulty ≈ 16^leadingZeros / firstByte — simplified human number
  const diff = Math.pow(16, leadingZeros) / Math.max(frac, 1);
  if (diff >= 1e12) return (diff / 1e12).toFixed(1) + 'T';
  if (diff >= 1e9) return (diff / 1e9).toFixed(1) + 'G';
  if (diff >= 1e6) return (diff / 1e6).toFixed(1) + 'M';
  if (diff >= 1e3) return (diff / 1e3).toFixed(1) + 'K';
  return diff.toFixed(0);
}

/** Derive sender address from first input's public key (SHA-256, same as deriveAddress) */
async function senderAddress(tx: Transaction): Promise<string | null> {
  if (isCoinbase(tx) || isClaim(tx)) return null;
  const pk = tx.inputs[0]?.publicKey;
  if (!pk) return null;
  const bytes = new Uint8Array(pk.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Get the transfer amount (excluding change back to sender) */
function transferAmount(tx: Transaction | MempoolTx, sender: string | null): number {
  if (!sender) return tx.outputs.reduce((s, o) => s + o.amount, 0);
  return tx.outputs.filter(o => o.address !== sender).reduce((s, o) => s + o.amount, 0);
}

function isCoinbase(tx: Transaction | MempoolTx): boolean {
  return tx.inputs.length === 1 && tx.inputs[0].txId === COINBASE_TXID;
}

function isClaim(tx: Transaction | MempoolTx): boolean {
  return tx.claimData !== undefined;
}

function txTypeBadge(tx: Transaction | MempoolTx): string {
  if (isCoinbase(tx)) return '<span class="px-2 py-0.5 rounded text-xs font-medium bg-entropy-cyan/20 text-entropy-cyan">Coinbase</span>';
  if (isClaim(tx)) return '<span class="px-2 py-0.5 rounded text-xs font-medium bg-qubit-600/20 text-qubit-400">Claim</span>';
  return '<span class="px-2 py-0.5 rounded text-xs font-medium bg-entropy-blue/20 text-entropy-blue">Transfer</span>';
}

function hashLink(hash: string, type: 'block' | 'tx' | 'address', display?: string): string {
  const d = display ?? truncHash(hash);
  return `<a href="#/${type}/${hash}" class="font-mono text-qubit-400 hover:text-qubit-300 transition-colors">${d}</a>`;
}

function renderBlockStrip(blocks: Block[], mempoolSize: number): string {
  let html = `<div class="block-strip flex items-center gap-2 overflow-x-auto py-4 mb-6" style="-ms-overflow-style:none;scrollbar-width:none">
    <style>.block-strip::-webkit-scrollbar{display:none}</style>`;

  // Mempool pending block (dashed border)
  html += `<a href="#/mempool" class="w-[120px] min-w-[120px] h-[120px] rounded-lg border-2 border-dashed border-qubit-glow/60 flex flex-col items-center justify-center cursor-pointer hover:-translate-y-0.5 transition-transform text-center">
    <span class="text-text-muted text-xs mb-1">Mempool</span>
    <span class="text-xl font-bold">${mempoolSize}</span>
    <span class="text-text-muted text-xs">pending</span>
  </a>`;

  // Arrow separator
  html += `<span class="text-text-muted text-lg shrink-0">\u2192</span>`;

  // Mined blocks (up to 8, most recent first)
  const displayBlocks = blocks.slice(0, 8);
  for (const b of displayBlocks) {
    const txCount = b.transactions.length;
    // Purple intensity scales with tx count: more txs → more vivid
    const intensity = Math.min(txCount / 10, 1);
    const alpha = (0.15 + intensity * 0.45).toFixed(2);
    const bg = `rgba(168,85,247,${alpha})`;

    html += `<a href="#/block/${b.hash}" class="w-[120px] min-w-[120px] h-[120px] rounded-lg border border-border flex flex-col items-center justify-center cursor-pointer hover:-translate-y-0.5 transition-transform text-center" style="background:${bg}">
      <span class="text-white font-bold text-lg">#${b.height}</span>
      <span class="font-mono text-text-muted text-xs">${b.hash.slice(0, 4)}...</span>
      <span class="text-white text-xs mt-1">${txCount} tx${txCount !== 1 ? 's' : ''}</span>
      <span class="text-text-muted text-xs">${timeAgo(b.header.timestamp)}</span>
    </a>`;
  }

  html += `</div>`;
  return html;
}

function card(label: string, value: string | number, small = false): string {
  const valClass = small ? 'text-sm font-bold font-mono truncate' : 'text-2xl font-bold';
  return `<div class="bg-surface p-4 rounded-lg glow-border overflow-hidden">
    <p class="text-text-muted text-sm">${label}</p>
    <p class="${valClass}" title="${value}">${value}</p>
  </div>`;
}

// --- Router ----------------------------------------------------------------

type Route =
  | { view: 'dashboard' }
  | { view: 'block'; hash: string }
  | { view: 'tx'; txid: string }
  | { view: 'address'; addr: string }
  | { view: 'mempool' };

function parseRoute(): Route {
  const hash = location.hash || '#/';
  const parts = hash.slice(2).split('/'); // strip "#/"

  if (parts[0] === 'block' && parts[1]) return { view: 'block', hash: parts[1] };
  if (parts[0] === 'tx' && parts[1]) return { view: 'tx', txid: parts[1] };
  if (parts[0] === 'address' && parts[1]) return { view: 'address', addr: parts[1] };
  if (parts[0] === 'mempool') return { view: 'mempool' };
  return { view: 'dashboard' };
}

// --- Views -----------------------------------------------------------------

const root = document.getElementById('explorer-content')!;
const landingEl = document.getElementById('landing-content');
const explorerEl = document.getElementById('explorer-main');

function isExplorerRoute(): boolean {
  const hash = location.hash;
  // #/ alone is not an explorer route (show landing instead)
  return hash.startsWith('#/') && hash !== '#/';
}

function showExplorer(): void {
  if (landingEl) landingEl.classList.add('hidden');
  if (explorerEl) explorerEl.classList.remove('hidden');
}

function showLanding(): void {
  if (landingEl) landingEl.classList.remove('hidden');
  if (explorerEl) explorerEl.classList.add('hidden');
}

function renderLoading(): void {
  const pulse = 'animate-pulse bg-border/50 rounded';
  const skeletonCard = `<div class="bg-surface p-4 rounded-lg glow-border">
    <div class="${pulse} h-4 w-20 mb-2"></div>
    <div class="${pulse} h-8 w-16"></div>
  </div>`;
  const skeletonBlock = `<div class="w-[120px] min-w-[120px] h-[120px] rounded-lg border border-border ${pulse}"></div>`;
  const skeletonRow = `<div class="flex items-center justify-between py-3 border-b border-border last:border-0">
    <div class="${pulse} h-4 w-48"></div>
    <div class="${pulse} h-4 w-16"></div>
  </div>`;

  root.innerHTML = `
    <div class="${pulse} h-9 w-48 mb-6 rounded"></div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      ${skeletonCard}${skeletonCard}${skeletonCard}${skeletonCard}
    </div>
    <div class="flex items-center gap-2 overflow-hidden py-4 mb-6">
      ${skeletonBlock}
      <span class="text-text-muted text-lg shrink-0">\u2192</span>
      ${skeletonBlock}${skeletonBlock}${skeletonBlock}${skeletonBlock}${skeletonBlock}
    </div>
    <div class="grid md:grid-cols-2 gap-6">
      <div class="bg-surface rounded-lg glow-border p-5">
        <div class="${pulse} h-6 w-32 mb-4 rounded"></div>
        ${skeletonRow}${skeletonRow}${skeletonRow}${skeletonRow}
      </div>
      <div class="bg-surface rounded-lg glow-border p-5">
        <div class="${pulse} h-6 w-24 mb-4 rounded"></div>
        ${skeletonRow}${skeletonRow}${skeletonRow}${skeletonRow}
      </div>
    </div>`;
}

// Dashboard -----------------------------------------------------------------

async function renderDashboard(): Promise<void> {
  const [status, blocks, mempoolStats, claimStats] = await Promise.all([
    fetchStatus(),
    fetchBlocks(10),
    fetchMempoolStats(),
    fetchClaimStats(),
  ]);

  if (!status) {
    root.innerHTML = '<p class="text-red-500">Could not connect to the QubitCoin node.</p>';
    return;
  }

  let html = `<h1 class="text-3xl font-bold mb-6">Mempool</h1>`;

  // Status cards
  html += `<div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
    ${card('Height', status.height)}
    ${card('Mempool', mempoolStats?.size ?? status.mempoolSize)}
    ${card('UTXOs', status.utxoCount)}
    ${card('Difficulty', formatDifficulty(status.difficulty))}
    ${card('Next Block', blockEta(status.lastBlockTime, status.targetBlockTime))}
  </div>
  <div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
    ${card('Peers', status.peers)}
    ${card('Hashrate', formatHashrate(status.hashrate))}
    ${card('Avg Block Time', formatDuration(status.avgBlockTime))}
    ${card('Block Reward', status.blockReward + ' QTC')}
    ${card('Total Txs', status.totalTxs)}
  </div>`;

  // Claim stats row (only if fork mode)
  if (claimStats && claimStats.totalEntries > 0) {
    html += `<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
      ${card('BTC Fork Block', claimStats.btcBlockHeight.toLocaleString())}
      ${card('Claimed BTC', claimStats.claimedAmount)}
    </div>`;
  }

  // Block visualization strip
  if (blocks && blocks.length > 0) {
    html += renderBlockStrip(blocks, mempoolStats?.size ?? status.mempoolSize);
  }

  // Two-column: recent blocks + mempool
  html += `<div class="grid md:grid-cols-2 gap-6">`;

  // Recent blocks
  html += `<div class="bg-surface rounded-lg glow-border p-5">
    <h2 class="text-lg font-semibold mb-4">Recent Blocks</h2>`;
  if (blocks && blocks.length > 0) {
    html += `<table class="w-full text-sm">
      <thead><tr class="text-xs text-text-muted border-b border-border">
        <th class="text-left font-normal pb-2">Hash</th>
        <th class="text-right font-normal pb-2">Txs</th>
        <th class="text-left font-normal pb-2 pl-4">Miner</th>
        <th class="text-right font-normal pb-2">Age</th>
      </tr></thead><tbody>`;
    for (const b of blocks) {
      const txCount = b.transactions.length;
      const miner = b.transactions[0]?.outputs[0]?.address ?? '';
      html += `<tr class="border-b border-border last:border-0">
        <td class="py-2">${hashLink(b.hash, 'block')}</td>
        <td class="py-2 text-right text-text-muted">${txCount}</td>
        <td class="py-2 pl-4 font-mono text-xs">${miner ? hashLink(miner, 'address', truncHash(miner)) : ''}</td>
        <td class="py-2 text-right text-text-muted text-xs">${timeAgo(b.header.timestamp)}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  } else {
    html += `<p class="text-text-muted text-sm">No blocks yet.</p>`;
  }
  html += `</div>`;

  // Pending transactions
  html += `<div class="bg-surface rounded-lg glow-border p-5">
    <h2 class="text-lg font-semibold mb-4">Pending Transactions</h2>`;
  const mempoolTxs = await fetchMempoolTxs(8);
  if (mempoolTxs && mempoolTxs.length > 0) {
    html += `<div class="space-y-3">`;
    for (const tx of mempoolTxs) {
      const amount = transferAmount(tx, tx.sender);
      html += `<div class="flex items-center justify-between py-2 border-b border-border last:border-0">
        <div class="flex items-center gap-2">
          ${txTypeBadge(tx)}
          ${hashLink(tx.id, 'tx')}
        </div>
        <span class="text-text-muted text-xs font-mono">${amount} QTC</span>
      </div>`;
    }
    html += `</div>`;
  } else {
    html += `<p class="text-text-muted text-sm">Mempool is empty.</p>`;
  }
  html += `</div>`;

  html += `</div>`; // close grid

  root.innerHTML = html;
}

// Block detail --------------------------------------------------------------

async function renderBlock(hash: string): Promise<void> {
  let block = await fetchBlock(hash);

  // If not found as a block, try as a transaction (search disambiguation)
  if (!block) {
    const tx = await fetchTx(hash);
    if (tx) {
      location.hash = `#/tx/${hash}`;
      return;
    }
    root.innerHTML = `<p class="text-red-500">Block not found: ${truncHash(hash)}</p>
      <a href="#/mempool" class="text-qubit-400 hover:text-qubit-300 text-sm mt-2 inline-block">Back</a>`;
    return;
  }

  const h = block.header;
  let html = ``;
  html += `<h1 class="text-2xl font-bold mb-6">Block</h1>`;

  html += `<div class="bg-surface rounded-lg glow-border p-6 mb-6">
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
      <div>
        <p class="text-text-muted mb-1">Hash</p>
        <p class="font-mono text-xs break-all">${block.hash}</p>
      </div>
      <div>
        <p class="text-text-muted mb-1">Previous Hash</p>
        <p class="font-mono text-xs break-all">${hashLink(h.previousHash, 'block', h.previousHash)}</p>
      </div>
      <div>
        <p class="text-text-muted mb-1">Merkle Root</p>
        <p class="font-mono text-xs break-all">${h.merkleRoot}</p>
      </div>
      <div>
        <p class="text-text-muted mb-1">Timestamp</p>
        <p>${formatTime(h.timestamp)}</p>
      </div>
      <div>
        <p class="text-text-muted mb-1">Nonce</p>
        <p class="font-mono">${h.nonce}</p>
      </div>
      <div>
        <p class="text-text-muted mb-1">Target</p>
        <p class="font-mono text-xs break-all">${h.target}</p>
      </div>
      <div>
        <p class="text-text-muted mb-1">Version</p>
        <p class="font-mono">${h.version}</p>
      </div>
      <div>
        <p class="text-text-muted mb-1">Transactions</p>
        <p class="font-mono">${block.transactions.length}</p>
      </div>
      <div>
        <p class="text-text-muted mb-1">Miner</p>
        <p class="font-mono text-xs break-all">${block.transactions[0]?.outputs[0]?.address ? hashLink(block.transactions[0].outputs[0].address, 'address', block.transactions[0].outputs[0].address) : 'Unknown'}</p>
      </div>
    </div>
  </div>`;

  // Transaction list
  const blockSenders = await Promise.all(block.transactions.map(senderAddress));
  html += `<h2 class="text-lg font-semibold mb-4">Transactions</h2>`;
  html += `<div class="space-y-3">`;
  for (let i = 0; i < block.transactions.length; i++) {
    const tx = block.transactions[i];
    const amount = transferAmount(tx, blockSenders[i]);
    html += `<div class="bg-surface rounded-lg glow-border p-4 flex items-center justify-between">
      <div class="flex items-center gap-3">
        ${txTypeBadge(tx)}
        ${hashLink(tx.id, 'tx')}
      </div>
      <span class="text-text-muted text-sm font-mono">${amount} QTC</span>
    </div>`;
  }
  html += `</div>`;

  root.innerHTML = html;
}

// Transaction detail --------------------------------------------------------

async function renderTx(txid: string): Promise<void> {
  const tx = await fetchTx(txid);
  if (!tx) {
    root.innerHTML = `<p class="text-red-500">Transaction not found: ${truncHash(txid)}</p>
      <a href="#/mempool" class="text-qubit-400 hover:text-qubit-300 text-sm mt-2 inline-block">Back</a>`;
    return;
  }

  const sender = await senderAddress(tx);
  const amount = transferAmount(tx, sender);
  const totalOut = tx.outputs.reduce((s, o) => s + o.amount, 0);

  let html = ``;
  html += `<h1 class="text-2xl font-bold mb-6">Transaction</h1>`;

  // Header info
  html += `<div class="bg-surface rounded-lg glow-border p-6 mb-6">
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
      <div>
        <p class="text-text-muted mb-1">Transaction ID</p>
        <p class="font-mono text-xs break-all">${tx.id}</p>
      </div>
      <div>
        <p class="text-text-muted mb-1">Timestamp</p>
        <p>${formatTime(tx.timestamp)}</p>
      </div>
      <div>
        <p class="text-text-muted mb-1">Amount</p>
        <p class="font-mono">${amount} QTC</p>
      </div>
      <div>
        <p class="text-text-muted mb-1">Type</p>
        <p>${txTypeBadge(tx)}</p>
      </div>
    </div>
  </div>`;

  // Claim data
  if (tx.claimData) {
    const cd = tx.claimData;
    html += `<div class="bg-surface rounded-lg glow-border p-6 mb-6">
      <h2 class="text-lg font-semibold mb-3">Claim Data</h2>
      <div class="grid grid-cols-1 gap-3 text-sm">
        <div>
          <p class="text-text-muted mb-1">BTC Address (HASH160)</p>
          <p class="font-mono text-xs break-all">${cd.btcAddress}</p>
        </div>
        <div>
          <p class="text-text-muted mb-1">ECDSA Public Key</p>
          <p class="font-mono text-xs break-all">${cd.ecdsaPublicKey}</p>
        </div>
        <div>
          <p class="text-text-muted mb-1">Destination QTC Address</p>
          <p>${hashLink(cd.qcoinAddress, 'address', cd.qcoinAddress)}</p>
        </div>
      </div>
    </div>`;
  }

  // Inputs / Outputs side-by-side
  html += `<div class="grid md:grid-cols-2 gap-6">`;

  // Inputs
  html += `<div>
    <h2 class="text-lg font-semibold mb-3">Inputs (${tx.inputs.length})</h2>
    <div class="space-y-2">`;
  for (const inp of tx.inputs) {
    if (inp.txId === COINBASE_TXID) {
      html += `<div class="bg-surface rounded-lg glow-border p-3 text-sm">
        <p class="text-entropy-cyan font-mono text-xs">Coinbase (new coins)</p>
      </div>`;
    } else {
      html += `<div class="bg-surface rounded-lg glow-border p-3 text-sm">
        <p class="text-text-muted text-xs mb-1">From tx</p>
        <p>${hashLink(inp.txId, 'tx')}<span class="text-text-muted">:${inp.outputIndex}</span></p>
      </div>`;
    }
  }
  html += `</div></div>`;

  // Outputs
  html += `<div>
    <h2 class="text-lg font-semibold mb-3">Outputs (${tx.outputs.length})</h2>
    <div class="space-y-2">`;
  for (const out of tx.outputs) {
    html += `<div class="bg-surface rounded-lg glow-border p-3 text-sm flex items-center justify-between">
      <div>
        <p class="text-text-muted text-xs mb-1">To</p>
        <p>${hashLink(out.address, 'address')}</p>
      </div>
      <span class="font-mono text-qubit-300">${out.amount} QTC</span>
    </div>`;
  }
  html += `</div></div>`;

  html += `</div>`; // close grid

  root.innerHTML = html;
}

// Address view --------------------------------------------------------------

async function renderAddress(addr: string): Promise<void> {
  const [balanceRes, utxos] = await Promise.all([
    fetchBalance(addr),
    fetchUtxos(addr),
  ]);

  let html = ``;
  html += `<h1 class="text-2xl font-bold mb-6">Address</h1>`;

  html += `<div class="bg-surface rounded-lg glow-border p-6 mb-6">
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
      <div>
        <p class="text-text-muted mb-1">Address</p>
        <p class="font-mono text-xs break-all">${addr}</p>
      </div>
      <div>
        <p class="text-text-muted mb-1">Balance</p>
        <p class="text-2xl font-bold">${balanceRes?.balance ?? 0} QTC</p>
      </div>
    </div>
  </div>`;

  html += `<h2 class="text-lg font-semibold mb-4">UTXOs (${utxos?.length ?? 0})</h2>`;
  if (utxos && utxos.length > 0) {
    html += `<div class="space-y-2">`;
    for (const u of utxos) {
      html += `<div class="bg-surface rounded-lg glow-border p-4 flex items-center justify-between">
        <div>
          ${hashLink(u.txId, 'tx')}<span class="text-text-muted">:${u.outputIndex}</span>
        </div>
        <span class="font-mono text-qubit-300">${u.amount} QTC</span>
      </div>`;
    }
    html += `</div>`;
  } else {
    html += `<p class="text-text-muted text-sm">No UTXOs for this address.</p>`;
  }

  root.innerHTML = html;
}

// Mempool view --------------------------------------------------------------

async function renderMempool(): Promise<void> {
  const txs = await fetchMempoolTxs();

  let html = `<h1 class="text-2xl font-bold mb-6">Mempool</h1>`;

  if (!txs || txs.length === 0) {
    html += `<p class="text-text-muted">Mempool is empty.</p>`;
    root.innerHTML = html;
    return;
  }

  html += `<p class="text-text-muted text-sm mb-4">${txs.length} pending transaction${txs.length !== 1 ? 's' : ''}</p>`;
  html += `<div class="space-y-3">`;
  for (const tx of txs) {
    const amount = transferAmount(tx, tx.sender);
    html += `<div class="bg-surface rounded-lg glow-border p-4 flex items-center justify-between">
      <div class="flex items-center gap-3">
        ${txTypeBadge(tx)}
        ${hashLink(tx.id, 'tx')}
      </div>
      <div class="text-right">
        <span class="text-text-muted text-sm font-mono">${amount} QTC</span>
        <span class="text-text-muted text-xs ml-2">${timeAgo(tx.timestamp)}</span>
      </div>
    </div>`;
  }
  html += `</div>`;

  root.innerHTML = html;
}

// --- Search ----------------------------------------------------------------

function setupSearch(): void {
  const input = document.getElementById('search-input') as HTMLInputElement | null;
  if (!input) return;

  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = input.value.trim();
    if (!q) return;

    // Heuristic: 64-char hex → block or tx, otherwise address
    if (/^[0-9a-fA-F]{64}$/.test(q)) {
      // Try block first, then tx
      const block = await fetchBlock(q);
      if (block) {
        location.hash = `#/block/${q}`;
      } else {
        const tx = await fetchTx(q);
        if (tx) {
          location.hash = `#/tx/${q}`;
        } else {
          // Could be an address (SHA-256 derived = 64 hex)
          location.hash = `#/address/${q}`;
        }
      }
    } else {
      // Treat as address
      location.hash = `#/address/${q}`;
    }

    input.value = '';
  });
}

// --- Router dispatch -------------------------------------------------------

let refreshTimer: ReturnType<typeof setInterval> | null = null;

async function dispatch(): Promise<void> {
  // Clear any existing refresh timer
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  // If not an explorer route, show landing page
  if (!isExplorerRoute()) {
    showLanding();
    return;
  }

  showExplorer();
  renderLoading();

  const route = parseRoute();
  switch (route.view) {
    case 'mempool':
      await renderDashboard();
      break;
    case 'dashboard':
      // #/ alone → show landing
      showLanding();
      return;
    case 'block':
      await renderBlock(route.hash);
      break;
    case 'tx':
      await renderTx(route.txid);
      break;
    case 'address':
      await renderAddress(route.addr);
      break;
  }
}

// --- Init ------------------------------------------------------------------

window.addEventListener('hashchange', dispatch);
setupSearch();
dispatch();
