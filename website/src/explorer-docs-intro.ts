// ---------------------------------------------------------------------------
// QubitCoin Block Explorer - docs content: Overview & Getting Started
// ---------------------------------------------------------------------------

import { docCode, docH2, docH3, docP } from './explorer-docs-helpers';

export function renderDocsOverview(): string {
  return `<h1 class="text-2xl font-bold mb-6">Overview</h1>
${docP('QubitCoin (QBTC) is a post-quantum fork of Bitcoin. It replaces ECDSA secp256k1 with <span class="text-qubit-400 font-mono text-xs">ML-DSA-65</span> (Dilithium) — a NIST-standardized lattice-based digital signature algorithm that resists both classical and quantum attacks.')}
${docP('Bitcoin holders can claim their QBTC by proving ECDSA ownership of a BTC address. The claimed balance is bound to a new ML-DSA-65 public key, creating quantum-safe UTXOs. No trust or intermediaries required.')}

${docH2('The Quantum Threat')}
${docP('Every Bitcoin transaction today is secured by ECDSA on the secp256k1 curve. The security of this scheme relies on the discrete logarithm problem, which Shor\'s algorithm can solve in polynomial time on a sufficiently large quantum computer. When that day comes, every exposed public key — including every address that has ever sent a transaction — becomes vulnerable.')}
${docP('QubitCoin eliminates this threat by replacing ECDSA with ML-DSA-65, a lattice-based signature scheme whose security relies on the Module Learning With Errors (MLWE) problem. No known quantum algorithm can efficiently solve MLWE.')}

${docH2('Key Properties')}
<ul class="text-text-secondary text-sm leading-relaxed mb-3 list-disc list-inside space-y-2">
  <li><span class="text-text-primary font-medium">Quantum-safe signatures</span> — ML-DSA-65 (FIPS 204), NIST security level 3. Based on the Module-LWE problem, resistant to both classical and quantum attacks.</li>
  <li><span class="text-text-primary font-medium">Bitcoin UTXO model</span> — same unspent transaction output design. Transactions consume UTXOs as inputs and create new UTXOs as outputs.</li>
  <li><span class="text-text-primary font-medium">SHA-256 proof-of-work</span> — quantum computers can only achieve a quadratic speedup via Grover\'s algorithm, reducing SHA-256 to 128-bit quantum security — still practically unbreakable.</li>
  <li><span class="text-text-primary font-medium">Real BTC snapshot</span> — genesis commits to a merkle root of 58,001,652 aggregated address balances from BTC block 935,941.</li>
  <li><span class="text-text-primary font-medium">One-time ECDSA claims</span> — prove BTC ownership with a secp256k1 signature, receive your full address balance as quantum-safe QBTC. 1:1 ratio.</li>
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
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Block time</td><td class="py-2 pr-4">10 minutes</td><td class="py-2">10 minutes</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">UTXO model</td><td class="py-2 pr-4">Yes</td><td class="py-2">Yes (same)</td></tr>
    <tr class="border-b border-border last:border-0"><td class="py-2 pr-4 text-text-muted">Address format</td><td class="py-2 pr-4">Base58 / Bech32</td><td class="py-2">64-char hex (SHA-256 of pubkey)</td></tr>
  </tbody>
</table>
</div>

${docH2('Supply')}
${docP('QubitCoin has no premine. The genesis block commits to the BTC snapshot but mints zero coins. All initial supply comes from BTC holders claiming their balances (19,984,411.38 QBTC claimable from 58M addresses). New supply enters circulation through mining rewards at 3.125 QBTC per block, halving every 210,000 blocks.')}`;
}

export function renderDocsGettingStarted(): string {
  return `<h1 class="text-2xl font-bold mb-6">Getting Started</h1>
${docP('Get a QubitCoin node running in under 5 minutes.')}

${docH2('Requirements')}
<ul class="text-text-secondary text-sm leading-relaxed mb-3 list-disc list-inside space-y-1">
  <li><span class="text-text-primary font-medium">Node.js 20+</span></li>
  <li><span class="text-text-primary font-medium">pnpm</span> — enable via <span class="font-mono text-xs text-qubit-400">corepack enable</span></li>
</ul>

${docH2('Install')}
${docCode(`git clone https://github.com/qubitcoin-finance/qubitcoin.git
cd qubitcoin
pnpm install`)}

${docH2('Quick Start — Join the Network')}
${docP('The fastest way to get started. The <span class="font-mono text-xs text-qubit-400">--full</span> flag auto-downloads the BTC snapshot (~3.6 GB) from the default snapshot URL and starts mining immediately:')}
${docCode(`pnpm run qbtcd -- --mine --full`)}
${docP('This will:')}
<ol class="text-text-secondary text-sm leading-relaxed mb-3 list-decimal list-inside space-y-1">
  <li>Download the BTC snapshot from <span class="font-mono text-xs text-qubit-400">qubitcoin.finance/snapshot/qbtc-snapshot.jsonl</span></li>
  <li>Connect to the seed node at <span class="font-mono text-xs text-qubit-400">qubitcoin.finance:6001</span></li>
  <li>Sync the blockchain via Initial Block Download (IBD)</li>
  <li>Generate a mining wallet and start mining blocks</li>
</ol>
${docP('Your node\'s RPC API will be available at <span class="font-mono text-xs text-qubit-400">http://127.0.0.1:3001/api/v1/status</span>.')}

${docH2('Manual Snapshot')}
${docP('If you already have a snapshot file, provide it directly:')}
${docCode(`pnpm run qbtcd -- --mine --snapshot ~/qbtc-snapshot.jsonl`)}

${docH2('Local Development')}
${docP('Run an isolated local chain with easy difficulty and simulated transactions — useful for development and testing:')}
${docCode(`pnpm run qbtcd -- --mine --local --simulate`)}

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
${docP('If you hold BTC in any standard address type (P2PKH, P2PK, P2WPKH, P2SH-P2WPKH, P2TR, P2WSH, or multisig) included in the snapshot, you can claim your balance as QBTC:')}
${docCode(`pnpm run claim`)}
${docP('The interactive claim tool walks you through generating a QBTC wallet, signing a claim message, and broadcasting the transaction. Accepts seed phrases, WIF keys, or hex keys. See the <a href="#/docs/btc-claims" class="text-qubit-400 hover:text-qubit-300">BTC Claims</a> section for details.')}
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
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">--seeds &lt;h:p,...&gt;</td><td class="py-2 pr-4 text-text-muted">auto with --mine/--full</td><td class="py-2">Comma-separated seed peers</td></tr>
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
