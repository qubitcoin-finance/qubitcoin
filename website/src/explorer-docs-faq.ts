// ---------------------------------------------------------------------------
// QubitCoin Block Explorer - docs content: FAQ
// ---------------------------------------------------------------------------

import { docH2 } from './explorer-docs-helpers';

function docFaqItem(q: string, a: string): string {
  return `<div class="border-b border-border py-4">
<h3 class="text-sm font-semibold text-text-primary mb-2">${q}</h3>
<p class="text-text-secondary text-sm leading-relaxed">${a}</p>
</div>`;
}

export function renderDocsFaq(): string {
  return `<h1 class="text-2xl font-bold mb-6">FAQ</h1>

${docH2('General')}
<div class="bg-surface rounded-xl glow-border p-5 mb-6">
${docFaqItem('What is QubitCoin?',
  'QubitCoin (QBTC) is a post-quantum fork of Bitcoin. It replaces ECDSA secp256k1 with ML-DSA-65 (FIPS 204), a lattice-based signature scheme that resists quantum attacks. BTC holders can claim their balance as quantum-safe QBTC.')}
${docFaqItem('Is this a fork of Bitcoin\'s codebase?',
  'No. QubitCoin is a clean-room implementation in TypeScript. It preserves Bitcoin\'s <span class="text-text-primary font-medium">UTXO model</span> and <span class="text-text-primary font-medium">SHA-256 PoW</span> but uses an entirely new codebase. The "fork" refers to the economic state — the BTC UTXO snapshot — not the code.')}
${docFaqItem('Do I need to run a Bitcoin node?',
  'No. The BTC snapshot is pre-computed and distributed as a single file. You only need a QubitCoin node. Run <span class="font-mono text-xs text-qubit-400">pnpm run qbtcd -- --mine --full</span> to auto-download the snapshot and start.')}
${docFaqItem('What happens to my BTC?',
  'Nothing. Claiming QBTC does not move, lock, or affect your BTC in any way. You sign a message with your BTC private key to prove ownership — no BTC transaction is broadcast. Your BTC remains exactly where it is.')}
${docFaqItem('Is this production-ready?',
  'QubitCoin is a <span class="text-text-primary font-medium">proof of concept</span>. It demonstrates a working post-quantum blockchain with real BTC balance migration. It is not audited, does not have formal security proofs, and should not be used for high-value transactions.')}
</div>

${docH2('Claims')}
<div class="bg-surface rounded-xl glow-border p-5 mb-6">
${docFaqItem('Is my BTC safe during the claim process?',
  'Yes. The claim process only requires you to <span class="text-text-primary font-medium">sign a message</span> with your BTC private key — it does not create or broadcast any Bitcoin transaction. Your BTC never moves.')}
${docFaqItem('My address isn\'t in the snapshot — what do I do?',
  'The snapshot was taken at BTC block 935,941. Only addresses with a balance at that height are included. If you received BTC after that block, or if your address type isn\'t supported yet, it won\'t appear in the snapshot.')}
${docFaqItem('Can I claim from multiple BTC addresses?',
  'Yes. Each BTC address is claimed independently. You can claim from as many addresses as you own — each one creates a separate claim transaction on the QBTC chain.')}
${docFaqItem('Which BTC address types are supported?',
  'Currently supported: <span class="text-text-primary font-medium">P2PKH</span> (1...), <span class="text-text-primary font-medium">P2PK</span> (raw pubkey), <span class="text-text-primary font-medium">P2WPKH</span> (bc1q...), <span class="text-text-primary font-medium">P2SH-P2WPKH</span> (3...), <span class="text-text-primary font-medium">P2TR</span> (bc1p...), and <span class="text-text-primary font-medium">P2WSH</span> (bc1q... long). See <a href="#/docs/btc-claims" class="text-qubit-400 hover:text-qubit-300">BTC Claims</a> for details.')}
${docFaqItem('Is there a deadline to claim?',
  'No. There is no expiration. The snapshot is permanently committed in the genesis block. You can claim at any time — even years from now.')}
${docFaqItem('What if I lose my QBTC private key after claiming?',
  'Your QBTC is gone. There is no recovery mechanism. The BTC address is marked as claimed permanently and cannot be claimed again. Always back up your ML-DSA-65 secret key (8,064 hex characters) before claiming.')}
</div>

${docH2('Security')}
<div class="bg-surface rounded-xl glow-border p-5 mb-6">
${docFaqItem('When will quantum computers break Bitcoin?',
  'Estimates range from 10 to 30+ years for a cryptographically relevant quantum computer. The exact timeline is uncertain, but the "harvest now, decrypt later" threat means exposed public keys are at risk <span class="text-text-primary font-medium">today</span> — an adversary can record them now and crack them later.')}
${docFaqItem('Is QBTC already safe from quantum attacks?',
  'Yes. All ongoing QBTC transactions use ML-DSA-65 (FIPS 204), whose security relies on the Module-LWE problem — no known quantum algorithm can solve it efficiently. The one-time ECDSA claim is the only classical cryptography exposure.')}
${docFaqItem('What about 51% attacks?',
  'QubitCoin uses SHA-256 PoW, same as Bitcoin. A quantum computer using Grover\'s algorithm could achieve a quadratic speedup in mining, but this is equivalent to having better hardware — not a fundamental break. The difficulty adjustment compensates for hashrate changes.')}
${docFaqItem('What if ML-DSA-65 is broken in the future?',
  'If a vulnerability is found in ML-DSA-65, the network would need to migrate to a different post-quantum scheme via a hard fork. This is an inherent risk of any cryptographic system. NIST\'s multi-year standardization process and ongoing cryptanalysis provide confidence in ML-DSA-65\'s security.')}
</div>

${docH2('Technical')}
<div class="bg-surface rounded-xl glow-border p-5 mb-6">
${docFaqItem('Why 30-minute block times instead of 10 minutes?',
  'ML-DSA-65 signatures are ~3.3 KB vs ECDSA\'s ~72 bytes. With a 1 MB block size limit, each block fits ~180 transactions. The 30-minute block time gives the fee market more time to accumulate transactions, improving block utilization.')}
${docFaqItem('Why NIST Security Level 3 instead of Level 5?',
  'Level 3 (ML-DSA-65) provides 128-bit quantum security, matching AES-128. Level 5 (ML-DSA-87) would increase key sizes by ~50% and signature sizes by ~40% for 192-bit quantum security — diminishing returns given that 128-bit quantum security is already considered infeasible to break.')}
${docFaqItem('Why are transactions so large?',
  'Each input requires a full ML-DSA-65 public key (1,952 bytes) and signature (3,309 bytes) — about 5.3 KB per input. A single-input transaction is ~5.4 KB. This is the fundamental cost of post-quantum security. See <a href="#/docs/security" class="text-qubit-400 hover:text-qubit-300">Security</a> for the tradeoff analysis.')}
${docFaqItem('Why NDJSON for storage instead of a binary format?',
  'NDJSON (newline-delimited JSON) is human-readable, append-only, and trivially streamable. It\'s ideal for a proof of concept — easy to inspect and debug. A production system would likely use a more compact binary format.')}
${docFaqItem('Why no scripting language (like Bitcoin Script)?',
  'QubitCoin is a proof of concept focused on demonstrating post-quantum signatures. Adding a scripting language would add complexity without advancing the core goal. Transactions support simple pay-to-address outputs and claim transactions.')}
${docFaqItem('How does the snapshot merkle root work?',
  'The merkle root is a SHA-256 hash tree over all 58,001,652 address-balance pairs, sorted by address. It\'s committed in the genesis block\'s coinbase. Any node can independently recompute it from the snapshot file and verify it matches genesis — ensuring the snapshot hasn\'t been tampered with.')}
</div>

${docH2('Troubleshooting')}
<div class="bg-surface rounded-xl glow-border p-5 mb-6">
${docFaqItem('My node won\'t sync',
  'Check that you can reach the seed node: <span class="font-mono text-xs text-qubit-400">curl -s https://qubitcoin.finance/api/v1/status | jq</span>. Ensure port <span class="font-mono text-xs text-qubit-400">6001</span> (P2P) is not blocked by a firewall. Check logs for "genesis hash mismatch" — this means your snapshot doesn\'t match the network\'s genesis block.')}
${docFaqItem('My claim was rejected',
  'Common causes: <span class="text-text-primary font-medium">(1)</span> Address not in snapshot — check the snapshot was loaded. <span class="text-text-primary font-medium">(2)</span> Already claimed — each address can only be claimed once. <span class="text-text-primary font-medium">(3)</span> Invalid signature — wrong private key or key type mismatch. <span class="text-text-primary font-medium">(4)</span> Address type mismatch — e.g. using a P2PKH claim for a P2SH address.')}
${docFaqItem('Snapshot download fails or is slow',
  'The snapshot is ~3.6 GB. Download it manually with <span class="font-mono text-xs text-qubit-400">curl -L -o ~/qbtc-snapshot.jsonl https://qubitcoin.finance/snapshot/qbtc-snapshot.jsonl</span> and pass it with <span class="font-mono text-xs text-qubit-400">--snapshot ~/qbtc-snapshot.jsonl</span>.')}
${docFaqItem('Node uses too much memory',
  'The snapshot loads into memory (~4-6 GB for 54M entries). Use <span class="font-mono text-xs text-qubit-400">--max-old-space-size=12288</span> with Node.js if you have enough RAM. Without a snapshot (local dev mode), memory usage is minimal.')}
${docFaqItem('"Blocks failed replay" on startup',
  'This means stored blocks don\'t validate against current consensus rules. Usually caused by changing consensus parameters (<span class="font-mono text-xs text-qubit-400">STARTING_DIFFICULTY</span>, <span class="font-mono text-xs text-qubit-400">TARGET_BLOCK_TIME_MS</span>, <span class="font-mono text-xs text-qubit-400">DIFFICULTY_ADJUSTMENT_INTERVAL</span>) or using a different snapshot. Delete <span class="font-mono text-xs text-qubit-400">{datadir}/blocks.jsonl</span> and <span class="font-mono text-xs text-qubit-400">metadata.json</span> to start fresh.')}
</div>`;
}
