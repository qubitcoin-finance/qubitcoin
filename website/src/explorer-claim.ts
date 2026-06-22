import { broadcastTransaction, fetchClaimStats, fetchSnapshotAddress } from './explorer-api';
import type { ClaimStats, SnapshotAddressLookup } from './explorer-api';
import { badge, escapeHtml, formatQBTC, hashLink } from './explorer-format';
import {
  createBrowserClaimTransaction,
  deriveClaimCandidates,
  generateQbtcWallet,
  makeAddressOnlyWallet,
  selectMatchingCandidate,
  type ClaimCandidate,
  type QbtcWalletExport,
} from './claim-browser';

const root = document.getElementById('explorer-content')!;

type ClaimUiState = {
  btcAddress: string;
  qbtcAddress: string;
  useGeneratedWallet: boolean;
  snapshot: SnapshotAddressLookup | null;
  claimStats: ClaimStats | null;
  candidates: ClaimCandidate[];
  selectedCandidate: ClaimCandidate | null;
  generatedWallet: QbtcWalletExport | null;
  claimTx: unknown | null;
  status: string | null;
  error: string | null;
  txid: string | null;
};

const claimUiState: ClaimUiState = {
  btcAddress: '',
  qbtcAddress: '',
  useGeneratedWallet: true,
  snapshot: null,
  claimStats: null,
  candidates: [],
  selectedCandidate: null,
  generatedWallet: null,
  claimTx: null,
  status: null,
  error: null,
  txid: null,
};

function renderClaimStatus(): string {
  if (claimUiState.error) {
    return `<p class="text-red-400 text-sm">${escapeHtml(claimUiState.error)}</p>`;
  }
  if (claimUiState.txid) {
    return `<p class="text-entropy-cyan text-sm">Broadcast accepted: ${hashLink(claimUiState.txid, 'tx', claimUiState.txid)}</p>`;
  }
  if (claimUiState.status) {
    return `<p class="text-text-muted text-sm">${escapeHtml(claimUiState.status)}</p>`;
  }
  return `<p class="text-text-muted text-sm">Your Bitcoin private key is used only in this browser tab. This page loads no third-party scripts and never sends the key to the node.</p>`;
}

function renderClaimPreview(): string {
  const snapshot = claimUiState.snapshot;
  if (!snapshot) {
    return `<p class="text-text-muted text-sm">Check an eligible BTC snapshot address to preview a claim.</p>`;
  }

  const status = snapshot.claimed ? badge('Claimed', 'qubit') : badge('Eligible', 'cyan');
  return `<div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
    <div>
      <p class="text-text-muted mb-1">BTC Snapshot Address</p>
      <p class="font-mono text-xs break-all">${escapeHtml(snapshot.btcAddress)}</p>
    </div>
    <div>
      <p class="text-text-muted mb-1">Amount</p>
      <p class="font-mono text-qubit-300">${formatQBTC(snapshot.amount)} QBTC</p>
    </div>
    <div>
      <p class="text-text-muted mb-1">Snapshot Type</p>
      <p class="font-mono uppercase">${escapeHtml(snapshot.type)}</p>
    </div>
    <div>
      <p class="text-text-muted mb-1">Status</p>
      <p>${status}</p>
    </div>
    ${claimUiState.selectedCandidate ? `<div>
      <p class="text-text-muted mb-1">Matched Key Path</p>
      <p class="font-mono text-xs">${escapeHtml(claimUiState.selectedCandidate.path ?? claimUiState.selectedCandidate.label)}</p>
    </div>` : ''}
    ${claimUiState.generatedWallet ? `<div>
      <p class="text-text-muted mb-1">Generated QBTC Address</p>
      <p>${hashLink(claimUiState.generatedWallet.address, 'address', claimUiState.generatedWallet.address)}</p>
    </div>` : claimUiState.qbtcAddress ? `<div>
      <p class="text-text-muted mb-1">Destination QBTC Address</p>
      <p>${hashLink(claimUiState.qbtcAddress, 'address', claimUiState.qbtcAddress)}</p>
    </div>` : ''}
  </div>`;
}

