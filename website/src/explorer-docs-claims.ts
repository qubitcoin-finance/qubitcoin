// ---------------------------------------------------------------------------
// QubitCoin Block Explorer - docs content: BTC Claims, Security & Wallet Guide
// ---------------------------------------------------------------------------

import { docCode, docH2, docH3, docJson, docP, docSteps } from './explorer-docs-helpers';

export function renderDocsClaims(): string {
  return `<h1 class="text-2xl font-bold mb-6">BTC Claims</h1>
${docP('BTC holders migrate to QubitCoin by submitting a claim transaction that proves ownership of a Bitcoin address. Your full aggregated BTC balance becomes quantum-safe QBTC — no trust, no intermediaries.')}

${docH2('Quick Start')}
${docP('The easiest way to claim is with the interactive CLI tool:')}
${docCode(`pnpm run claim`)}
${docP('This walks you through every step for single-key (P2PKH, P2WPKH, P2SH-P2WPKH, P2TR) and P2WSH claims: generating a QBTC wallet, signing the claim message, and broadcasting the transaction to the network. You\'ll need one of the following for a BTC address included in the snapshot:')}
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
${docH3('Step 1 — Generate a QBTC Wallet')}
${docP('Create a new ML-DSA-65 keypair. This gives you a quantum-safe public key (1,952 bytes) and a QBTC address (SHA-256 hash of the public key, 64-char hex).')}

${docH3('Step 2 — Sign the Claim Message')}
${docP('Construct a claim message and sign it with the native proof scheme for your Bitcoin address type. Legacy and SegWit-v0 key-hash claims use ECDSA secp256k1, Taproot claims use BIP340 Schnorr, and multisig claims collect the required ECDSA signatures for the original script:')}
${docCode(`message = "QBTC_CLAIM:{btcAddress}:{qbtcAddress}:{snapshotBlockHash}:{genesisHash}"
msgHash = doubleSha256(message)
ecdsaSignature = secp256k1.sign(msgHash, btcPrivateKey)   // P2PKH/P2PK/P2WPKH/P2SH-P2WPKH
schnorrSignature = schnorr.sign(msgHash, btcPrivateKey)   // P2TR
witnessSignatures = multisigSigners.map(key => secp256k1.sign(msgHash, key))`)}
${docP('The snapshot block hash and genesis hash act as replay protection — the claim is bound to a specific snapshot and genesis block, preventing cross-fork replay attacks.')}

${docH3('Step 3 — Broadcast the Claim Transaction')}
${docP('Submit a claim transaction containing the proof material required for that BTC script type, plus the destination QBTC address. Single-key claims carry a BTC pubkey and signature, while Taproot and multisig claims carry their native proof fields. The transaction uses a special sentinel input (<span class="font-mono text-xs text-qubit-400">cccc...cccc</span>) to identify it as a claim.')}

${docH3('Step 4 — Network Verification')}
${docP('Every node independently verifies:')}
<ol class="text-text-secondary text-sm leading-relaxed mb-3 list-decimal list-inside space-y-1">
  <li>The submitted proof matches the snapshotted address type: key-hash derivation for P2PKH/P2PK/P2WPKH/P2SH-P2WPKH, Taproot output-key derivation for P2TR, or script-hash derivation for P2SH/P2WSH/bare multisig</li>
  <li>BTC address exists in the snapshot with a non-zero balance</li>
  <li>The claim message signature is valid: ECDSA for legacy, SegWit-v0, and multisig claims; Schnorr for Taproot claims</li>
  <li>Address has not been previously claimed</li>
  <li>Output amount matches the snapshot balance exactly</li>
  <li>Output address matches the qbtcAddress in the claim data</li>
</ol>

${docH3('Step 5 — QBTC Credited')}
${docP('Once the claim transaction is mined into a block, your full aggregated BTC balance appears as a quantum-safe UTXO at your QBTC address. From here, all future transactions use ML-DSA-65 signatures.')}

${docH2('Multisig Claims')}
${docP('For multisig addresses (P2SH multisig, P2WSH, bare multisig), claiming requires m-of-n signers to participate. The process is the same as single-key claims, but multiple private keys sign the claim message.')}

${docH3('How It Works')}
<ol class="text-text-secondary text-sm leading-relaxed mb-3 list-decimal list-inside space-y-1">
  <li>Reconstruct the multisig script — you need the m, n, and all public keys in the original order</li>
  <li>Verify the script hashes to your address: <span class="font-mono text-xs text-entropy-cyan">HASH160(script)</span> for P2SH, <span class="font-mono text-xs text-entropy-cyan">SHA256(script)</span> for P2WSH and bare multisig</li>
  <li>Collect m signatures — each signer signs the same claim message with their private key</li>
  <li>Submit all m signatures in pubkey order (same as Bitcoin's <span class="font-mono text-xs text-qubit-400">OP_CHECKMULTISIG</span>)</li>
</ol>

${docH3('Claim Message')}
${docP('Each signer signs the same message as single-key claims:')}
${docCode('message = "QBTC_CLAIM:{btcAddress}:{qbtcAddress}:{snapshotBlockHash}:{genesisHash}"\nmsgHash = doubleSha256(message)\n\n// Each of the m signers produces:\nsig_i = secp256k1.sign(msgHash, signerPrivateKey_i)')}

${docH3('Verification')}
${docP('The network verifies multisig claims using CHECKMULTISIG ordering: signatures are matched against public keys in order. Signature 1 must correspond to a pubkey at or after the position of the previous match. This is the same ordering rule Bitcoin uses.')}

${docH3('Address Types')}
<div class="overflow-x-auto">
<table class="w-full text-sm mb-4">
  <thead><tr class="text-xs text-text-muted border-b border-border">
    <th class="text-left font-normal pb-2 pr-4">Type</th>
    <th class="text-left font-normal pb-2 pr-4">Address derivation</th>
    <th class="text-left font-normal pb-2">Notes</th>
  </tr></thead>
  <tbody>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">P2SH multisig</td><td class="py-2 pr-4 font-mono text-xs text-qubit-300">HASH160(redeemScript)</td><td class="py-2 text-xs">BIP16 wrapped. <span class="font-mono text-qubit-300">3...</span> addresses shared with P2SH-P2WPKH.</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">P2WSH</td><td class="py-2 pr-4 font-mono text-xs text-qubit-300">SHA256(witnessScript)</td><td class="py-2 text-xs">Native SegWit multisig. Long <span class="font-mono text-qubit-300">bc1q...</span> addresses (32-byte hash).</td></tr>
    <tr class="border-b border-border last:border-0"><td class="py-2 pr-4 text-text-muted">Bare multisig</td><td class="py-2 pr-4 font-mono text-xs text-qubit-300">SHA256(script)</td><td class="py-2 text-xs">Raw <span class="font-mono text-qubit-300">OP_CHECKMULTISIG</span> in output. No standard Bitcoin address — identified by script hash in snapshot.</td></tr>
  </tbody>
</table>
</div>

${docH2('Rules')}
<div class="bg-surface rounded-lg glow-border p-4 mb-4">
<ul class="text-text-secondary text-sm leading-relaxed list-disc list-inside space-y-2">
  <li><span class="text-text-primary font-medium">One claim per address</span> — once a BTC address is claimed, it\'s marked permanently. The same address cannot be claimed again, even with a different QBTC destination.</li>
  <li><span class="text-text-primary font-medium">Aggregated balance</span> — claims are per-address, not per-UTXO. All UTXOs belonging to a BTC address are summed into a single balance. You get everything in one claim.</li>
  <li><span class="text-text-primary font-medium">Supported address types</span> — all standard Bitcoin address types can be claimed: P2PKH, P2WPKH, P2SH-P2WPKH, P2SH multisig, P2TR, P2PK, P2WSH, and bare multisig. Multisig types (P2SH, P2WSH, bare) require m-of-n signers to provide signatures in pubkey order.</li>
  <li><span class="text-text-primary font-medium">1:1 ratio</span> — 1 BTC = 1 QBTC. No conversion rate, no fees, no slippage.</li>
  <li><span class="text-text-primary font-medium">Double-claim prevention</span> — the mempool also rejects claim transactions for addresses that already have a pending claim, preventing double-claims before mining.</li>
</ul>
</div>

${docH2('Snapshot')}
${docP('The current snapshot is derived from a Bitcoin Core <span class="font-mono text-xs text-entropy-cyan">dumptxoutset</span> at block 935,941. The full pipeline:')}
<ol class="text-text-secondary text-sm leading-relaxed mb-3 list-decimal list-inside space-y-1">
  <li>Dump the UTXO set from Bitcoin Core (8.8 GB binary, ~164M coins)</li>
  <li>Parse and filter to supported types: P2PKH, P2PK, P2WPKH, P2SH, P2TR, P2WSH, bare multisig (~164M coins)</li>
  <li>Aggregate by address using external sort + streaming merge (constant memory)</li>
  <li>Compute merkle root and write final NDJSON snapshot</li>
</ol>
<div class="overflow-x-auto">
<table class="w-full text-sm mb-4">
  <tbody>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">BTC block height</td><td class="py-2 font-mono text-qubit-300">935,941</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Raw UTXOs parsed</td><td class="py-2 font-mono">164,352,533</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">After filtering</td><td class="py-2 font-mono">164,274,035 (P2PKH + P2PK + P2WPKH + P2SH + P2TR + P2WSH + multisig)</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Unique addresses</td><td class="py-2 font-mono text-entropy-cyan">58,001,652</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Total claimable</td><td class="py-2 font-mono text-qubit-300">19,984,411.38 QBTC</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">P2PKH coins</td><td class="py-2 font-mono">45,115,135</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">P2PK coins</td><td class="py-2 font-mono">44,617</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">P2WPKH coins</td><td class="py-2 font-mono">46,947,641</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">P2SH coins</td><td class="py-2 font-mono">12,451,522</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">P2TR coins</td><td class="py-2 font-mono">54,668,563</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">P2WSH coins</td><td class="py-2 font-mono">2,489,881</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Bare multisig coins</td><td class="py-2 font-mono">2,556,676</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Snapshot size</td><td class="py-2 font-mono">~3.6 GB (NDJSON)</td></tr>
    <tr class="border-b border-border last:border-0"><td class="py-2 pr-4 text-text-muted">Merkle root</td><td class="py-2 font-mono text-xs break-all">bb0b8c553aa5457e7680baebb35e00ab26d978e05a52c6840ec0b475f5bbdd08</td></tr>
  </tbody>
</table>
</div>

${docH2('Why Not All BTC?')}
${docP('The snapshot covers <span class="text-text-primary font-medium">99.987% of all BTC by value</span>. The remaining 2,618 BTC across 78,498 coins is almost entirely provably burned:')}
<div class="overflow-x-auto">
<table class="w-full text-sm mb-4">
  <thead><tr class="text-xs text-text-muted border-b border-border">
    <th class="text-left font-normal pb-2 pr-4">Category</th>
    <th class="text-left font-normal pb-2 pr-4">Coins</th>
    <th class="text-left font-normal pb-2 pr-4">BTC</th>
    <th class="text-left font-normal pb-2">Why not claimable</th>
  </tr></thead>
  <tbody>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Burned P2PKH</td><td class="py-2 pr-4 font-mono text-xs">23</td><td class="py-2 pr-4 font-mono text-xs text-red-400">2,609</td><td class="py-2 text-xs">P2PKH outputs with <span class="font-mono text-qubit-300">OP_0</span> instead of a 20-byte hash. <span class="font-mono text-xs">HASH160(pubkey)</span> can never equal an empty byte array — <span class="text-text-primary font-medium">permanently unspendable</span> by anyone, on any chain. All from block 150,951 (2011).</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">SegWit v12+</td><td class="py-2 pr-4 font-mono text-xs">~65,000</td><td class="py-2 pr-4 font-mono text-xs">0.40</td><td class="py-2 text-xs">Runes/Ordinals dust carriers (546 sats each). Future SegWit versions with no defined spending rules.</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Hash puzzles</td><td class="py-2 pr-4 font-mono text-xs">4</td><td class="py-2 pr-4 font-mono text-xs">1.00</td><td class="py-2 text-xs"><span class="font-mono text-qubit-300">OP_HASH256 &lt;hash&gt; OP_EQUAL</span> — no key ownership. Requires a hash preimage to spend, not a signature.</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Merged mining</td><td class="py-2 pr-4 font-mono text-xs">~53</td><td class="py-2 pr-4 font-mono text-xs">0.00</td><td class="py-2 text-xs">RSK sidechain commitment markers (<span class="font-mono text-qubit-300">0xfabe6d6d</span>). Data embedding, not spendable outputs.</td></tr>
    <tr class="border-b border-border last:border-0"><td class="py-2 pr-4 text-text-muted">Other exotic</td><td class="py-2 pr-4 font-mono text-xs">~12,000</td><td class="py-2 pr-4 font-mono text-xs">7.15</td><td class="py-2 text-xs">Malformed scripts, data embedding, ASCII art, padded outputs. No standard key ownership to verify.</td></tr>
  </tbody>
</table>
</div>
${docP('In short: the vast majority of the gap is <span class="text-text-primary font-medium">2,609 BTC that was burned in 2011</span> — permanently lost regardless of chain. The rest is dust, data embedding, and scripts with no key-based ownership that could be verified through a claim.')}`;
}

