// ---------------------------------------------------------------------------
// QubitCoin Block Explorer - vanilla TS, hash-based routing, polling
// ---------------------------------------------------------------------------

import { BLOG_POSTS, BLOG_TAG_COLORS } from './blog-posts';
import {
  apiFull,
  fetchBlocks,
  fetchBlock,
  fetchClaimStats,
  fetchMempoolStats,
  fetchMempoolTxs,
  fetchTx,
  fetchStatus,
} from './explorer-api';
import type { Block, Transaction, UTXO } from './explorer-api';
import {
  COINBASE_TXID,
  formatQBTC,
  hexToUtf8,
  escapeHtml,
  truncHash,
  formatTime,
  timeAgo,
  formatHashrate,
  formatDuration,
  avgBlockInterval,
  blockEta,
  formatDifficulty,
  senderAddress,
  transferAmount,
  isCoinbase,
  isClaim,
  isConfirmedTx,
  txStatus,
  txTypeBadge,
  badge,
  hashLink,
  renderBlockStrip,
  card,
} from './explorer-format';
import { DOC_SECTIONS, docIcon } from './explorer-docs';

// --- Router ----------------------------------------------------------------

type Route =
  | { view: 'dashboard' }
  | { view: 'block'; hash: string }
  | { view: 'tx'; txid: string }
  | { view: 'address'; addr: string }
  | { view: 'mempool' }
  | { view: 'docs'; section?: string }
  | { view: 'blog'; slug?: string };