function renderClaimExport(): string {
  if (!claimUiState.claimTx) {
    return `<p class="text-text-muted text-sm">Build a signed claim transaction to enable JSON export.</p>`;
  }
  const payload = JSON.stringify({
    transaction: claimUiState.claimTx,
    qbtcWallet: claimUiState.generatedWallet,
  }, null, 2);
  return `<div class="space-y-3">
    ${claimUiState.generatedWallet ? `<div class="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
      <p class="text-amber-300 text-sm font-medium mb-1">Save the generated QBTC secret key before leaving this page.</p>
      <p class="font-mono text-[11px] break-all text-text-muted">${escapeHtml(claimUiState.generatedWallet.secretKey)}</p>
    </div>` : ''}
    <textarea id="claim-export-json" readonly class="w-full min-h-56 bg-background border border-border rounded-lg px-3 py-2 font-mono text-xs focus:outline-none">${escapeHtml(payload)}</textarea>
    <div class="flex flex-wrap gap-3">
      <button id="claim-download-btn" type="button" class="px-4 py-2 rounded-lg bg-qubit-600/20 border border-qubit-600/40 text-qubit-300 hover:bg-qubit-600/30 transition-all text-sm">Download JSON</button>
      <button id="claim-copy-btn" type="button" class="px-4 py-2 rounded-lg border border-border text-text-muted hover:text-text-primary hover:border-qubit-600/40 transition-all text-sm">Copy JSON</button>
    </div>
  </div>`;
}

export function renderClaim(): void {
  root.innerHTML = `<div class="max-w-5xl mx-auto">
    <div class="mb-8">
      <p class="text-qubit-400 font-mono text-sm tracking-widest mb-2">BTC CLAIM</p>
      <h1 class="text-3xl font-bold">Migrate BTC Snapshot Balance</h1>
      <p class="text-text-muted mt-2 text-sm max-w-2xl">Check eligibility, sign a BTC ownership proof locally, and broadcast a QBTC claim transaction without installing Node.js.</p>
    </div>

    <div class="bg-surface rounded-lg glow-border p-5 mb-6">
      <div class="flex flex-col md:flex-row md:items-end gap-3">
        <div class="flex-1 min-w-0">
          <label for="claim-btc-address" class="block text-sm font-medium mb-2">BTC snapshot address key</label>
          <input id="claim-btc-address" type="text" spellcheck="false" value="${escapeHtml(claimUiState.btcAddress)}"
            class="w-full bg-background border border-border rounded-lg px-3 py-2 font-mono text-sm focus:outline-none focus:border-qubit-500"
            placeholder="40- or 64-character snapshot address">
        </div>
        <button id="claim-check-btn" type="button" class="px-4 py-2 rounded-lg bg-qubit-600/20 border border-qubit-600/40 text-qubit-300 hover:bg-qubit-600/30 transition-all text-sm">Check Eligibility</button>
      </div>
      <div class="mt-4">${renderClaimPreview()}</div>
    </div>

    <div class="grid lg:grid-cols-[1.15fr_0.85fr] gap-6 mb-6">
      <form id="claim-build-form" class="bg-surface rounded-lg glow-border p-5 space-y-5">
        <div>
          <label for="claim-private-key" class="block text-sm font-medium mb-2">BTC private key or seed phrase</label>
          <textarea id="claim-private-key" autocomplete="off" spellcheck="false"
            class="w-full min-h-28 bg-background border border-border rounded-lg px-3 py-2 font-mono text-sm focus:outline-none focus:border-qubit-500"
            placeholder="Compressed WIF, 64-character hex key, or 12/24-word BIP39 seed phrase"></textarea>
          <p class="text-text-muted text-xs mt-2">This page loads no third-party scripts. The key is never included in API requests; the browser sends only the signed claim transaction.</p>
        </div>

        <div class="grid sm:grid-cols-2 gap-3">
          <label class="block rounded-lg border border-border p-3 cursor-pointer ${claimUiState.useGeneratedWallet ? 'bg-qubit-600/10 border-qubit-600/40' : ''}">
            <input type="radio" name="claim-qbtc-mode" value="generate" ${claimUiState.useGeneratedWallet ? 'checked' : ''} class="mr-2">
            <span class="text-sm font-medium">Generate QBTC wallet</span>
            <span class="block text-text-muted text-xs mt-1">Creates an ML-DSA-65 address in-browser.</span>
          </label>
          <label class="block rounded-lg border border-border p-3 cursor-pointer ${!claimUiState.useGeneratedWallet ? 'bg-qubit-600/10 border-qubit-600/40' : ''}">
            <input type="radio" name="claim-qbtc-mode" value="existing" ${!claimUiState.useGeneratedWallet ? 'checked' : ''} class="mr-2">
            <span class="text-sm font-medium">Use existing address</span>
            <span class="block text-text-muted text-xs mt-1">Paste a 64-character QBTC address.</span>
          </label>
        </div>

        <div id="claim-existing-address-wrap" class="${claimUiState.useGeneratedWallet ? 'hidden' : ''}">
          <label for="claim-qbtc-address" class="block text-sm font-medium mb-2">Destination QBTC address</label>
          <input id="claim-qbtc-address" type="text" spellcheck="false" value="${escapeHtml(claimUiState.qbtcAddress)}"
            class="w-full bg-background border border-border rounded-lg px-3 py-2 font-mono text-sm focus:outline-none focus:border-qubit-500"
            placeholder="64-character QBTC address">
        </div>

        <div class="flex flex-wrap gap-3">
          <button type="submit" class="px-4 py-2 rounded-lg bg-qubit-600/20 border border-qubit-600/40 text-qubit-300 hover:bg-qubit-600/30 transition-all text-sm">Build Signed Claim</button>
          <button id="claim-broadcast-btn" type="button" ${claimUiState.claimTx ? '' : 'disabled'}
            class="px-4 py-2 rounded-lg border border-entropy-cyan/40 text-entropy-cyan hover:bg-entropy-cyan/10 transition-all text-sm disabled:opacity-40 disabled:cursor-not-allowed">Broadcast</button>
        </div>
      </form>

      <div class="bg-surface rounded-lg glow-border p-5">
        <h2 class="text-lg font-semibold mb-4">Claim Preview</h2>
        ${renderClaimPreview()}
        <div class="mt-5 pt-4 border-t border-border">
          ${renderClaimStatus()}
        </div>
      </div>
    </div>

    <div class="grid lg:grid-cols-2 gap-6">
      <div class="bg-surface rounded-lg glow-border p-5">
        <h2 class="text-lg font-semibold mb-4">Air-gapped Export</h2>
        ${renderClaimExport()}
      </div>
      <form id="claim-import-form" class="bg-surface rounded-lg glow-border p-5">
        <h2 class="text-lg font-semibold mb-4">Import and Broadcast</h2>
        <textarea id="claim-import-json" class="w-full min-h-56 bg-background border border-border rounded-lg px-3 py-2 font-mono text-xs focus:outline-none focus:border-qubit-500"
          placeholder="Paste exported JSON or a raw transaction JSON object"></textarea>
        <button type="submit" class="mt-3 px-4 py-2 rounded-lg bg-qubit-600/20 border border-qubit-600/40 text-qubit-300 hover:bg-qubit-600/30 transition-all text-sm">Broadcast Imported JSON</button>
      </form>
    </div>
  </div>`;

  bindClaimHandlers();
}

