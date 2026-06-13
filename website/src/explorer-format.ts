// ---------------------------------------------------------------------------
// QubitCoin Block Explorer - pure formatting & display helpers (no DOM state)
// ---------------------------------------------------------------------------

import type { Block, MempoolTx, Transaction } from './explorer-api';

export const COINBASE_TXID = '0'.repeat(64);

/** Convert satoshi integer to human-readable QBTC string (no float artifacts) */
export function formatQBTC(satoshis: number): string {
  const sat = Math.round(satoshis);
  const whole = Math.floor(Math.abs(sat) / 1e8);
  const frac = Math.abs(sat) % 1e8;
  const sign = sat < 0 ? '-' : '';
  if (frac === 0) return `${sign}${whole}`;
  const fracStr = frac.toString().padStart(8, '0').replace(/0+$/, '');
  return `${sign}${whole}.${fracStr}`;
}

export function hexToUtf8(hex: string): string {
  const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
  return new TextDecoder().decode(bytes);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function truncHash(hash: string, len = 6): string {
  if (hash.length <= len * 2 + 3) return hash;
  return hash.slice(0, len) + '...' + hash.slice(-len);
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function timeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatHashrate(h: number): string {
  const units: [number, string][] = [
    [1e18, 'EH/s'], [1e15, 'PH/s'], [1e12, 'TH/s'],
    [1e9, 'GH/s'], [1e6, 'MH/s'], [1e3, 'KH/s'],
  ];
  for (const [threshold, label] of units) {
    if (h >= threshold) return (h / threshold).toFixed(3) + ' ' + label;
  }
  return h.toFixed(0) + ' H/s';
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return '—';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

/** Estimate avg block interval from recent blocks (newest-first). Falls back to targetBlockTime. */
export function avgBlockInterval(blocks: Block[] | null, targetBlockTime: number): number {
  if (!blocks || blocks.length < 2) return targetBlockTime;
  // blocks are newest-first; timestamps are in ms
  const timestamps = blocks.map(b => b.header.timestamp);
  const intervals: number[] = [];
  for (let i = 0; i < timestamps.length - 1; i++) {
    intervals.push(timestamps[i] - timestamps[i + 1]);
  }
  return intervals.reduce((a, b) => a + b, 0) / intervals.length;
}

export function blockEta(lastBlockTime: number, avgInterval: number): string {
  const eta = lastBlockTime + avgInterval - Date.now();
  // PoW is memoryless — if overdue, expected wait is still the average
  const remaining = eta > 0 ? eta : avgInterval;
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  if (mins > 0) return `~${mins}m ${secs}s`;
  return `~${secs}s`;
}

export function formatDifficulty(hexTarget: string): string {
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
export async function senderAddress(tx: Transaction): Promise<string | null> {
  if (isCoinbase(tx) || isClaim(tx)) return null;
  const pk = tx.inputs[0]?.publicKey;
  if (!pk) return null;
  const bytes = new Uint8Array(pk.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Get the transfer amount (excluding change back to sender) */
export function transferAmount(tx: Transaction | MempoolTx, sender: string | null): number {
  if (!sender) return tx.outputs.reduce((s, o) => s + o.amount, 0);
  return tx.outputs.filter(o => o.address !== sender).reduce((s, o) => s + o.amount, 0);
}

export function isCoinbase(tx: Transaction | MempoolTx): boolean {
  return tx.inputs.length === 1 && tx.inputs[0].txId === COINBASE_TXID;
}

export function isClaim(tx: Transaction | MempoolTx): boolean {
  return tx.claimData !== undefined;
}

export function isConfirmedTx(tx: Transaction): boolean {
  return typeof tx.blockHash === 'string' && typeof tx.blockHeight === 'number';
}

export function txStatus(tx: Transaction): { label: string; color: 'cyan' | 'qubit' | 'blue'; detail: string } {
  if (!isConfirmedTx(tx)) {
    return {
      label: 'Unconfirmed',
      color: 'blue',
      detail: 'Waiting in mempool',
    };
  }

  const confirmations = Math.max(tx.confirmations ?? 0, 0);
  if (confirmations >= 6) {
    return {
      label: 'Confirmed',
      color: 'cyan',
      detail: `${confirmations} confirmations`,
    };
  }

  return {
    label: 'Confirming',
    color: 'qubit',
    detail: `${confirmations} confirmation${confirmations === 1 ? '' : 's'}`,
  };
}

export function txTypeBadge(tx: Transaction | MempoolTx): string {
  if (isCoinbase(tx)) return badge('Coinbase', 'cyan');
  if (isClaim(tx)) return badge('Claim', 'qubit');
  return badge('Transfer', 'blue');
}

/** Badge utility for displaying status badges with consistent styling */
export function badge(text: string, colorScheme: 'cyan' | 'qubit' | 'blue'): string {
  const colorClasses: Record<typeof colorScheme, string> = {
    cyan: 'bg-entropy-cyan/20 text-entropy-cyan',
    qubit: 'bg-qubit-600/20 text-qubit-400',
    blue: 'bg-entropy-blue/20 text-entropy-blue',
  };
  return `<span class="px-2 py-0.5 rounded text-xs font-medium ${colorClasses[colorScheme]}">${escapeHtml(text)}</span>`;
}

/** HTTP method badge (GET → cyan, POST/other → qubit) */
export function methodBadge(method: string): string {
  return badge(method, method === 'GET' ? 'cyan' : 'qubit');
}

export function hashLink(hash: string, type: 'block' | 'tx' | 'address', display?: string): string {
  const d = display ?? truncHash(hash);
  return `<a href="#/${type}/${escapeHtml(hash)}" class="font-mono text-qubit-400 hover:text-qubit-300 transition-colors">${d}</a>`;
}

export function renderBlockStrip(blocks: Block[], mempoolSize: number): string {
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

export function card(label: string, value: string | number, small = false): string {
  const valClass = small ? 'text-sm font-bold font-mono truncate' : 'text-xl font-bold whitespace-nowrap';
  return `<div class="bg-surface px-4 py-3 rounded-lg glow-border overflow-hidden">
    <p class="text-text-muted text-xs mb-0.5">${label}</p>
    <p class="${valClass}" title="${value}">${value}</p>
  </div>`;
}