function parseRoute(): Route {
  const hash = location.hash || '#/';
  const parts = hash.slice(2).split('/'); // strip "#/"

  if (parts[0] === 'block' && parts[1]) return { view: 'block', hash: parts[1] };
  if (parts[0] === 'tx' && parts[1]) return { view: 'tx', txid: parts[1] };
  if (parts[0] === 'address' && parts[1]) return { view: 'address', addr: parts[1] };
  if (parts[0] === 'mempool') return { view: 'mempool' };
  if (parts[0] === 'docs') return { view: 'docs', section: parts[1] };
  if (parts[0] === 'blog') return { view: 'blog', slug: parts[1] };
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

function renderError(message = 'Unable to reach the node. Check your connection or try again.'): void {
  root.innerHTML = `<div class="flex flex-col items-center justify-center py-24 text-center gap-4">
    <svg class="w-12 h-12 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
    </svg>
    <p class="text-text-muted text-sm">${escapeHtml(message)}</p>
    <button onclick="location.reload()" class="px-4 py-2 rounded-lg bg-qubit-600/20 border border-qubit-600/40 text-qubit-300 hover:bg-qubit-600/30 transition-all text-sm">Retry</button>
  </div>`;
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
    <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 mb-6">
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
    renderError();
    return;
  }

  let html = `<h1 class="text-3xl font-bold mb-6">Explorer</h1>`;

  // Status cards — single compact grid
  const cards: string[] = [
    card('Height', status.height),
    card('Hashrate', formatHashrate(status.hashrate)),
    card('Difficulty', formatDifficulty(status.difficulty)),
    card('Avg Block Time', formatDuration(status.avgBlockTime)),
    card('Next Block', blockEta(status.lastBlockTime, avgBlockInterval(blocks, status.targetBlockTime))),
    card('Peers', status.peers),
    card('Block Reward', formatQBTC(status.blockReward) + ' QBTC'),
    card('Total Txs', status.totalTxs),
  ];
  if (claimStats && claimStats.totalEntries > 0) {
    cards.push(card('BTC Fork Block', claimStats.btcBlockHeight.toLocaleString()));
    cards.push(card('Claimed BTC', formatQBTC(claimStats.claimedAmount) + ' QBTC'));
  }
  html += `<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 mb-6">${cards.join('')}</div>`;

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
    html += `<div class="overflow-x-auto"><table class="w-full text-sm">
      <thead><tr class="text-xs text-text-muted border-b border-border">
        <th class="text-left font-normal pb-2 pr-3">Height</th>
        <th class="text-left font-normal pb-2">Hash</th>
        <th class="text-right font-normal pb-2">Txs</th>
        <th class="text-left font-normal pb-2 pl-4 hidden lg:table-cell">Miner</th>
        <th class="text-right font-normal pb-2">Age</th>
      </tr></thead><tbody>`;
    for (const b of blocks) {
      const txCount = b.transactions.length;
      const miner = b.transactions[0]?.outputs[0]?.address ?? '';
      html += `<tr class="border-b border-border last:border-0">
        <td class="py-2 pr-3 font-mono text-qubit-400 whitespace-nowrap">${hashLink(b.hash, 'block', `#${b.height}`)}</td>
        <td class="py-2">${hashLink(b.hash, 'block')}</td>
        <td class="py-2 text-right text-text-muted">${txCount}</td>
        <td class="py-2 pl-4 font-mono text-xs hidden lg:table-cell">${miner ? hashLink(miner, 'address', truncHash(miner)) : ''}</td>
        <td class="py-2 text-right text-text-muted text-xs whitespace-nowrap">${timeAgo(b.header.timestamp)}</td>
      </tr>`;
    }
    html += `</tbody></table></div>`;
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
      html += `<div class="flex items-center justify-between gap-3 py-2 border-b border-border last:border-0">
        <div class="flex items-center gap-2 min-w-0">
          ${txTypeBadge(tx)}
          <span class="truncate">${hashLink(tx.id, 'tx')}</span>
        </div>
        <span class="text-text-muted text-xs font-mono whitespace-nowrap">${formatQBTC(amount)} QBTC</span>
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
  const blockResult = await apiFull<Block>(`/block/${hash}`);

  if (!blockResult.ok) {
    // Network error — show connection error
    if (blockResult.networkError) {
      renderError();
      return;
    }
    // HTTP error (likely 404) — try as a transaction (search disambiguation)
    const tx = await fetchTx(hash);
    if (tx) {
      location.hash = `#/tx/${hash}`;
      return;
    }
    root.innerHTML = `<p class="text-red-500">Block not found: ${escapeHtml(truncHash(hash))}</p>
      <a href="#/mempool" class="text-qubit-400 hover:text-qubit-300 text-sm mt-2 inline-block">Back</a>`;
    return;
  }

  const block = blockResult.data;

  const h = block.header;
  let html = ``;
  html += `<h1 class="text-2xl font-bold mb-6">Block <span class="text-qubit-400">#${block.height}</span></h1>`;

  html += `<div class="bg-surface rounded-lg glow-border p-6 mb-6">
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
      <div>
        <p class="text-text-muted mb-1">Height</p>
        <p class="font-mono">${block.height.toLocaleString()}</p>
      </div>
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
      ${(() => {
        const cbPubKey = block.transactions[0]?.inputs[0]?.publicKey;
        if (!cbPubKey || cbPubKey === '') {
          return '';
        }
        try {
          const msg = hexToUtf8(cbPubKey);
          if (!msg) return '';
          return `<div class="md:col-span-2">
            <p class="text-text-muted mb-1">Message</p>
            <p class="text-sm break-all">${escapeHtml(msg)}</p>
          </div>`;
        } catch { return ''; }
      })()}
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
      <span class="text-text-muted text-sm font-mono">${formatQBTC(amount)} QBTC</span>
    </div>`;
  }
  html += `</div>`;

  root.innerHTML = html;
}

// Transaction detail --------------------------------------------------------

