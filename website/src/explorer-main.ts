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
  const valClass = small ? 'text-sm font-bold font-mono truncate' : 'text-xl font-bold';
  return `<div class="bg-surface px-4 py-3 rounded-lg glow-border overflow-hidden">
    <p class="text-text-muted text-xs mb-0.5">${label}</p>
    <p class="${valClass}" title="${value}">${value}</p>
  </div>`;
}

// --- Router ----------------------------------------------------------------

type Route =
  | { view: 'dashboard' }
  | { view: 'block'; hash: string }
  | { view: 'tx'; txid: string }
  | { view: 'address'; addr: string }
  | { view: 'mempool' }
  | { view: 'docs'; section?: string };

function parseRoute(): Route {
  const hash = location.hash || '#/';
  const parts = hash.slice(2).split('/'); // strip "#/"

  if (parts[0] === 'block' && parts[1]) return { view: 'block', hash: parts[1] };
  if (parts[0] === 'tx' && parts[1]) return { view: 'tx', txid: parts[1] };
  if (parts[0] === 'address' && parts[1]) return { view: 'address', addr: parts[1] };
  if (parts[0] === 'mempool') return { view: 'mempool' };
  if (parts[0] === 'docs') return { view: 'docs', section: parts[1] };
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

  let html = `<h1 class="text-3xl font-bold mb-6">Explorer</h1>`;

  // Status cards — single compact grid
  const cards: string[] = [
    card('Height', status.height),
    card('Hashrate', formatHashrate(status.hashrate)),
    card('Difficulty', formatDifficulty(status.difficulty)),
    card('Avg Block Time', formatDuration(status.avgBlockTime)),
    card('Next Block', blockEta(status.lastBlockTime, status.targetBlockTime)),
    card('Peers', status.peers),
    card('Block Reward', status.blockReward + ' QTC'),
    card('Total Txs', status.totalTxs),
  ];
  if (claimStats && claimStats.totalEntries > 0) {
    cards.push(card('BTC Fork Block', claimStats.btcBlockHeight.toLocaleString()));
    cards.push(card('Claimed BTC', claimStats.claimedAmount.toLocaleString() + ' QTC'));
  }
  html += `<div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">${cards.join('')}</div>`;

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

// --- Docs ------------------------------------------------------------------

const DOC_SECTIONS: { id: string; title: string; icon: string; render: () => string }[] = [
  { id: 'overview', title: 'Overview', icon: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/>', render: renderDocsOverview },
  { id: 'getting-started', title: 'Getting Started', icon: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>', render: renderDocsGettingStarted },
  { id: 'architecture', title: 'Architecture', icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>', render: renderDocsArchitecture },
  { id: 'btc-claims', title: 'BTC Claims', icon: '<path d="M11.5 3v2m0 14v2m3-18v2m0 14v2"/><path d="M9 7h5.5a2.5 2.5 0 010 5H9V7zm0 5h6.5a2.5 2.5 0 010 5H9v-5z"/>', render: renderDocsClaims },
  { id: 'consensus', title: 'Consensus', icon: '<path d="M9 12l2 2 4-4"/><path d="M12 3a9 9 0 11-9 9 9 9 0 019-9z"/><path d="M12 7v1m0 8v1m4-5h1M6 12h1"/>', render: renderDocsConsensus },
  { id: 'api', title: 'API Reference', icon: '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>', render: renderDocsApi },
  { id: 'p2p', title: 'P2P Protocol', icon: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98"/>', render: renderDocsP2p },
];

function docCode(code: string): string {
  return `<div class="bg-bg rounded-lg p-4 font-mono text-xs text-text-muted overflow-x-auto border border-border my-3"><pre class="whitespace-pre-wrap">${code}</pre></div>`;
}

function docJson(json: string): string {
  // Syntax-highlight JSON: keys, strings, numbers, booleans, null
  const highlighted = json
    .replace(/("(?:[^"\\]|\\.)*")(\s*:)/g, '<span class="text-qubit-300">$1</span>$2')  // keys
    .replace(/:\s*("(?:[^"\\]|\\.)*")/g, ': <span class="text-entropy-cyan">$1</span>')  // string values
    .replace(/:\s*(\d+\.?\d*)/g, ': <span class="text-qubit-400">$1</span>')              // numbers
    .replace(/:\s*(true|false)/g, ': <span class="text-green-400">$1</span>')              // booleans
    .replace(/:\s*(null)/g, ': <span class="text-text-muted/50">$1</span>')                // null
    .replace(/\/\/.*/g, (m) => `<span class="text-text-muted/40 italic">${m}</span>`);     // comments
  return `<div class="bg-bg rounded-lg p-4 font-mono text-xs overflow-x-auto border border-border my-3"><pre class="whitespace-pre-wrap text-text-muted">${highlighted}</pre></div>`;
}

function docSteps(items: string[]): string {
  const lis = items.map(item =>
    `<li class="pl-1">${item}</li>`
  ).join('\n  ');
  return `<div class="bg-surface rounded-lg glow-border p-4 mb-4">
<ol class="text-text-secondary text-sm leading-relaxed list-decimal list-inside space-y-3">
  ${lis}
</ol>
</div>`;
}

function docH2(text: string): string {
  return `<h2 class="text-xl font-bold mt-8 mb-3">${text}</h2>`;
}

function docH3(text: string): string {
  return `<h3 class="text-base font-semibold mt-6 mb-2 text-qubit-300">${text}</h3>`;
}

function docP(text: string): string {
  return `<p class="text-text-secondary text-sm leading-relaxed mb-3">${text}</p>`;
}

function renderDocsOverview(): string {
  return `<h1 class="text-2xl font-bold mb-6">Overview</h1>
${docP('QubitCoin (QTC) is a post-quantum fork of Bitcoin. It replaces ECDSA secp256k1 with <span class="text-qubit-400 font-mono text-xs">ML-DSA-65</span> (Dilithium) — a NIST-standardized lattice-based digital signature algorithm that resists both classical and quantum attacks.')}
${docP('Bitcoin holders can claim their QTC by proving ECDSA ownership of a BTC address. The claimed balance is bound to a new ML-DSA-65 public key, creating quantum-safe UTXOs. No trust or intermediaries required.')}

${docH2('The Quantum Threat')}
${docP('Every Bitcoin transaction today is secured by ECDSA on the secp256k1 curve. The security of this scheme relies on the discrete logarithm problem, which Shor\'s algorithm can solve in polynomial time on a sufficiently large quantum computer. When that day comes, every exposed public key — including every address that has ever sent a transaction — becomes vulnerable.')}
${docP('QubitCoin eliminates this threat by replacing ECDSA with ML-DSA-65, a lattice-based signature scheme whose security relies on the Module Learning With Errors (MLWE) problem. No known quantum algorithm can efficiently solve MLWE.')}

${docH2('Key Properties')}
<ul class="text-text-secondary text-sm leading-relaxed mb-3 list-disc list-inside space-y-2">
  <li><span class="text-text-primary font-medium">Quantum-safe signatures</span> — ML-DSA-65 (FIPS 204), NIST security level 3. Based on the Module-LWE problem, resistant to both classical and quantum attacks.</li>
  <li><span class="text-text-primary font-medium">Bitcoin UTXO model</span> — same unspent transaction output design. Transactions consume UTXOs as inputs and create new UTXOs as outputs.</li>
  <li><span class="text-text-primary font-medium">SHA-256 proof-of-work</span> — quantum computers can only achieve a quadratic speedup via Grover\'s algorithm, reducing SHA-256 to 128-bit quantum security — still practically unbreakable.</li>
  <li><span class="text-text-primary font-medium">Real BTC snapshot</span> — genesis commits to a merkle root of 43,235,452 aggregated address balances from BTC block 935,941.</li>
  <li><span class="text-text-primary font-medium">One-time ECDSA claims</span> — prove BTC ownership with a secp256k1 signature, receive your full address balance as quantum-safe QTC. 1:1 ratio.</li>
  <li><span class="text-text-primary font-medium">Open source</span> — TypeScript / Node.js. Run a node, mine blocks, and verify the chain yourself.</li>
</ul>

${docH2('How It Differs from Bitcoin')}
<div class="overflow-x-auto">
<table class="w-full text-sm mb-4">
  <thead><tr class="text-xs text-text-muted border-b border-border">
    <th class="text-left font-normal pb-2 pr-4"></th>
    <th class="text-left font-normal pb-2 pr-4">Bitcoin</th>
    <th class="text-left font-normal pb-2">QubitCoin</th>
  </tr></thead>
  <tbody>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Signatures</td><td class="py-2 pr-4">ECDSA secp256k1</td><td class="py-2 text-qubit-400">ML-DSA-65 (FIPS 204)</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Public key size</td><td class="py-2 pr-4">33 bytes</td><td class="py-2">1,952 bytes</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Signature size</td><td class="py-2 pr-4">71-73 bytes</td><td class="py-2">3,309 bytes</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Quantum safe</td><td class="py-2 pr-4 text-red-400">No</td><td class="py-2 text-green-400">Yes</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Mining</td><td class="py-2 pr-4">SHA-256 PoW</td><td class="py-2">SHA-256 PoW (same)</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Block time</td><td class="py-2 pr-4">10 minutes</td><td class="py-2">30 minutes</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">UTXO model</td><td class="py-2 pr-4">Yes</td><td class="py-2">Yes (same)</td></tr>
    <tr class="border-b border-border last:border-0"><td class="py-2 pr-4 text-text-muted">Address format</td><td class="py-2 pr-4">Base58 / Bech32</td><td class="py-2">64-char hex (SHA-256 of pubkey)</td></tr>
  </tbody>
</table>
</div>

${docH2('Supply')}
${docP('QubitCoin has no premine. The genesis block commits to the BTC snapshot but mints zero coins. All initial supply comes from BTC holders claiming their balances (12,736,980.37 QTC claimable). New supply enters circulation through mining rewards at 3.125 QTC per block, halving every 210,000 blocks.')}`;
}

function renderDocsGettingStarted(): string {
  return `<h1 class="text-2xl font-bold mb-6">Getting Started</h1>
${docP('Get a QubitCoin node running in under 5 minutes.')}

${docH2('Requirements')}
<ul class="text-text-secondary text-sm leading-relaxed mb-3 list-disc list-inside space-y-1">
  <li><span class="text-text-primary font-medium">Node.js 20+</span></li>
  <li><span class="text-text-primary font-medium">pnpm</span> — install with <span class="font-mono text-xs text-qubit-400">npm install -g pnpm</span></li>
</ul>

${docH2('Install')}
${docCode(`git clone https://github.com/qubitcoin-finance/qubitcoin.git
cd qubitcoin
pnpm install`)}

${docH2('Quick Start — Join the Network')}
${docP('The fastest way to get started. The <span class="font-mono text-xs text-qubit-400">--full</span> flag auto-downloads the BTC snapshot (~2.4 GB) from the seed node and starts mining immediately:')}
${docCode(`pnpm run qtcd -- --mine --full`)}
${docP('This will:')}
<ol class="text-text-secondary text-sm leading-relaxed mb-3 list-decimal list-inside space-y-1">
  <li>Download the BTC snapshot from <span class="font-mono text-xs text-qubit-400">qubitcoin.finance/snapshot/qtc-snapshot.jsonl</span></li>
  <li>Connect to the seed node at <span class="font-mono text-xs text-qubit-400">qubitcoin.finance:6001</span></li>
  <li>Sync the blockchain via Initial Block Download (IBD)</li>
  <li>Generate a mining wallet and start mining blocks</li>
</ol>
${docP('Your node\'s RPC API will be available at <span class="font-mono text-xs text-qubit-400">http://127.0.0.1:3001/api/v1/status</span>.')}

${docH2('Manual Snapshot')}
${docP('If you already have a snapshot file, provide it directly:')}
${docCode(`pnpm run qtcd -- --mine --snapshot ~/qtc-snapshot.jsonl`)}

${docH2('Local Development')}
${docP('Run an isolated local chain with easy difficulty and simulated transactions — useful for development and testing:')}
${docCode(`pnpm run qtcd -- --mine --local --simulate`)}

${docH3('Multi-Node Local Network')}
${docP('Spin up a local 3-node network to test P2P, IBD, and block relay:')}
${docCode(`# Terminal 1 — Alice (miner, seed)
pnpm run node:alice

# Terminal 2 — Bob (connects to Alice)
pnpm run node:bob

# Terminal 3 — Charlie (connects to Alice + Bob)
pnpm run node:charlie`)}
${docP('Alice mines on port 3001/6001, Bob on 3002/6002, Charlie on 3003/6003. Bob and Charlie connect to Alice as a seed and sync automatically.')}

${docH2('Claiming BTC')}
${docP('If you hold BTC in a P2PKH or P2WPKH address included in the snapshot, you can claim your balance as QTC:')}
${docCode(`pnpm run claim`)}
${docP('The interactive claim tool walks you through generating a QTC wallet, signing a claim message, and broadcasting the transaction. Accepts seed phrases, WIF keys, or hex keys. See the <a href="#/docs/btc-claims" class="text-qubit-400 hover:text-qubit-300">BTC Claims</a> section for details.')}
${docP('For air-gapped workflows, you can split the process: <span class="font-mono text-xs text-qubit-400">pnpm run claim:generate</span> creates the signed transaction offline, and <span class="font-mono text-xs text-qubit-400">pnpm run claim:send</span> broadcasts it from an online machine.')}

${docH2('CLI Reference')}
<div class="overflow-x-auto">
<table class="w-full text-sm mb-4">
  <thead><tr class="text-xs text-text-muted border-b border-border">
    <th class="text-left font-normal pb-2 pr-4">Flag</th>
    <th class="text-left font-normal pb-2 pr-4">Default</th>
    <th class="text-left font-normal pb-2">Description</th>
  </tr></thead>
  <tbody>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">--port &lt;n&gt;</td><td class="py-2 pr-4 text-text-muted">3001</td><td class="py-2">RPC HTTP port</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">--p2p-port &lt;n&gt;</td><td class="py-2 pr-4 text-text-muted">6001</td><td class="py-2">P2P TCP port</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">--snapshot &lt;path&gt;</td><td class="py-2 pr-4 text-text-muted">—</td><td class="py-2">Path to BTC snapshot NDJSON file</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">--datadir &lt;path&gt;</td><td class="py-2 pr-4 text-text-muted">data/node</td><td class="py-2">Directory for blocks.jsonl and metadata</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">--seeds &lt;h:p,...&gt;</td><td class="py-2 pr-4 text-text-muted">qubitcoin.finance:6001</td><td class="py-2">Comma-separated seed peers</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">--mine</td><td class="py-2 pr-4 text-text-muted">off</td><td class="py-2">Enable async non-blocking mining</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">--full</td><td class="py-2 pr-4 text-text-muted">off</td><td class="py-2">Auto-download snapshot if missing, start as full node</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">--local</td><td class="py-2 pr-4 text-text-muted">off</td><td class="py-2">Isolated chain — no default seed peer</td></tr>
    <tr class="border-b border-border last:border-0"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">--simulate</td><td class="py-2 pr-4 text-text-muted">off</td><td class="py-2">Dev mode: pinned easy difficulty, fake transactions</td></tr>
  </tbody>
</table>
</div>

${docH2('Useful Commands')}
${docCode(`# Check node status
curl -s http://127.0.0.1:3001/api/v1/status | jq

# View connected peers
curl -s http://127.0.0.1:3001/api/v1/peers | jq

# Get latest blocks
curl -s http://127.0.0.1:3001/api/v1/blocks?count=5 | jq

# Run the test suite
pnpm test`)}`;
}

function renderDocsArchitecture(): string {
  return `<h1 class="text-2xl font-bold mb-6">Architecture</h1>
${docP('QubitCoin preserves Bitcoin\'s proven architecture while upgrading the signature scheme to be quantum-safe. This section covers the core building blocks.')}

${docH2('UTXO Model')}
${docP('Like Bitcoin, QubitCoin uses unspent transaction outputs (UTXOs). Each transaction consumes existing UTXOs as inputs and creates new UTXOs as outputs. To spend a UTXO, the owner must provide a valid ML-DSA-65 signature proving ownership of the corresponding private key.')}
${docH3('Transaction Structure')}
${docCode(`Transaction {
  id:         string          // doubleSha256(inputs + outputs + timestamp)
  inputs:     TxInput[]       // UTXOs being spent
  outputs:    TxOutput[]      // new UTXOs being created
  timestamp:  number          // unix ms
  claimData?: ClaimData       // present only for BTC claim txs
}

TxInput {
  txId:        string         // 64-char hex — references the source tx
  outputIndex: number         // which output of that tx
  publicKey:   Uint8Array     // 1,952 bytes (ML-DSA-65)
  signature:   Uint8Array     // 3,309 bytes (ML-DSA-65)
}

TxOutput {
  address: string             // 64-char hex — SHA-256(publicKey)
  amount:  number             // QTC amount
}`)}
${docH3('Transaction Validation')}
<ol class="text-text-secondary text-sm leading-relaxed mb-3 list-decimal list-inside space-y-1">
  <li>Check no duplicate inputs (no double-spend within a tx)</li>
  <li>For each input: verify UTXO exists and <span class="font-mono text-xs text-entropy-cyan">SHA-256(publicKey) == utxo.address</span></li>
  <li>Verify ML-DSA-65 signature against the transaction sighash</li>
  <li>Check <span class="font-mono text-xs text-qubit-400">totalInputs &ge; totalOutputs</span> (difference is the miner fee)</li>
  <li>Verify all output amounts are positive</li>
  <li>Verify txid matches recomputed hash</li>
</ol>

${docH3('Signing Process')}
${docP('Signatures cover inputs (outpoints only, no pubkeys/sigs), all outputs, timestamp, and claimData if present. The txid is computed from the same data — excluding signatures — making it a <span class="text-text-primary font-medium">non-malleable</span> transaction identifier.')}

${docH2('ML-DSA-65 Signatures')}
${docP('All ongoing transaction signatures use <span class="text-qubit-400 font-mono text-xs">ML-DSA-65</span> (FIPS 204), a lattice-based scheme standardized by NIST. Its security relies on the Module Learning With Errors (MLWE) problem — no known quantum algorithm can efficiently solve it.')}
<div class="overflow-x-auto">
<table class="w-full text-sm mb-4">
  <tbody>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Public key</td><td class="py-2 font-mono text-qubit-300">1,952 bytes</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Secret key</td><td class="py-2 font-mono text-qubit-300">4,032 bytes</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Signature</td><td class="py-2 font-mono text-qubit-300">3,309 bytes</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Security level</td><td class="py-2 font-mono text-entropy-cyan">NIST Level 3 (128-bit quantum)</td></tr>
    <tr class="border-b border-border last:border-0"><td class="py-2 pr-4 text-text-muted">Address derivation</td><td class="py-2 font-mono text-qubit-300">SHA-256(publicKey) → 64-char hex</td></tr>
  </tbody>
</table>
</div>
${docP('The larger key and signature sizes (vs ECDSA\'s 33-byte keys and ~72-byte signatures) are the tradeoff for quantum resistance. The 1 MB max block size accommodates fewer transactions per block, but the 30-minute block time and fee market ensure throughput.')}

${docH2('SHA-256 Proof-of-Work')}
${docP('Mining uses double-SHA-256, identical to Bitcoin. The block header (112 bytes) is serialized and hashed; the result must be below the current difficulty target.')}
${docH3('Why SHA-256 is Quantum-Safe for PoW')}
${docP('Grover\'s algorithm provides a quadratic speedup for hash inversion — reducing SHA-256 from 256-bit to 128-bit quantum security. A quantum computer would need roughly 2<sup>128</sup> operations to find a valid nonce, which is still computationally infeasible. This means SHA-256 PoW remains secure even in a post-quantum world.')}
${docH3('Block Header')}
${docCode(`Header (112 bytes):
  version:      4 bytes   (uint32)
  previousHash: 32 bytes  (SHA-256)
  merkleRoot:   32 bytes  (SHA-256 merkle tree of txids)
  timestamp:    8 bytes   (uint64, unix ms)
  target:       32 bytes  (difficulty target, hex)
  nonce:        4 bytes   (uint32, 0 → 4,294,967,295)`)}
${docP('When the nonce space is exhausted (2<sup>32</sup> values), the miner bumps the timestamp by 1ms and resets the nonce — providing an effectively unlimited search space.')}

${docH2('Block Validation')}
${docP('Every block goes through strict validation before being accepted into the chain:')}
<ol class="text-text-secondary text-sm leading-relaxed mb-3 list-decimal list-inside space-y-1">
  <li><span class="text-text-primary font-medium">Target check</span> — block\'s target must exactly match the chain\'s current difficulty</li>
  <li><span class="text-text-primary font-medium">PoW check</span> — block hash &lt; target</li>
  <li><span class="text-text-primary font-medium">Chain link</span> — previousHash matches the tip</li>
  <li><span class="text-text-primary font-medium">Merkle root</span> — recomputed from transactions</li>
  <li><span class="text-text-primary font-medium">Block size</span> — &le; 1,000,000 bytes (1 MB)</li>
  <li><span class="text-text-primary font-medium">Coinbase</span> — first tx must be coinbase, no duplicates</li>
  <li><span class="text-text-primary font-medium">Transactions</span> — each validated for signatures, UTXO existence, no double-spends</li>
  <li><span class="text-text-primary font-medium">Claims</span> — ECDSA proof verified, address not already claimed</li>
</ol>

${docH2('Fork Genesis')}
${docP('QubitCoin uses a special version-2 genesis block that commits to the BTC UTXO snapshot. No coins are minted at genesis — all initial supply comes from claims.')}
${docCode(`Genesis coinbase publicKey field:
  "QCOIN_FORK:{btcBlockHeight}:{btcBlockHash}:{snapshotMerkleRoot}"

Example:
  "QCOIN_FORK:935941:00000...abc:a2c2ddc7...c61af1"`)}
${docP('Any node can independently verify that the snapshot data matches the committed merkle root, ensuring the fork is trustless.')}

${docH2('Persistence & Replay')}
${docP('Blocks are stored in NDJSON format — one JSON object per line — enabling efficient append-only writes and streaming reads.')}
${docCode(`data/node/
  blocks.jsonl     # one block per line (append-only)
  metadata.json    # { height, tipHash, difficulty }`)}
${docP('On startup, the blockchain replays all stored blocks from genesis to reconstruct the full UTXO set, claim state, and difficulty. This ensures the node state is always derivable from the block data alone.')}
${docH3('Reorg Support')}
${docP('Each applied block produces an undo record capturing spent UTXOs, created UTXO keys, claimed addresses, and the previous difficulty. Reorgs up to 100 blocks deep can be performed efficiently by disconnecting blocks using their undo data, then applying the new chain.')}`;
}

function renderDocsClaims(): string {
  return `<h1 class="text-2xl font-bold mb-6">BTC Claims</h1>
${docP('BTC holders migrate to QubitCoin by submitting a claim transaction that proves ownership of a Bitcoin address. Your full aggregated BTC balance becomes quantum-safe QTC — no trust, no intermediaries.')}

${docH2('Quick Start')}
${docP('The easiest way to claim is with the interactive CLI tool:')}
${docCode(`pnpm run claim`)}
${docP('This walks you through every step: generating a QTC wallet, signing the claim message, and broadcasting the transaction to the network. You\'ll need one of the following for a BTC address included in the snapshot:')}
<ul class="text-text-secondary text-sm leading-relaxed mb-3 list-disc list-inside space-y-1">
  <li><span class="text-text-primary font-medium">Seed phrase</span> — 12 or 24 word BIP39 mnemonic (the tool derives addresses from BIP44/BIP84 paths and lets you pick)</li>
  <li><span class="text-text-primary font-medium">WIF key</span> — Bitcoin private key in Wallet Import Format (starts with 5, K, or L)</li>
  <li><span class="text-text-primary font-medium">Hex key</span> — raw 32-byte private key as 64 hex characters</li>
</ul>

${docH3('Air-Gapped Workflow')}
${docP('For maximum security, you can split the claim into an offline step (signing) and an online step (broadcasting). Your private key never touches an internet-connected machine.')}
${docCode(`# Step 1: On an OFFLINE machine — generate the signed claim tx
pnpm run claim:generate
# → saves claim-{address}-{timestamp}.json

# Step 2: Copy the JSON file to an ONLINE machine

# Step 3: Broadcast to the network
pnpm run claim:send claim-abc12345-1707000000.json`)}

${docH2('How It Works')}
${docH3('Step 1 — Generate a QTC Wallet')}
${docP('Create a new ML-DSA-65 keypair. This gives you a quantum-safe public key (1,952 bytes) and a QTC address (SHA-256 hash of the public key, 64-char hex).')}

${docH3('Step 2 — Sign the Claim Message')}
${docP('Construct a claim message and sign it with your Bitcoin private key (ECDSA secp256k1):')}
${docCode(`message = "QTC_CLAIM:{btcAddress}:{qtcAddress}:{snapshotBlockHash}"
msgHash = doubleSha256(message)
signature = secp256k1.sign(msgHash, btcPrivateKey)`)}
${docP('The snapshot block hash acts as replay protection — the claim is bound to a specific snapshot and cannot be reused on a different fork.')}

${docH3('Step 3 — Broadcast the Claim Transaction')}
${docP('Submit a claim transaction containing your ECDSA signature, compressed BTC public key (33 bytes), and destination QTC address. The transaction uses a special sentinel input (<span class="font-mono text-xs text-qubit-400">cccc...cccc</span>) to identify it as a claim.')}

${docH3('Step 4 — Network Verification')}
${docP('Every node independently verifies:')}
<ol class="text-text-secondary text-sm leading-relaxed mb-3 list-decimal list-inside space-y-1">
  <li><span class="font-mono text-xs text-entropy-cyan">HASH160(ecdsaPublicKey) == btcAddress</span> — proves the public key belongs to the address</li>
  <li>BTC address exists in the snapshot with a non-zero balance</li>
  <li>ECDSA signature is valid for the claim message</li>
  <li>Address has not been previously claimed</li>
  <li>Output amount matches the snapshot balance exactly</li>
  <li>Output address matches the qcoinAddress in the claim data</li>
</ol>

${docH3('Step 5 — QTC Credited')}
${docP('Once the claim transaction is mined into a block, your full aggregated BTC balance appears as a quantum-safe UTXO at your QTC address. From here, all future transactions use ML-DSA-65 signatures.')}

${docH2('Rules')}
<div class="bg-surface rounded-lg glow-border p-4 mb-4">
<ul class="text-text-secondary text-sm leading-relaxed list-disc list-inside space-y-2">
  <li><span class="text-text-primary font-medium">One claim per address</span> — once a BTC address is claimed, it\'s marked permanently. The same address cannot be claimed again, even with a different QTC destination.</li>
  <li><span class="text-text-primary font-medium">Aggregated balance</span> — claims are per-address, not per-UTXO. All UTXOs belonging to a BTC address are summed into a single balance. You get everything in one claim.</li>
  <li><span class="text-text-primary font-medium">Supported address types</span> — only P2PKH and P2WPKH addresses can be claimed. P2SH, P2WSH, P2TR, bare multisig, and other types are excluded from the snapshot.</li>
  <li><span class="text-text-primary font-medium">1:1 ratio</span> — 1 BTC = 1 QTC. No conversion rate, no fees, no slippage.</li>
  <li><span class="text-text-primary font-medium">Double-claim prevention</span> — the mempool also rejects claim transactions for addresses that already have a pending claim, preventing double-claims before mining.</li>
</ul>
</div>

${docH2('Snapshot')}
${docP('The current snapshot is derived from a Bitcoin Core <span class="font-mono text-xs text-entropy-cyan">dumptxoutset</span> at block 935,941. The full pipeline:')}
<ol class="text-text-secondary text-sm leading-relaxed mb-3 list-decimal list-inside space-y-1">
  <li>Dump the UTXO set from Bitcoin Core (8.8 GB binary, ~164M coins)</li>
  <li>Parse and filter to P2PKH + P2WPKH outputs only (~92M coins)</li>
  <li>Aggregate by address using external sort + streaming merge (constant memory)</li>
  <li>Compute merkle root and write final NDJSON snapshot</li>
</ol>
<div class="overflow-x-auto">
<table class="w-full text-sm mb-4">
  <tbody>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">BTC block height</td><td class="py-2 font-mono text-qubit-300">935,941</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Raw UTXOs parsed</td><td class="py-2 font-mono">164,352,533</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">After filtering</td><td class="py-2 font-mono">92,062,776 (P2PKH + P2WPKH only)</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Unique addresses</td><td class="py-2 font-mono text-entropy-cyan">43,235,452</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Total claimable</td><td class="py-2 font-mono text-qubit-300">12,736,980.37 QTC</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">P2PKH coins</td><td class="py-2 font-mono">45,115,135</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">P2WPKH coins</td><td class="py-2 font-mono">46,947,641</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Snapshot size</td><td class="py-2 font-mono">2.4 GB (NDJSON)</td></tr>
    <tr class="border-b border-border last:border-0"><td class="py-2 pr-4 text-text-muted">Merkle root</td><td class="py-2 font-mono text-xs break-all">a2c2ddc7456df15c0a22c7b7ebafd30e9e75abf352f3844af160eb205bc61af1</td></tr>
  </tbody>
</table>
</div>

${docH2('Why Not All BTC?')}
${docP('The snapshot contains ~12.7M BTC out of ~19.8M circulating supply. The ~7.1M BTC gap is because ~72M UTXOs were filtered out — they belong to address types we don\'t support for claiming: P2SH (multisig wallets), P2WSH, P2TR (Taproot), bare multisig, and other exotic script types. Only P2PKH and P2WPKH addresses have a straightforward public key derivation path that enables trustless ECDSA claim proofs.')}`;
}

function renderDocsConsensus(): string {
  return `<h1 class="text-2xl font-bold mb-6">Consensus</h1>
${docP('QubitCoin\'s consensus rules define block timing, difficulty adjustment, supply schedule, and validation criteria. These parameters are enforced by every node — changing them breaks compatibility with existing chains.')}

${docH2('Core Parameters')}
<div class="overflow-x-auto">
<table class="w-full text-sm mb-4">
  <thead><tr class="text-xs text-text-muted border-b border-border">
    <th class="text-left font-normal pb-2 pr-4">Parameter</th>
    <th class="text-left font-normal pb-2 pr-4">Value</th>
    <th class="text-left font-normal pb-2">Description</th>
  </tr></thead>
  <tbody>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">STARTING_DIFFICULTY</td><td class="py-2 pr-4 font-mono text-xs">0000000fff...fff</td><td class="py-2 text-text-muted">Easiest allowed target (difficulty floor)</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">TARGET_BLOCK_TIME_MS</td><td class="py-2 pr-4">30 minutes</td><td class="py-2 text-text-muted">Target time between blocks (1,800,000 ms)</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">DIFFICULTY_ADJUSTMENT_INTERVAL</td><td class="py-2 pr-4">10 blocks</td><td class="py-2 text-text-muted">Blocks between difficulty recalculations</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">MAX_BLOCK_SIZE</td><td class="py-2 pr-4">1,000,000 bytes</td><td class="py-2 text-text-muted">Maximum serialized block size (1 MB)</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">INITIAL_SUBSIDY</td><td class="py-2 pr-4">3.125 QTC</td><td class="py-2 text-text-muted">Block reward at launch</td></tr>
    <tr class="border-b border-border last:border-0"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">HALVING_INTERVAL</td><td class="py-2 pr-4">210,000 blocks</td><td class="py-2 text-text-muted">Blocks between reward halvings</td></tr>
  </tbody>
</table>
</div>

${docH2('Difficulty Adjustment')}
${docP('Every 10 blocks, the network recalculates the mining difficulty target. The algorithm compares the actual time taken for the last interval to the expected time:')}
${docCode(`expectedTime = (DIFFICULTY_ADJUSTMENT_INTERVAL - 1) × TARGET_BLOCK_TIME
             = 9 × 30 min = 270 min

actualTime = latestBlock.timestamp - intervalStartBlock.timestamp
ratio = actualTime / expectedTime

// Clamp to prevent extreme swings
ratio = clamp(ratio, 0.25, 4.0)

newTarget = currentTarget × ratio
newTarget = min(newTarget, STARTING_DIFFICULTY)  // never easier than floor
newTarget = max(newTarget, 1)                    // never zero`)}
${docP('If blocks come too fast (ratio &lt; 1), the target decreases, making mining harder. If blocks come too slow (ratio &gt; 1), the target increases, making mining easier. The 4x clamp prevents difficulty from changing by more than a factor of 4 in a single adjustment.')}

${docH2('Block Reward & Supply')}
${docH3('Coinbase Reward')}
${docP('Every block includes a coinbase transaction that mints new QTC. The reward starts at <span class="font-mono text-xs text-qubit-400">3.125 QTC</span> per block — matching Bitcoin\'s post-4th-halving reward schedule.')}
${docCode(`blockSubsidy(height) = INITIAL_SUBSIDY / 2^(height / HALVING_INTERVAL)
                     = 3.125 / 2^(height / 210,000)

Height 0–209,999:       3.125 QTC
Height 210,000–419,999: 1.5625 QTC
Height 420,000–629,999: 0.78125 QTC
...
After 26 halvings:      0 QTC (all subsidy exhausted)`)}
${docP('Miners also collect transaction fees — the difference between total inputs and total outputs for non-coinbase transactions in the block.')}

${docH3('Supply Schedule')}
${docP('New QTC enters circulation from two sources:')}
<ul class="text-text-secondary text-sm leading-relaxed mb-3 list-disc list-inside space-y-1">
  <li><span class="text-text-primary font-medium">BTC claims</span> — 12,736,980.37 QTC claimable from the snapshot (P2PKH + P2WPKH only; ~7.1M BTC in unsupported address types is excluded)</li>
  <li><span class="text-text-primary font-medium">Mining rewards</span> — 3.125 QTC per block, halving every 210,000 blocks</li>
</ul>
${docP('There is no premine, no ICO, and no team allocation. All coins come from either BTC claims or mining.')}

${docH2('Mining')}
${docH3('Proof-of-Work')}
${docP('Mining uses double-SHA-256 on the 112-byte block header. A valid block must satisfy:')}
${docCode(`BigInt('0x' + blockHash) &lt; BigInt('0x' + target)`)}
${docP('Miners iterate the 32-bit nonce (0 to 4,294,967,295). If the nonce space is exhausted without finding a valid hash, the timestamp is bumped by 1ms and the nonce resets — providing an unlimited search space.')}

${docH3('Async Mining')}
${docP('The node daemon uses non-blocking async mining via <span class="font-mono text-xs text-qubit-400">mineBlockAsync()</span>. It processes nonces in batches of 5,000, yielding to the event loop between batches with <span class="font-mono text-xs text-qubit-400">setImmediate()</span>. This keeps the node responsive for P2P messages, RPC requests, and incoming blocks.')}
${docP('When a new block arrives from a peer, the in-progress mining is aborted via <span class="font-mono text-xs text-qubit-400">AbortController</span> and restarted with the new chain tip — ensuring miners always work on the latest block.')}

${docH3('Block Assembly')}
<ol class="text-text-secondary text-sm leading-relaxed mb-3 list-decimal list-inside space-y-1">
  <li>Collect pending transactions from the mempool</li>
  <li>Reserve space for the header (112 bytes) and coinbase (~80 bytes)</li>
  <li>Pack transactions until the 1 MB block size limit</li>
  <li>Compute total fees from included transactions</li>
  <li>Create coinbase: <span class="font-mono text-xs text-qubit-400">blockSubsidy(height) + totalFees</span></li>
  <li>Compute merkle root from all transaction IDs</li>
  <li>Build header with current difficulty target and begin mining</li>
</ol>

${docH2('Consensus-Critical Warning')}
<div class="bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-4">
  <p class="text-red-400 text-sm font-medium mb-2">Do not modify consensus parameters</p>
  <p class="text-text-secondary text-sm leading-relaxed">Changing <span class="font-mono text-xs">STARTING_DIFFICULTY</span>, <span class="font-mono text-xs">TARGET_BLOCK_TIME_MS</span>, or <span class="font-mono text-xs">DIFFICULTY_ADJUSTMENT_INTERVAL</span> breaks existing chains. Stored blocks fail replay because <span class="font-mono text-xs">addBlock</span> validates <span class="font-mono text-xs">block.header.target === chain.difficulty</span>, and <span class="font-mono text-xs">adjustDifficulty()</span> depends on these values. Any change requires wiping chain data on <strong>all nodes</strong> or implementing a height-activated hard fork.</p>
</div>`;
}

function renderDocsApi(): string {
  const ep = (method: string, path: string, desc: string) =>
    `<tr class="border-b border-border last:border-0">
      <td class="py-2 pr-3"><span class="px-2 py-0.5 rounded text-xs font-medium ${method === 'GET' ? 'bg-entropy-cyan/20 text-entropy-cyan' : 'bg-qubit-600/20 text-qubit-400'}">${method}</span></td>
      <td class="py-2 pr-3 font-mono text-xs text-qubit-300">${path}</td>
      <td class="py-2 text-text-muted text-xs">${desc}</td>
    </tr>`;

  return `<h1 class="text-2xl font-bold mb-6">API Reference</h1>
${docP('All endpoints are served under <span class="font-mono text-xs text-qubit-400">/api/v1</span>. The public API is available at <span class="font-mono text-xs text-qubit-400">https://qubitcoin.finance/api/v1</span>. All responses are JSON. Uint8Array fields (public keys, signatures) are serialized as hex strings.')}

${docH2('Base URL')}
${docCode(`# Local node
http://127.0.0.1:3001/api/v1

# Public seed node
https://qubitcoin.finance/api/v1`)}

${docH2('Node Status')}
<table class="w-full text-sm mb-4">
  <tbody>
    ${ep('GET', '/status', 'Full node status')}
    ${ep('GET', '/peers', 'Connected peers list')}
    ${ep('GET', '/difficulty', 'Difficulty history (one entry per adjustment + genesis + tip)')}
  </tbody>
</table>
${docH3('GET /status')}
${docP('Returns the current state of the node.')}
${docJson(`{
  "height": 1234,
  "difficulty": "0000000fff...fff",
  "mempoolSize": 3,
  "utxoCount": 5678,
  "balance": 25.0,              // mining wallet balance (if mining)
  "address": "a1b2c3...",       // mining address (if mining)
  "mining": true,
  "peers": 4,
  "hashrate": 12500,            // estimated H/s
  "avgBlockTime": 1800000,      // ms (actual average)
  "blockReward": 3.125,
  "totalTxs": 9876,
  "lastBlockTime": 1707000000000,
  "targetBlockTime": 1800000
}`)}
${docH3('GET /peers')}
${docJson(`[
  {
    "id": "peer-1",
    "address": "1.2.3.4:6001",
    "inbound": false,
    "height": 1234
  }
]`)}
${docH3('GET /difficulty')}
${docP('Returns the difficulty history — one entry per adjustment interval, plus genesis and the current tip.')}
${docJson(`[
  { "height": 0,  "target": "00000fff...", "timestamp": 1707000000000 },
  { "height": 10, "target": "00000aff...", "timestamp": 1707018000000 }
]`)}

${docH2('Blocks')}
<table class="w-full text-sm mb-4">
  <tbody>
    ${ep('GET', '/blocks?count=N', 'Latest N blocks (default 10, most recent first)')}
    ${ep('GET', '/block/:hash', 'Block by hash (full block with transactions)')}
    ${ep('GET', '/block-by-height/:h', 'Block by height')}
  </tbody>
</table>
${docH3('GET /block/:hash')}
${docJson(`{
  "hash": "0000abc...",
  "height": 1234,
  "header": {
    "version": 1,
    "previousHash": "0000def...",
    "merkleRoot": "abc123...",
    "timestamp": 1707000000000,
    "target": "0000000fff...fff",
    "nonce": 42
  },
  "transactions": [...]
}`)}

${docH2('Transactions')}
<table class="w-full text-sm mb-4">
  <tbody>
    ${ep('GET', '/tx/:txid', 'Transaction by ID (searches chain then mempool)')}
    ${ep('POST', '/tx', 'Broadcast a signed transaction')}
  </tbody>
</table>
${docH3('POST /tx')}
${docP('Submit a signed transaction for relay and inclusion in the mempool. The request body must be a JSON transaction with hex-encoded Uint8Array fields (publicKey, signature, ecdsaPublicKey, ecdsaSignature).')}
${docCode(`curl -X POST http://127.0.0.1:3001/api/v1/tx \\
  -H "Content-Type: application/json" \\
  -d '{"id":"...","inputs":[...],"outputs":[...],"timestamp":...}'`)}
<div class="grid grid-cols-2 gap-3 my-3">
  <div class="bg-bg rounded-lg p-3 border border-green-500/20">
    <p class="text-green-400 text-xs font-medium mb-1">200 Success</p>
    <code class="text-xs font-mono text-text-muted">{ "txid": "abc123..." }</code>
  </div>
  <div class="bg-bg rounded-lg p-3 border border-red-500/20">
    <p class="text-red-400 text-xs font-medium mb-1">400 Error</p>
    <code class="text-xs font-mono text-text-muted">{ "error": "Invalid transaction: ..." }</code>
  </div>
</div>

${docH2('Mempool')}
<table class="w-full text-sm mb-4">
  <tbody>
    ${ep('GET', '/mempool/txs?limit=N', 'Pending transactions (lightweight: no sigs/pubkeys, max 1000)')}
    ${ep('GET', '/mempool/stats', 'Mempool size')}
  </tbody>
</table>
${docH3('GET /mempool/txs')}
${docP('Returns a lightweight representation of pending transactions — signatures and public keys are stripped to reduce payload size.')}
${docJson(`[
  {
    "id": "abc123...",
    "timestamp": 1707000000000,
    "sender": "def456...",         // derived from first input pubkey
    "inputs": [
      { "txId": "...", "outputIndex": 0 }
    ],
    "outputs": [
      { "address": "...", "amount": 1.5 }
    ],
    "claimData": null              // or ClaimData object
  }
]`)}

${docH2('Addresses')}
<table class="w-full text-sm mb-4">
  <tbody>
    ${ep('GET', '/address/:addr/balance', 'Total balance for an address')}
    ${ep('GET', '/address/:addr/utxos', 'All unspent outputs for an address')}
  </tbody>
</table>
${docH3('GET /address/:addr/balance')}
${docJson(`{ "balance": 15.625 }`)}
${docH3('GET /address/:addr/utxos')}
${docJson(`[
  { "txId": "abc...", "outputIndex": 0, "address": "def...", "amount": 3.125 },
  { "txId": "ghi...", "outputIndex": 1, "address": "def...", "amount": 12.5 }
]`)}

${docH2('Claims')}
<table class="w-full text-sm mb-4">
  <tbody>
    ${ep('GET', '/claims/stats', 'Claim statistics for the BTC snapshot')}
  </tbody>
</table>
${docH3('GET /claims/stats')}
${docJson(`{
  "btcBlockHeight": 935941,
  "totalEntries": 43235452,
  "claimed": 12,
  "unclaimed": 43235440,
  "claimedAmount": 150.5,
  "unclaimedAmount": 12736829.87
}`)}

${docH2('Error Handling')}
${docP('All endpoints return standard HTTP status codes:')}
<ul class="text-text-secondary text-sm leading-relaxed mb-3 list-disc list-inside space-y-1">
  <li><span class="font-mono text-xs text-green-400">200</span> — success</li>
  <li><span class="font-mono text-xs text-yellow-400">400</span> — bad request (invalid transaction, malformed input)</li>
  <li><span class="font-mono text-xs text-red-400">404</span> — resource not found (block, tx, or address)</li>
  <li><span class="font-mono text-xs text-red-400">500</span> — internal server error</li>
</ul>`;
}

function renderDocsP2p(): string {
  return `<h1 class="text-2xl font-bold mb-6">P2P Protocol</h1>
${docP('QubitCoin nodes communicate over TCP using a custom length-prefixed JSON protocol. The protocol handles peer discovery, chain synchronization, block/transaction relay, and fork resolution.')}

${docH2('Wire Format')}
${docP('Every message is framed as a 4-byte big-endian length prefix followed by a UTF-8 JSON payload:')}
${docCode(`[4 bytes: payload length (BE uint32)][JSON payload]

Maximum message size: 5 MB (5,242,880 bytes)
Protocol version: 1`)}
${docP('Messages exceeding 5 MB are rejected and the sender\'s misbehavior score is incremented.')}

${docH2('Message Types')}
<div class="overflow-x-auto">
<table class="w-full text-sm mb-4">
  <thead><tr class="text-xs text-text-muted border-b border-border">
    <th class="text-left font-normal pb-2 pr-4">Type</th>
    <th class="text-left font-normal pb-2 pr-4">Direction</th>
    <th class="text-left font-normal pb-2">Payload</th>
  </tr></thead>
  <tbody>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">version</td><td class="py-2 pr-4 text-text-muted">both</td><td class="py-2 text-xs">{ version, height, genesisHash, userAgent }</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">verack</td><td class="py-2 pr-4 text-text-muted">both</td><td class="py-2 text-xs">none — handshake acknowledgement</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">reject</td><td class="py-2 pr-4 text-text-muted">both</td><td class="py-2 text-xs">{ reason } — sent before disconnect</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">getblocks</td><td class="py-2 pr-4 text-text-muted">request</td><td class="py-2 text-xs">{ fromHeight } — request blocks starting at height</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">blocks</td><td class="py-2 pr-4 text-text-muted">response</td><td class="py-2 text-xs">{ blocks[] } — up to 50 full blocks per message</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">inv</td><td class="py-2 pr-4 text-text-muted">broadcast</td><td class="py-2 text-xs">{ type: 'block'|'tx', hash } — announce new data</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">getdata</td><td class="py-2 pr-4 text-text-muted">request</td><td class="py-2 text-xs">{ type: 'block'|'tx', hash } — request full data</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">tx</td><td class="py-2 pr-4 text-text-muted">response</td><td class="py-2 text-xs">{ tx } — full transaction</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">getheaders</td><td class="py-2 pr-4 text-text-muted">request</td><td class="py-2 text-xs">{ locatorHashes[] } — fork resolution</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">headers</td><td class="py-2 pr-4 text-text-muted">response</td><td class="py-2 text-xs">{ headers[] } — up to 500 lightweight headers</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">ping</td><td class="py-2 pr-4 text-text-muted">request</td><td class="py-2 text-xs">none — keepalive</td></tr>
    <tr class="border-b border-border last:border-0"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">pong</td><td class="py-2 pr-4 text-text-muted">response</td><td class="py-2 text-xs">none — keepalive response</td></tr>
  </tbody>
</table>
</div>

${docH2('Handshake')}
${docP('Every connection begins with a version/verack exchange. Both sides must complete the handshake within 10 seconds or the connection is dropped.')}
${docH3('Outbound')}
${docSteps([
  '<span class="text-text-primary font-medium">Connect</span> — open TCP connection, send <span class="font-mono text-xs text-entropy-cyan">version</span> message with chain height and genesis hash',
  '<span class="text-text-primary font-medium">Receive version</span> — verify peer\'s genesis hash matches ours',
  '<span class="text-text-primary font-medium">Send verack</span> — acknowledge the peer\'s version',
  '<span class="text-text-primary font-medium">Receive verack</span> — handshake complete, connection is live',
])}
${docH3('Inbound')}
${docSteps([
  '<span class="text-text-primary font-medium">Accept TCP</span> — incoming connection from a new peer',
  '<span class="text-text-primary font-medium">Receive version</span> — verify genesis hash, send own <span class="font-mono text-xs text-entropy-cyan">version</span> + <span class="font-mono text-xs text-entropy-cyan">verack</span>',
  '<span class="text-text-primary font-medium">Receive verack</span> — handshake complete',
])}
${docP('If the genesis hashes don\'t match, the connection is rejected — the peer is on a different chain. Fresh nodes (height 0) adopt the peer\'s genesis hash.')}

${docH2('Initial Block Download (IBD)')}
${docP('After handshake, if the peer has a higher chain than us, we begin IBD to sync up.')}
${docSteps([
  '<span class="text-text-primary font-medium">Compare heights</span> — peer\'s chain is taller: <span class="font-mono text-xs text-qubit-400">peer.height &gt; ourHeight</span>',
  '<span class="text-text-primary font-medium">Request blocks</span> — send <span class="font-mono text-xs text-entropy-cyan">getblocks({ fromHeight: ourHeight + 1 })</span>',
  '<span class="text-text-primary font-medium">Receive batch</span> — peer responds with up to 50 full blocks',
  '<span class="text-text-primary font-medium">Validate &amp; apply</span> — each block is validated and added to the chain sequentially',
  '<span class="text-text-primary font-medium">Continue or finish</span> — if batch was full (50 blocks), request the next batch. If partial, IBD is complete',
])}
${docP('Mining is paused during IBD and automatically resumes once the node is fully synced. This ensures miners always work on the latest chain tip.')}

${docH2('Block & Transaction Relay')}
${docP('New data propagates through the network using an inv → getdata → data flow, preventing redundant transfers.')}

${docH3('Block Relay')}
<div class="bg-surface rounded-lg glow-border p-4 mb-4">
<ol class="text-text-secondary text-sm leading-relaxed list-decimal list-inside space-y-3">
  <li><span class="text-text-primary font-medium">Miner finds block</span> — calls <span class="font-mono text-xs text-qubit-400">broadcastBlock()</span>, sends <span class="font-mono text-xs text-entropy-cyan">inv</span> to all connected peers</li>
  <li><span class="text-text-primary font-medium">Peer receives inv</span> — checks <span class="font-mono text-xs text-qubit-400">seenBlocks</span> cache. If the hash is new, sends <span class="font-mono text-xs text-entropy-cyan">getdata</span> back</li>
  <li><span class="text-text-primary font-medium">Origin responds</span> — sends a <span class="font-mono text-xs text-entropy-cyan">blocks</span> message with the full block</li>
  <li><span class="text-text-primary font-medium">Peer validates</span> — runs full block validation, adds hash to <span class="font-mono text-xs text-qubit-400">seenBlocks</span>, re-broadcasts <span class="font-mono text-xs text-entropy-cyan">inv</span> to all peers (excluding the sender)</li>
</ol>
</div>

${docH3('Transaction Relay')}
${docP('Follows the same pattern: <span class="font-mono text-xs text-entropy-cyan">inv</span> → <span class="font-mono text-xs text-entropy-cyan">getdata</span> → <span class="font-mono text-xs text-entropy-cyan">tx</span> → re-broadcast. Transactions are validated against the UTXO set and mempool before being accepted and relayed.')}

${docP('A seen-cache (LRU, max 10,000 entries) prevents processing the same block or transaction twice.')}

${docH2('Fork Resolution')}
${docP('When a node receives a block that doesn\'t extend its chain (previous hash mismatch), it initiates fork resolution:')}
<div class="bg-surface rounded-lg glow-border p-4 mb-4">
<ol class="text-text-secondary text-sm leading-relaxed list-decimal list-inside space-y-3">
  <li><span class="text-text-primary font-medium">Detect fork</span> — <span class="font-mono text-xs text-qubit-400">addBlock</span> fails with "Previous hash" error, signaling a chain split</li>
  <li><span class="text-text-primary font-medium">Build block locator</span> — construct a sparse list of block hashes:
    ${docCode(`[tip, tip-1, tip-2, tip-4, tip-8, tip-16, ..., genesis]`)}
    The exponential step-back efficiently identifies the fork point without sending the full chain</li>
  <li><span class="text-text-primary font-medium">Send getheaders</span> — transmit <span class="font-mono text-xs text-qubit-400">getheaders({ locatorHashes })</span> to the peer</li>
  <li><span class="text-text-primary font-medium">Peer responds</span> — finds the first common hash in the locator, sends headers from <span class="font-mono text-xs text-entropy-cyan">forkPoint + 1</span> to its tip (up to 500 headers)</li>
  <li><span class="text-text-primary font-medium">Verify</span> — check that <span class="font-mono text-xs text-qubit-400">reorgDepth &le; 100</span> and the peer\'s chain is strictly longer</li>
  <li><span class="text-text-primary font-medium">Execute reorg</span> — <span class="font-mono text-xs text-qubit-400">resetToHeight(forkPoint)</span> disconnects blocks using undo data, then request and apply blocks from the new chain</li>
</ol>
</div>
${docP('Reorgs deeper than <span class="font-mono text-xs text-qubit-400">100 blocks</span> are refused to prevent deep chain reorganization attacks.')}

${docH2('Peer Management')}
${docH3('Connection Limits')}
<div class="overflow-x-auto">
<table class="w-full text-sm mb-4">
  <tbody>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Max inbound</td><td class="py-2 font-mono text-qubit-300">25 peers</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Max outbound</td><td class="py-2 font-mono text-qubit-300">25 peers</td></tr>
    <tr class="border-b border-border last:border-0"><td class="py-2 pr-4 text-text-muted">Seed reconnect delay</td><td class="py-2 font-mono text-qubit-300">5 seconds (+ 30s interval check)</td></tr>
  </tbody>
</table>
</div>

${docH3('Rate Limiting')}
${docP('Each peer connection has a token-bucket rate limiter to prevent message flooding:')}
<div class="overflow-x-auto">
<table class="w-full text-sm mb-4">
  <tbody>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Burst capacity</td><td class="py-2 font-mono text-qubit-300">200 messages</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Refill rate</td><td class="py-2 font-mono text-qubit-300">100 tokens/second</td></tr>
    <tr class="border-b border-border last:border-0"><td class="py-2 pr-4 text-text-muted">Cost per message</td><td class="py-2 font-mono text-qubit-300">1 token</td></tr>
  </tbody>
</table>
</div>
${docP('When a peer\'s tokens are exhausted, the connection is dropped.')}

${docH3('Misbehavior Scoring')}
${docP('Invalid messages increment a penalty score. When the score reaches the ban threshold, the peer is disconnected and banned:')}
<div class="overflow-x-auto">
<table class="w-full text-sm mb-4">
  <thead><tr class="text-xs text-text-muted border-b border-border">
    <th class="text-left font-normal pb-2 pr-4">Offense</th>
    <th class="text-left font-normal pb-2">Penalty</th>
  </tr></thead>
  <tbody>
    <tr class="border-b border-border"><td class="py-2 pr-4">Decode error (malformed message)</td><td class="py-2 font-mono text-red-400">+25</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4">Unknown message type</td><td class="py-2 font-mono text-yellow-400">+10</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4">Pre-handshake restricted message</td><td class="py-2 font-mono text-yellow-400">+10</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4">Invalid payload structure</td><td class="py-2 font-mono text-yellow-400">+10</td></tr>
    <tr class="border-b border-border last:border-0"><td class="py-2 pr-4 font-medium text-red-400">Ban threshold</td><td class="py-2 font-mono text-red-400">100</td></tr>
  </tbody>
</table>
</div>

${docH3('Timeouts')}
<div class="overflow-x-auto">
<table class="w-full text-sm mb-4">
  <tbody>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Handshake timeout</td><td class="py-2 font-mono text-qubit-300">10 seconds</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Idle timeout (triggers ping)</td><td class="py-2 font-mono text-qubit-300">2 minutes</td></tr>
    <tr class="border-b border-border last:border-0"><td class="py-2 pr-4 text-text-muted">Pong timeout</td><td class="py-2 font-mono text-qubit-300">30 seconds</td></tr>
  </tbody>
</table>
</div>

${docH3('Ban List')}
${docP('Banned peers are persisted to <span class="font-mono text-xs text-qubit-400">{dataDir}/banned.json</span> and automatically loaded on startup. Bans expire after <span class="font-mono text-xs text-qubit-400">24 hours</span>. Expired entries are pruned on load.')}
<div class="bg-surface rounded-lg glow-border p-4 mb-4">
<ul class="text-text-secondary text-sm leading-relaxed list-disc list-inside space-y-3">
  <li><span class="text-text-primary font-medium">View ban list</span><br/><code class="text-xs font-mono text-qubit-300">curl -s http://127.0.0.1:3001/api/v1/peers | jq</code></li>
  <li><span class="text-text-primary font-medium">Check banned file</span><br/><code class="text-xs font-mono text-qubit-300">cat {dataDir}/banned.json</code></li>
  <li><span class="text-text-primary font-medium">Clear all bans</span><br/><code class="text-xs font-mono text-qubit-300">echo '{}' &gt; {dataDir}/banned.json</code> then restart the node</li>
</ul>
</div>`;
}

function docIcon(paths: string, cls: string): string {
  return `<svg class="w-4 h-4 ${cls} shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">${paths}</svg>`;
}

function renderDocs(section?: string): void {
  const activeSection = section || 'overview';
  const sectionData = DOC_SECTIONS.find(s => s.id === activeSection) || DOC_SECTIONS[0];

  const sidebar = DOC_SECTIONS.map(s => {
    const active = s.id === sectionData.id;
    const linkCls = active
      ? 'bg-qubit-600/15 text-qubit-400 border-l-2 border-qubit-500'
      : 'text-text-muted hover:text-text-primary hover:bg-white/[0.03] border-l-2 border-transparent';
    const iconCls = active ? 'text-qubit-400' : 'text-text-muted/60';
    return `<a href="#/docs/${s.id}" class="flex items-center gap-2.5 px-3 py-2 rounded-r-md text-sm ${linkCls} transition-all">
      ${docIcon(s.icon, iconCls)}
      <span>${s.title}</span>
    </a>`;
  }).join('');

  root.innerHTML = `<div class="flex gap-8 items-start">
    <nav class="w-56 shrink-0 hidden md:block sticky top-20">
      <div class="bg-surface rounded-xl glow-border p-5">
        <a href="#/docs" class="flex items-center gap-2 text-xs text-text-muted hover:text-qubit-400 font-mono tracking-widest mb-4 pb-3 border-b border-border transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>
          DOCS
        </a>
        <div class="space-y-0.5 -ml-1">
          ${sidebar}
        </div>
      </div>
    </nav>
    <div class="flex-1 min-w-0">
      ${sectionData.render()}
    </div>
  </div>`;
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

  const route = parseRoute();

  // Hide search bar on docs route
  const searchBar = document.querySelector('#explorer-main > .mb-6') as HTMLElement | null;
  if (searchBar) searchBar.style.display = route.view === 'docs' ? 'none' : '';

  if (route.view !== 'docs') renderLoading();

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
    case 'docs':
      renderDocs(route.section);
      break;
  }
}

// --- Init ------------------------------------------------------------------

window.addEventListener('hashchange', dispatch);
setupSearch();
dispatch();