export function renderDocsSecurity(): string {
  return `<h1 class="text-2xl font-bold mb-6">Security</h1>
${docP('QubitCoin exists because of a single, inevitable threat: sufficiently large quantum computers will break every elliptic-curve and RSA-based signature scheme in use today. This section explains the threat model, the design choices, and why QBTC is safe.')}

${docH2('The Quantum Threat Model')}
${docP('Shor\'s algorithm, running on a cryptographically relevant quantum computer (CRQC), solves the discrete logarithm and integer factorization problems in polynomial time. This breaks:')}
<ul class="text-text-secondary text-sm leading-relaxed mb-3 list-disc list-inside space-y-1">
  <li><span class="text-red-400 font-medium">ECDSA secp256k1</span> — Bitcoin signatures</li>
  <li><span class="text-red-400 font-medium">RSA</span> — TLS certificates, PGP</li>
  <li><span class="text-red-400 font-medium">Ed25519 / EdDSA</span> — Solana, Cardano, SSH keys</li>
</ul>
${docP('Grover\'s algorithm provides only a <span class="text-text-primary font-medium">quadratic</span> speedup for brute-force search, reducing SHA-256 from 256-bit to 128-bit quantum security — still practically unbreakable.')}
${docP('Timeline estimates for a CRQC vary widely: <span class="text-text-primary font-medium">10-30+ years</span>. But the "harvest now, decrypt later" threat is real today — an adversary can record public keys from the blockchain now and derive private keys once quantum hardware matures. Every BTC address that has ever broadcast a transaction has its public key exposed on-chain.')}

${docH2('Why ML-DSA-65')}
${docP('ML-DSA-65 (formerly Dilithium, standardized as <span class="text-qubit-400 font-mono text-xs">FIPS 204</span>) is a lattice-based digital signature algorithm selected by NIST after a multi-year post-quantum standardization process. Its security relies on the Module Learning With Errors (MLWE) problem — no known quantum algorithm can efficiently solve it.')}
<div class="overflow-x-auto">
<table class="w-full text-sm mb-4">
  <thead><tr class="text-xs text-text-muted border-b border-border">
    <th class="text-left font-normal pb-2 pr-4">Scheme</th>
    <th class="text-left font-normal pb-2 pr-4">Type</th>
    <th class="text-left font-normal pb-2 pr-4">PK size</th>
    <th class="text-left font-normal pb-2 pr-4">Sig size</th>
    <th class="text-left font-normal pb-2 pr-4">Standardized</th>
    <th class="text-left font-normal pb-2">Notes</th>
  </tr></thead>
  <tbody>
    <tr class="border-b border-border text-qubit-400"><td class="py-2 pr-4 font-medium">ML-DSA-65</td><td class="py-2 pr-4">Lattice</td><td class="py-2 pr-4 font-mono text-xs">1,952 B</td><td class="py-2 pr-4 font-mono text-xs">3,309 B</td><td class="py-2 pr-4 text-green-400">FIPS 204</td><td class="py-2 text-xs">NIST Level 3. Balanced size/speed.</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4">Falcon-512</td><td class="py-2 pr-4">Lattice</td><td class="py-2 pr-4 font-mono text-xs">897 B</td><td class="py-2 pr-4 font-mono text-xs">666 B</td><td class="py-2 pr-4 text-green-400">FIPS 206</td><td class="py-2 text-xs">Smallest sigs, but complex sampling (timing side-channels).</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4">SLH-DSA-128s</td><td class="py-2 pr-4">Hash</td><td class="py-2 pr-4 font-mono text-xs">32 B</td><td class="py-2 pr-4 font-mono text-xs">7,856 B</td><td class="py-2 pr-4 text-green-400">FIPS 205</td><td class="py-2 text-xs">Conservative (hash-only), but large sigs and slow signing.</td></tr>
    <tr class="border-b border-border last:border-0"><td class="py-2 pr-4">ECDSA secp256k1</td><td class="py-2 pr-4">Elliptic curve</td><td class="py-2 pr-4 font-mono text-xs">33 B</td><td class="py-2 pr-4 font-mono text-xs">~72 B</td><td class="py-2 pr-4 text-red-400">Quantum-broken</td><td class="py-2 text-xs">Current Bitcoin. Broken by Shor\'s algorithm.</td></tr>
  </tbody>
</table>
</div>
${docP('ML-DSA-65 was chosen for its balance of properties: NIST-standardized, straightforward constant-time implementation, fast verification, and no complex sampling logic that could introduce side-channel vulnerabilities.')}

${docH2('Key Size Tradeoffs')}
${docP('Post-quantum signatures are significantly larger than classical ones. This is the fundamental tradeoff for quantum resistance:')}
<div class="overflow-x-auto">
<table class="w-full text-sm mb-4">
  <thead><tr class="text-xs text-text-muted border-b border-border">
    <th class="text-left font-normal pb-2 pr-4">Metric</th>
    <th class="text-left font-normal pb-2 pr-4">ECDSA (Bitcoin)</th>
    <th class="text-left font-normal pb-2">ML-DSA-65 (QBTC)</th>
  </tr></thead>
  <tbody>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Public key</td><td class="py-2 pr-4 font-mono text-xs">33 bytes</td><td class="py-2 font-mono text-xs text-qubit-300">1,952 bytes</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Signature</td><td class="py-2 pr-4 font-mono text-xs">~72 bytes</td><td class="py-2 font-mono text-xs text-qubit-300">3,309 bytes</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Secret key</td><td class="py-2 pr-4 font-mono text-xs">32 bytes</td><td class="py-2 font-mono text-xs text-qubit-300">4,032 bytes</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Minimal 1-in/1-out tx</td><td class="py-2 pr-4 font-mono text-xs">~226 bytes</td><td class="py-2 font-mono text-xs text-qubit-300">~5,400 bytes</td></tr>
    <tr class="border-b border-border last:border-0"><td class="py-2 pr-4 text-text-muted">Txs per 1 MB block</td><td class="py-2 pr-4 font-mono text-xs">~4,400</td><td class="py-2 font-mono text-xs text-qubit-300">~180</td></tr>
  </tbody>
</table>
</div>
${docP('QubitCoin keeps Bitcoin\'s 10-minute block cadence. Because each post-quantum transaction is larger, each 1 MB block fits fewer transactions and miners still rely on fees to prioritize demand.')}

${docH2('SHA-256 PoW Security')}
${docP('QubitCoin uses the same double-SHA-256 proof-of-work as Bitcoin. Unlike signature schemes, hash functions are <span class="text-text-primary font-medium">not broken</span> by quantum computers.')}
${docP('Grover\'s algorithm gives a quadratic speedup: SHA-256\'s 2<sup>256</sup> preimage resistance becomes 2<sup>128</sup> quantum operations. For context, 2<sup>128</sup> operations is still astronomically large — roughly the same security level as AES-128, which is considered safe for decades to come.')}
${docP('Crucially, PoW has no "break once, steal forever" property. Even if a quantum computer could mine faster, it would only gain a proportional hashrate advantage — similar to a more efficient ASIC. It cannot retroactively steal funds or forge signatures.')}

${docH2('Claim Safety')}
${docP('The BTC claim process involves a one-time Bitcoin proof to show ownership of the snapshotted address. Legacy, SegWit-v0, and multisig claims use ECDSA; Taproot claims use Schnorr. This is the only moment classical Bitcoin cryptography is used, and several safeguards protect it:')}
<div class="overflow-x-auto">
<table class="w-full text-sm mb-4">
  <thead><tr class="text-xs text-text-muted border-b border-border">
    <th class="text-left font-normal pb-2 pr-4">Protection</th>
    <th class="text-left font-normal pb-2">How</th>
  </tr></thead>
  <tbody>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-primary font-medium">One-time exposure</td><td class="py-2 text-xs">The Bitcoin key is used once during the claim. After that, all QBTC operations use ML-DSA-65.</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-primary font-medium">Snapshot binding</td><td class="py-2 text-xs">The claim message includes the BTC snapshot block hash, binding the signature to a specific chain state. Cannot be replayed on a different fork.</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-primary font-medium">Double-claim prevention</td><td class="py-2 text-xs">Each BTC address can only be claimed once. The chain tracks claimed addresses permanently.</td></tr>
    <tr class="border-b border-border last:border-0"><td class="py-2 pr-4 text-text-primary font-medium">Address-type verification</td><td class="py-2 text-xs">Each address type uses its native verification: ECDSA for P2PKH/P2PK/P2WPKH/P2SH-P2WPKH/P2SH multisig/P2WSH/bare multisig, Schnorr for P2TR.</td></tr>
  </tbody>
</table>
</div>

${docH2('Address Security')}
${docP('QubitCoin addresses are derived as <span class="font-mono text-xs text-qubit-400">SHA-256(publicKey)</span> — a 64-character hex string. This follows the same principle as Bitcoin\'s HASH160: the public key is hidden until a transaction is broadcast.')}
${docP('An address that has received QBTC but never sent a transaction has its public key completely concealed. Even with a quantum computer, an attacker would need to break SHA-256 preimage resistance (2<sup>128</sup> quantum ops) to recover the public key from the address — which is infeasible.')}

${docH2('No Premine, No Trust')}
${docP('QubitCoin has <span class="text-text-primary font-medium">zero premine</span>. The genesis block commits to the BTC snapshot merkle root but mints no coins. All initial supply comes exclusively from BTC holders claiming their balances.')}
<ul class="text-text-secondary text-sm leading-relaxed mb-3 list-disc list-inside space-y-1">
  <li><span class="text-text-primary font-medium">Verifiable snapshot</span> — the merkle root in genesis is computed deterministically from Bitcoin Core\'s <span class="font-mono text-xs text-qubit-400">dumptxoutset</span> output. Anyone can reproduce it.</li>
  <li><span class="text-text-primary font-medium">Open source</span> — all code is public. The snapshot pipeline, claim verification, and consensus rules can be audited independently.</li>
  <li><span class="text-text-primary font-medium">No admin keys</span> — there are no special keys, backdoors, or governance multisigs. The chain runs by consensus rules alone.</li>
</ul>`;
}