function rerenderClaim(): void {
  renderClaim();
}

function bindClaimHandlers(): void {
  document.getElementById('claim-check-btn')?.addEventListener('click', async () => {
    const input = document.getElementById('claim-btc-address') as HTMLInputElement | null;
    const btcAddress = input?.value.trim().toLowerCase() ?? '';
    claimUiState.btcAddress = btcAddress;
    claimUiState.snapshot = null;
    claimUiState.claimTx = null;
    claimUiState.selectedCandidate = null;
    claimUiState.generatedWallet = null;
    claimUiState.txid = null;
    claimUiState.error = null;
    claimUiState.status = 'Checking snapshot eligibility...';
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(btcAddress)) {
      claimUiState.status = null;
      claimUiState.error = 'Enter a valid 40- or 64-character BTC snapshot address key.';
      rerenderClaim();
      return;
    }
    rerenderClaim();

    const [snapshotResult, stats] = await Promise.all([
      fetchSnapshotAddress(btcAddress),
      fetchClaimStats(),
    ]);
    claimUiState.claimStats = stats;
    claimUiState.status = null;
    if (snapshotResult.ok) {
      claimUiState.snapshot = snapshotResult.data;
      if (snapshotResult.data.claimed) {
        claimUiState.error = 'This BTC snapshot address has already been claimed.';
      }
    } else if (snapshotResult.networkError) {
      claimUiState.error = 'Unable to reach the node. Try again shortly.';
    } else if (snapshotResult.status === 404) {
      claimUiState.error = 'Address is not in the BTC snapshot.';
    } else {
      claimUiState.error = 'Snapshot lookup failed.';
    }
    rerenderClaim();
  });

  document.querySelectorAll<HTMLInputElement>('input[name="claim-qbtc-mode"]').forEach((input) => {
    input.addEventListener('change', () => {
      claimUiState.useGeneratedWallet = input.value === 'generate';
      claimUiState.claimTx = null;
      claimUiState.generatedWallet = null;
      claimUiState.txid = null;
      claimUiState.error = null;
      rerenderClaim();
    });
  });

  document.getElementById('claim-build-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const keyInput = document.getElementById('claim-private-key') as HTMLTextAreaElement | null;
    const qbtcInput = document.getElementById('claim-qbtc-address') as HTMLInputElement | null;
    claimUiState.error = null;
    claimUiState.status = null;
    claimUiState.txid = null;

    try {
      if (!claimUiState.snapshot || !claimUiState.claimStats) {
        throw new Error('Check an eligible BTC snapshot address before building a claim.');
      }
      if (claimUiState.snapshot.claimed) {
        throw new Error('This BTC snapshot address has already been claimed.');
      }
      if (!claimUiState.claimStats.btcBlockHash || !claimUiState.claimStats.genesisHash) {
        throw new Error('The connected node did not return claim metadata.');
      }
      const credentials = keyInput?.value ?? '';
      const candidates = deriveClaimCandidates(credentials);
      const selectedCandidate = selectMatchingCandidate(candidates, claimUiState.snapshot);
      const generated = claimUiState.useGeneratedWallet ? generateQbtcWallet() : null;
      const wallet = generated ? generated.wallet : makeAddressOnlyWallet(qbtcInput?.value.trim() ?? '');
      const tx = createBrowserClaimTransaction(
        selectedCandidate,
        claimUiState.snapshot,
        wallet,
        claimUiState.claimStats.btcBlockHash,
        claimUiState.claimStats.genesisHash,
      );

      claimUiState.candidates = candidates;
      claimUiState.selectedCandidate = selectedCandidate;
      claimUiState.generatedWallet = generated?.exportable ?? null;
      claimUiState.qbtcAddress = wallet.address;
      claimUiState.claimTx = tx;
      claimUiState.status = 'Signed claim transaction is ready to export or broadcast.';
      if (keyInput) keyInput.value = '';
    } catch (error) {
      claimUiState.claimTx = null;
      claimUiState.generatedWallet = null;
      claimUiState.error = error instanceof Error ? error.message : String(error);
    }
    rerenderClaim();
  });

  document.getElementById('claim-broadcast-btn')?.addEventListener('click', async () => {
    if (!claimUiState.claimTx) return;
    claimUiState.error = null;
    claimUiState.status = 'Broadcasting signed claim transaction...';
    rerenderClaim();
    const result = await broadcastTransaction(claimUiState.claimTx);
    claimUiState.status = null;
    if (result.ok) {
      claimUiState.txid = result.data.txid;
    } else if (result.networkError) {
      claimUiState.error = 'Unable to reach the node while broadcasting.';
    } else {
      claimUiState.error = 'The node rejected the claim transaction.';
    }
    rerenderClaim();
  });

  document.getElementById('claim-import-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = document.getElementById('claim-import-json') as HTMLTextAreaElement | null;
    claimUiState.error = null;
    claimUiState.status = 'Broadcasting imported transaction...';
    claimUiState.txid = null;
    rerenderClaim();
    try {
      const parsed = JSON.parse(input?.value ?? '') as unknown;
      const tx = extractImportedTransaction(parsed);
      const result = await broadcastTransaction(tx);
      claimUiState.status = null;
      if (result.ok) {
        claimUiState.txid = result.data.txid;
      } else if (result.networkError) {
        claimUiState.error = 'Unable to reach the node while broadcasting.';
      } else {
        claimUiState.error = 'The node rejected the imported transaction.';
      }
    } catch (error) {
      claimUiState.status = null;
      claimUiState.error = error instanceof Error ? error.message : String(error);
    }
    rerenderClaim();
  });

  document.getElementById('claim-download-btn')?.addEventListener('click', () => {
    const textarea = document.getElementById('claim-export-json') as HTMLTextAreaElement | null;
    if (!textarea) return;
    const blob = new Blob([textarea.value + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `qbtc-claim-${claimUiState.btcAddress.slice(0, 8) || 'tx'}.json`;
    link.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('claim-copy-btn')?.addEventListener('click', async () => {
    const textarea = document.getElementById('claim-export-json') as HTMLTextAreaElement | null;
    if (!textarea) return;
    await navigator.clipboard.writeText(textarea.value);
    claimUiState.status = 'Claim JSON copied to clipboard.';
    rerenderClaim();
  });
}

function extractImportedTransaction(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'transaction' in value) {
    return (value as { transaction: unknown }).transaction;
  }
  return value;
}
