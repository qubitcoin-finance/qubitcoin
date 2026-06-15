// ---------------------------------------------------------------------------
// QubitCoin Block Explorer - docs content: Architecture, Consensus & P2P
// ---------------------------------------------------------------------------

import { docCode, docH2, docH3, docP, docSteps } from './explorer-docs-helpers';

export function renderDocsArchitecture(): string {
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
  amount:  number             // QBTC amount
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
${docP('The larger key and signature sizes (vs ECDSA\'s 33-byte keys and ~72-byte signatures) are the tradeoff for quantum resistance. The 1 MB max block size accommodates fewer transactions per block, so effective throughput is lower than Bitcoin\'s even with the same 10-minute cadence.')}

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
  "QBTC_FORK:{btcBlockHeight}:{btcBlockHash}:{snapshotMerkleRoot}"

Example:
  "QBTC_FORK:935941:00000...abc:a2c2ddc7...c61af1"`)}
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

export function renderDocsConsensus(): string {
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
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">TARGET_BLOCK_TIME_MS</td><td class="py-2 pr-4">10 minutes</td><td class="py-2 text-text-muted">Target time between blocks (600,000 ms)</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">DIFFICULTY_ADJUSTMENT_INTERVAL</td><td class="py-2 pr-4">10 blocks</td><td class="py-2 text-text-muted">Blocks between difficulty recalculations</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">MAX_BLOCK_SIZE</td><td class="py-2 pr-4">1,000,000 bytes</td><td class="py-2 text-text-muted">Maximum serialized block size (1 MB)</td></tr>
    <tr class="border-b border-border"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">INITIAL_SUBSIDY</td><td class="py-2 pr-4">3.125 QBTC</td><td class="py-2 text-text-muted">Block reward at launch</td></tr>
    <tr class="border-b border-border last:border-0"><td class="py-2 pr-4 font-mono text-xs text-qubit-300">HALVING_INTERVAL</td><td class="py-2 pr-4">210,000 blocks</td><td class="py-2 text-text-muted">Blocks between reward halvings</td></tr>
  </tbody>
</table>
</div>

${docH2('Difficulty Adjustment')}
${docP('Every 10 blocks, the network recalculates the mining difficulty target. The algorithm compares the actual time taken for the last interval to the expected time:')}
${docCode(`expectedTime = (DIFFICULTY_ADJUSTMENT_INTERVAL - 1) × TARGET_BLOCK_TIME
             = 9 × 10 min = 90 min

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
${docP('Every block includes a coinbase transaction that mints new QBTC. The reward starts at <span class="font-mono text-xs text-qubit-400">3.125 QBTC</span> per block — matching Bitcoin\'s post-4th-halving reward schedule.')}
${docCode(`blockSubsidy(height) = INITIAL_SUBSIDY / 2^(height / HALVING_INTERVAL)
                     = 3.125 / 2^(height / 210,000)

Height 0–209,999:       3.125 QBTC
Height 210,000–419,999: 1.5625 QBTC
Height 420,000–629,999: 0.78125 QBTC
...
After 26 halvings:      0 QBTC (all subsidy exhausted)`)}
${docP('Miners also collect transaction fees — the difference between total inputs and total outputs for non-coinbase transactions in the block.')}

${docH3('Supply Schedule')}
${docP('New QBTC enters circulation from two sources:')}
<ul class="text-text-secondary text-sm leading-relaxed mb-3 list-disc list-inside space-y-1">
  <li><span class="text-text-primary font-medium">BTC claims</span> — QBTC claimable from the snapshot (P2PKH, P2PK, P2WPKH, P2SH-P2WPKH, P2SH multisig, P2TR, P2WSH, bare multisig)</li>
  <li><span class="text-text-primary font-medium">Mining rewards</span> — 3.125 QBTC per block, halving every 210,000 blocks</li>
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

export function renderDocsP2p(): string {
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