async function renderTx(txid: string): Promise<void> {
  const txResult = await apiFull<Transaction>(`/tx/${txid}`);
  if (!txResult.ok) {
    if (txResult.networkError) {
      renderError();
      return;
    }
    root.innerHTML = `<p class="text-red-500">Transaction not found: ${escapeHtml(truncHash(txid))}</p>
      <a href="#/mempool" class="text-qubit-400 hover:text-qubit-300 text-sm mt-2 inline-block">Back</a>`;
    return;
  }
  const tx = txResult.data;

  const sender = await senderAddress(tx);
  const amount = transferAmount(tx, sender);
  const totalOut = tx.outputs.reduce((s, o) => s + o.amount, 0);
  const status = txStatus(tx);

  // Look up input amounts for regular transfers (fee + display)
  let fee: number | null = null;
  let inputAmounts: number[] = [];
  if (!isCoinbase(tx) && !isClaim(tx)) {
    inputAmounts = await Promise.all(tx.inputs.map(async (inp) => {
      const srcTx = await fetchTx(inp.txId);
      return srcTx?.outputs[inp.outputIndex]?.amount ?? 0;
    }));
    const totalIn = inputAmounts.reduce((s, a) => s + a, 0);
    fee = totalIn - totalOut;
  }

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
        <p class="font-mono">${formatQBTC(amount)} QBTC</p>
      </div>
      <div>
        <p class="text-text-muted mb-1">Type</p>
        <p>${txTypeBadge(tx)}</p>
      </div>${fee !== null ? `
      <div>
        <p class="text-text-muted mb-1">Fee</p>
        <p class="font-mono">${formatQBTC(fee)} QBTC</p>
      </div>` : ''}
      <div>
        <p class="text-text-muted mb-1">Status</p>
        <div class="flex flex-col gap-1">
          <p>${badge(status.label, status.color)}</p>
          <p class="text-text-muted text-xs">${status.detail}</p>
        </div>
      </div>${isConfirmedTx(tx) ? `
      <div>
        <p class="text-text-muted mb-1">Included In</p>
        <p>${hashLink(tx.blockHash!, 'block', `#${tx.blockHeight}`)}</p>
      </div>
      <div>
        <p class="text-text-muted mb-1">Confirmations</p>
        <p class="font-mono">${tx.confirmations ?? 0}</p>
      </div>` : ''}
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
          <p class="text-text-muted mb-1">Destination QBTC Address</p>
          <p>${hashLink(cd.qbtcAddress, 'address', cd.qbtcAddress)}</p>
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
  for (let i = 0; i < tx.inputs.length; i++) {
    const inp = tx.inputs[i];
    if (inp.txId === COINBASE_TXID) {
      html += `<div class="bg-surface rounded-lg glow-border p-3 text-sm">
        <p class="text-entropy-cyan font-mono text-xs">Coinbase (new coins)</p>
      </div>`;
    } else {
      const inAmt = inputAmounts[i];
      html += `<div class="bg-surface rounded-lg glow-border p-3 text-sm flex items-center justify-between">
        <div>
          <p class="text-text-muted text-xs mb-1">From tx</p>
          <p>${hashLink(inp.txId, 'tx')}<span class="text-text-muted">:${inp.outputIndex}</span></p>
        </div>${inAmt !== undefined ? `
        <span class="font-mono text-qubit-300">${formatQBTC(inAmt)} QBTC</span>` : ''}
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
      <span class="font-mono text-qubit-300">${formatQBTC(out.amount)} QBTC</span>
    </div>`;
  }
  html += `</div></div>`;

  html += `</div>`; // close grid

  root.innerHTML = html;
}

// Address view --------------------------------------------------------------

async function renderAddress(addr: string): Promise<void> {
  const [balanceResult, utxoResult] = await Promise.all([
    apiFull<{ balance: number }>(`/address/${addr}/balance`),
    apiFull<UTXO[]>(`/address/${addr}/utxos`),
  ]);

  // Both failed with network errors — show connection error
  if (!balanceResult.ok && balanceResult.networkError && !utxoResult.ok && utxoResult.networkError) {
    renderError();
    return;
  }

  // Either returned 404 — address not found on-chain
  if (!balanceResult.ok && !balanceResult.networkError && balanceResult.status === 404
      && !utxoResult.ok && !utxoResult.networkError && utxoResult.status === 404) {
    root.innerHTML = `<p class="text-red-500">Address not found: ${escapeHtml(truncHash(addr))}</p>
      <a href="#/" class="text-qubit-400 hover:text-qubit-300 text-sm mt-2 inline-block">Back to explorer</a>`;
    return;
  }

  const balance = balanceResult.ok ? balanceResult.data.balance : null;
  const utxos = utxoResult.ok ? utxoResult.data : null;

  let html = ``;
  html += `<h1 class="text-2xl font-bold mb-6">Address</h1>`;

  html += `<div class="bg-surface rounded-lg glow-border p-6 mb-6">
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
      <div>
        <p class="text-text-muted mb-1">Address</p>
        <p class="font-mono text-xs break-all">${escapeHtml(addr)}</p>
      </div>
      <div>
        <p class="text-text-muted mb-1">Balance</p>
        ${balance !== null
          ? `<p class="text-2xl font-bold">${formatQBTC(balance)} QBTC</p>`
          : `<p class="text-red-400 text-sm">Unable to load balance</p>`}
      </div>
    </div>
  </div>`;

  if (utxos !== null) {
    html += `<h2 class="text-lg font-semibold mb-4">UTXOs (${utxos.length})</h2>`;
    if (utxos.length > 0) {
      html += `<div class="space-y-2">`;
      for (const u of utxos) {
        html += `<div class="bg-surface rounded-lg glow-border p-4 flex items-center justify-between">
          <div>
            ${hashLink(u.txId, 'tx')}<span class="text-text-muted">:${u.outputIndex}</span>
          </div>
          <span class="font-mono text-qubit-300">${formatQBTC(u.amount)} QBTC</span>
        </div>`;
      }
      html += `</div>`;
    } else {
      html += `<p class="text-text-muted text-sm">No UTXOs for this address.</p>`;
    }
  } else {
    html += `<h2 class="text-lg font-semibold mb-4">UTXOs</h2>`;
    html += `<p class="text-red-400 text-sm">Unable to load UTXOs</p>`;
  }

  root.innerHTML = html;
}

// --- Blog ------------------------------------------------------------------


function renderBlogList(): void {
  const sorted = [...BLOG_POSTS].sort((a, b) => b.date.localeCompare(a.date));
  const [featured, ...rest] = sorted;

  function tagBadges(post: typeof featured): string {
    return post.tags.map(t => {
      const cls = BLOG_TAG_COLORS[t] || 'text-text-muted bg-surface border-border';
      return `<span class="px-2 py-0.5 rounded text-[10px] font-mono border ${cls}">${t}</span>`;
    }).join('');
  }

  const readArrow = `<svg class="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>`;

  const featuredCard = `
    <a href="#/blog/${featured.slug}" class="block group mb-8">
      <div class="bg-surface rounded-2xl glow-border p-8 md:p-10 transition-all group-hover:border-qubit-600/40 relative overflow-hidden">
        <div class="absolute top-0 right-0 w-64 h-64 bg-qubit-600/5 rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none"></div>
        <div class="flex items-center gap-2 mb-5 flex-wrap">
          <span class="px-2 py-0.5 rounded text-[10px] font-mono border text-qubit-400 bg-qubit-600/10 border-qubit-600/20">Latest</span>
          <span class="text-text-muted/30">·</span>
          <span class="text-xs font-mono text-text-muted">${featured.date}</span>
          <span class="text-text-muted/30">·</span>
          ${tagBadges(featured)}
        </div>
        <h2 class="text-2xl font-bold text-text-primary mb-4 group-hover:text-qubit-300 transition-colors max-w-2xl">${featured.title}</h2>
        <p class="text-text-muted text-sm leading-relaxed max-w-2xl">${featured.excerpt}</p>
        <div class="mt-6 flex items-center gap-1.5 text-qubit-400 text-xs font-medium">
          Read post ${readArrow}
        </div>
      </div>
    </a>`;

  const cards = rest.map(post => `
    <a href="#/blog/${post.slug}" class="block group h-full">
      <div class="bg-surface rounded-2xl glow-border p-7 transition-all group-hover:border-qubit-600/40 h-full flex flex-col">
        <div class="flex items-center gap-2 mb-4 flex-wrap">
          <span class="text-xs font-mono text-text-muted">${post.date}</span>
          <span class="text-text-muted/30">·</span>
          ${tagBadges(post)}
        </div>
        <h2 class="text-base font-semibold text-text-primary mb-3 group-hover:text-qubit-300 transition-colors leading-snug">${post.title}</h2>
        <p class="text-text-muted text-sm leading-relaxed flex-1">${post.excerpt}</p>
        <div class="mt-5 flex items-center gap-1.5 text-qubit-400 text-xs font-medium">
          Read post ${readArrow}
        </div>
      </div>
    </a>`).join('');

  root.innerHTML = `
    <div class="mb-10">
      <p class="text-qubit-400 font-mono text-sm tracking-widest mb-2">BLOG</p>
      <h1 class="text-3xl font-bold">Thinking Out Loud</h1>
      <p class="text-text-muted mt-2 text-sm">QubitCoin development updates, cryptography deep-dives, and the thinking behind the project.</p>
    </div>
    ${featuredCard}
    <div class="grid md:grid-cols-2 gap-6">
      ${cards}
    </div>`;
}

function renderBlogPost(slug: string): void {
  const post = BLOG_POSTS.find(p => p.slug === slug);
  if (!post) {
    root.innerHTML = `<div class="flex flex-col items-center justify-center py-24 text-center gap-4">
      <p class="text-qubit-400 font-mono text-xs tracking-widest">404</p>
      <h1 class="text-2xl font-bold">Post not found</h1>
      <p class="text-text-muted text-sm max-w-md">The blog post you're looking for doesn't exist or may have been moved.</p>
      <div class="flex items-center gap-3 mt-2">
        <a href="#/blog" class="px-4 py-2 rounded-lg bg-qubit-600/20 border border-qubit-600/40 text-qubit-300 hover:bg-qubit-600/30 transition-all text-sm">← All Posts</a>
        <a href="#/" class="px-4 py-2 rounded-lg border border-border text-text-muted hover:text-text-primary hover:border-qubit-600/40 transition-all text-sm">Home</a>
      </div>
    </div>`;
    return;
  }

  const tags = post.tags.map(t => {
    const cls = BLOG_TAG_COLORS[t] || 'text-text-muted bg-surface border-border';
    return `<span class="px-2 py-0.5 rounded text-[10px] font-mono border ${cls}">${t}</span>`;
  }).join('');

  root.innerHTML = `
    <div class="max-w-2xl mx-auto">
      <a href="#/blog" class="inline-flex items-center gap-1.5 text-text-muted hover:text-qubit-400 transition-colors text-sm mb-8">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>
        All Posts
      </a>
      <div class="flex items-center gap-2 mb-4 flex-wrap">
        <span class="text-xs font-mono text-text-muted">${post.date}</span>
        <span class="text-text-muted/30">·</span>
        ${tags}
      </div>
      <div class="prose-blog">
        ${post.content()}
      </div>
    </div>`;
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
    let html = `<a href="#/docs/${s.id}" class="flex items-center gap-2.5 px-3 py-2 rounded-r-md text-sm ${linkCls} transition-all">
      ${docIcon(s.icon, iconCls)}
      <span>${s.title}</span>
    </a>`;
    if (active && s.children?.length) {
      const childLinks = s.children.map(c =>
        `<a href="#/docs/${s.id}#${c.id}" onclick="event.preventDefault();document.getElementById('${c.id}')?.scrollIntoView({behavior:'smooth',block:'start'});history.replaceState(null,'','#/docs/${s.id}')" class="block pl-10 py-1 text-xs text-text-muted/70 hover:text-qubit-400 transition-colors">${c.title}</a>`
      ).join('');
      html += `<div class="space-y-0.5 mt-0.5">${childLinks}</div>`;
    }
    return html;
  }).join('');

  // Note: all content here is static/hardcoded (doc sections, icons, section titles).
  // No user-supplied data is interpolated into the HTML — XSS risk is not applicable.
  const sidebarContent = `
    <a href="#/docs" class="flex items-center gap-2 text-xs text-text-muted hover:text-qubit-400 font-mono tracking-widest mb-4 pb-3 border-b border-border transition-colors">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>
      DOCS
    </a>
    <div class="space-y-0.5 -ml-1">
      ${sidebar}
    </div>`;

  root.innerHTML = `<div class="flex gap-8 items-start">
    <!-- Mobile docs menu button -->
    <button id="docs-mobile-btn" class="lg:hidden fixed bottom-6 right-6 z-40 w-12 h-12 rounded-full bg-qubit-600 text-white shadow-lg shadow-qubit-600/30 flex items-center justify-center hover:bg-qubit-500 transition-colors" aria-label="Docs navigation">
      <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>
    </button>
    <!-- Mobile docs drawer overlay -->
    <div id="docs-mobile-overlay" class="hidden lg:hidden fixed inset-0 z-40 bg-black/60" aria-hidden="true"></div>
    <!-- Mobile docs drawer -->
    <div id="docs-mobile-drawer" class="hidden lg:hidden fixed inset-y-0 left-0 z-50 w-72 bg-bg border-r border-border overflow-y-auto p-5">
      <div class="flex items-center justify-between mb-4">
        <span class="text-xs text-text-muted font-mono tracking-widest">DOCS</span>
        <button id="docs-mobile-close" class="p-1 text-text-muted hover:text-text-primary transition-colors" aria-label="Close">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="space-y-0.5 -ml-1">
        ${sidebar}
      </div>
    </div>
    <!-- Desktop sidebar -->
    <nav class="w-72 shrink-0 hidden lg:block sticky top-20">
      <div class="bg-surface rounded-xl glow-border p-5">
        ${sidebarContent}
      </div>
    </nav>
    <div class="flex-1 min-w-0 max-w-4xl">
      ${sectionData.render()}
    </div>
  </div>`;

  // Wire up mobile docs drawer
  const mobileBtn = document.getElementById('docs-mobile-btn');
  const mobileOverlay = document.getElementById('docs-mobile-overlay');
  const mobileDrawer = document.getElementById('docs-mobile-drawer');
  const mobileClose = document.getElementById('docs-mobile-close');
  const toggleDrawer = () => {
    mobileDrawer?.classList.toggle('hidden');
    mobileOverlay?.classList.toggle('hidden');
  };
  mobileBtn?.addEventListener('click', toggleDrawer);
  mobileOverlay?.addEventListener('click', toggleDrawer);
  mobileClose?.addEventListener('click', toggleDrawer);
  mobileDrawer?.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
    mobileDrawer?.classList.add('hidden');
    mobileOverlay?.classList.add('hidden');
  }));
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

  // Hide search bar on docs/blog routes; widen container for docs (sidebar) and blog (3-col grid).
  const searchBar = document.querySelector('#explorer-main > .mb-6') as HTMLElement | null;
  if (searchBar) searchBar.style.display = (route.view === 'docs' || route.view === 'blog') ? 'none' : '';
  if (explorerEl) {
    if (route.view === 'docs' || route.view === 'blog') {
      explorerEl.classList.remove('max-w-6xl');
      explorerEl.classList.add('max-w-[90rem]');
    } else {
      explorerEl.classList.remove('max-w-[90rem]');
      explorerEl.classList.add('max-w-6xl');
    }
  }

  if (route.view !== 'docs' && route.view !== 'blog') renderLoading();

  switch (route.view) {
    case 'mempool':
      await renderDashboard();
      refreshTimer = setInterval(() => renderDashboard(), 15_000);
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
    case 'blog':
      if (route.slug) {
        renderBlogPost(route.slug);
      } else {
        renderBlogList();
      }
      break;
  }
  window.scrollTo(0, 0);
}

// --- Init ------------------------------------------------------------------

window.addEventListener('hashchange', dispatch);
setupSearch();
dispatch();