export function renderDocsWallet(): string {
  return `<h1 class="text-2xl font-bold mb-6">Wallet Guide</h1>
${docP('Once you\'ve claimed your BTC or received QBTC from another user, you need to understand how wallets, balances, and transactions work in QubitCoin.')}

${docH2('Wallet Basics')}
${docP('A QubitCoin wallet is an ML-DSA-65 keypair — a public key and a secret key. The address is derived as <span class="font-mono text-xs text-qubit-400">SHA-256(publicKey)</span>, producing a 64-character hex string.')}
<div class="overflow-x-auto">
<table class="w-full text-sm mb-4">
  <tbody>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Public key</td><td class="py-2 font-mono text-qubit-300">1,952 bytes (3,904 hex chars)</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 text-text-muted">Secret key</td><td class="py-2 font-mono text-qubit-300">4,032 bytes (8,064 hex chars)</td></tr>
    <tr class="border-b border-border last:border-0"><td class="py-2 pr-4 text-text-muted">Address</td><td class="py-2 font-mono text-qubit-300">32 bytes (64 hex chars)</td></tr>
  </tbody>
</table>
</div>
${docH3('Generating a Wallet')}
${docCode(`import { generateWallet } from './crypto.js';

const wallet = generateWallet();
console.log('Address:', wallet.address);    // 64-char hex
console.log('PK size:', wallet.publicKey.length);  // 1952 bytes
console.log('SK size:', wallet.secretKey.length);  // 4032 bytes`)}
${docP('The node daemon loads or generates a wallet when <span class="font-mono text-xs text-qubit-400">--mine</span> is enabled. The wallet is saved to <span class="font-mono text-xs text-qubit-400">wallet.json</span> in the data directory and reloaded on subsequent runs, so mining rewards always go to the same address.')}

${docH2('Checking Your Balance')}
${docP('Query the RPC API to check the balance and UTXOs for any address:')}
${docH3('Get Balance')}
${docCode(`curl -s http://127.0.0.1:3001/api/v1/address/<address>/balance | jq`)}
${docJson(`{
  "balance": 625000000  // 6.25 QBTC in satoshis
}`)}
${docH3('List UTXOs')}
${docCode(`curl -s http://127.0.0.1:3001/api/v1/address/<address>/utxos | jq`)}
${docJson(`[
  {
    "txId": "a1b2c3...64hex",
    "outputIndex": 0,
    "address": "deadbeef...64hex",
    "amount": 312500000
  },
  {
    "txId": "d4e5f6...64hex",
    "outputIndex": 1,
    "address": "deadbeef...64hex",
    "amount": 312500000
  }
]`)}
${docP('You can also use the <a href="#/docs/api" class="text-qubit-400 hover:text-qubit-300">block explorer</a> to look up any address visually.')}
${docP('All amounts are in <strong>satoshis</strong> (1 QBTC = 100,000,000 satoshis). The explorer displays amounts in QBTC for readability.')}

${docH2('Sending QBTC')}
${docP('Transactions follow the UTXO model: you select unspent outputs as inputs, specify new outputs (recipients + change), and sign with your ML-DSA-65 secret key. All amounts are integer satoshis.')}
${docH3('Step by Step')}
${docSteps([
  '<span class="text-text-primary font-medium">Select UTXOs</span> — choose inputs whose total value covers the amount + fee',
  '<span class="text-text-primary font-medium">Define outputs</span> — recipient address(es) and amounts (in satoshis). Send change back to yourself.',
  '<span class="text-text-primary font-medium">Calculate fee</span> — fee = total inputs &minus; total outputs. The difference goes to the miner.',
  '<span class="text-text-primary font-medium">Sign &amp; build</span> — <span class="font-mono text-xs text-qubit-400">createTransaction(wallet, utxos, recipients, fee)</span> signs and returns the full tx.',
  '<span class="text-text-primary font-medium">Broadcast</span> — POST the transaction to any node\'s RPC endpoint.',
])}
${docH3('Code Example')}
${docCode(`import { generateWallet } from './crypto.js';
import { createTransaction } from './transaction.js';

const wallet = generateWallet();
// Amounts are in satoshis (1 QBTC = 100,000,000 sat)
const utxos = [{ txId: 'abc...', outputIndex: 0, address: wallet.address, amount: 1000000000 }];
const recipients = [{ address: 'recipient_address_64hex', amount: 950000000 }];
const fee = 50000000;

const tx = createTransaction(wallet, utxos, recipients, fee);
// tx.id is the transaction hash`)}
${docH3('Broadcasting')}
${docCode(`curl -X POST http://127.0.0.1:3001/api/v1/tx \\
  -H "Content-Type: application/json" \\
  -d '<full tx JSON>'`)}

${docH2('Transaction Fees')}
${docP('The transaction fee is implicit: <span class="font-mono text-xs text-qubit-400">fee = sum(inputs) - sum(outputs)</span>. The miner who includes your transaction in a block collects the fee.')}
<ul class="text-text-secondary text-sm leading-relaxed mb-3 list-disc list-inside space-y-1">
  <li><span class="text-text-primary font-medium">No minimum fee</span> — consensus does not enforce a minimum, but miners may ignore zero-fee transactions.</li>
  <li><span class="text-text-primary font-medium">Miner prioritization</span> — miners are free to order transactions by fee density (fee per byte) or any other policy.</li>
  <li><span class="text-text-primary font-medium">Larger transactions</span> — ML-DSA-65 signatures are ~3.3 KB each, so multi-input transactions are large. Plan fees accordingly.</li>
</ul>

${docH2('UTXO Management')}
${docP('Over time, your address will accumulate multiple UTXOs — from mining rewards, claims, and received payments. Each UTXO can only be spent as a whole (you create change outputs for the remainder).')}
${docH3('Consolidation')}
${docP('If you have many small UTXOs, spending them all at once requires one ML-DSA-65 signature per input (~5.3 KB each). To avoid creating very large transactions, periodically consolidate by sending your full balance to yourself in a single transaction:')}
${docCode(`// Consolidate all UTXOs into one
const allUtxos = await fetchUtxos(wallet.address);
const total = allUtxos.reduce((s, u) => s + u.amount, 0);
const fee = 10000000; // 0.1 QBTC in satoshis
const tx = createTransaction(wallet, allUtxos, [{ address: wallet.address, amount: total - fee }], fee);`)}
${docH3('Dust Threshold')}
${docP('Because ML-DSA-65 signatures are ~3.3 KB, spending a tiny UTXO can cost more in fees than the UTXO is worth. There is no consensus-enforced minimum fee — miners choose which transactions to include. With typical fees around <span class="font-mono text-xs text-qubit-400">1,000 sat (0.00001 QBTC)</span>, outputs below that threshold are effectively unspendable dust.')}

${docH2('Key Management')}
<ul class="text-text-secondary text-sm leading-relaxed mb-3 list-disc list-inside space-y-1">
  <li><span class="text-text-primary font-medium">Secret key is 4,032 bytes</span> — back it up as an 8,064-character hex string. There is no mnemonic/BIP39 support yet.</li>
  <li><span class="text-text-primary font-medium">No HD wallet</span> — each wallet is a single keypair. Hierarchical deterministic derivation (BIP32) is not yet implemented.</li>
  <li><span class="text-text-primary font-medium">Node wallet is ephemeral</span> — the mining wallet generated by <span class="font-mono text-xs text-qubit-400">qbtcd --mine</span> exists only in memory. If the node restarts, a new wallet is generated and mining rewards go to the new address.</li>
  <li><span class="text-text-primary font-medium">Offline signing</span> — you can construct and sign transactions on an air-gapped machine, then broadcast the signed JSON from any online node.</li>
</ul>`;
}
