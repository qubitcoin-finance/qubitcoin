import { type BlogPost, h2, p } from './types.js';

const post: BlogPost = {
  slug: 'o1-transaction-index',
  title: 'From O(n) Scan to O(1) Lookup: Indexing Transactions in a UTXO Chain',
  date: '2026-04-30',
  tags: ['technical', 'engineering', 'development'],
  excerpt: 'Finding a transaction by ID used to require scanning every block in the chain. We replaced that linear scan with an in-memory hash map, wired it into the undo log to survive reorgs, and cut RPC lookup cost to constant time.',
  content: () => `<h1 class="text-2xl font-bold mb-2">From O(n) Scan to O(1) Lookup: Indexing Transactions in a UTXO Chain</h1>
<p class="text-text-muted text-xs font-mono mb-8">2026-04-30</p>
${p('The block explorer loads fast now. It did not always. For most of early testnet, the <span class="font-mono text-xs text-qubit-400">GET /api/v1/tx/:txid</span> endpoint was hiding a linear scan that grew more expensive with every block mined. This is the story of how we found it and fixed it — and why getting reorg safety right was the interesting part.')}
${h2('The Problem: a Nested Loop at Query Time')}
${p('A UTXO chain stores transactions inside blocks, not in a flat table. When the RPC handler needed to return a transaction by ID, it had nowhere to look except the block list:')}
${p('<span class="font-mono text-xs text-qubit-400 block bg-surface rounded p-3 mb-2">for (const block of node.chain.blocks) {<br>&nbsp;&nbsp;const foundTx = block.transactions.find(t => t.id === txid);<br>&nbsp;&nbsp;if (foundTx) { res.json(sanitize(foundTx)); return; }<br>}</span>')}
${p('Every <span class="font-mono text-xs text-qubit-400">GET /tx</span> call walks the entire chain from genesis. On a fresh testnet with a few hundred blocks the latency is invisible. On a chain running for months — or on mainnet with hundreds of thousands of blocks — it becomes a scan that runs in proportion to chain length. The block explorer hits this endpoint for every transaction it renders, so a busy page could trigger dozens of linear scans in a single user request.')}
${h2('The Fix: a Map Already in the Right Place')}
${p('The <span class="font-mono text-xs text-qubit-400">Blockchain</span> class already maintained an O(1) structure for a similar problem. The <span class="font-mono text-xs text-qubit-400">utxosByAddress</span> map lets the node answer "what UTXOs does this address own?" in constant time rather than scanning the entire UTXO set. The transaction index follows the same pattern:')}
${p('<span class="font-mono text-xs text-qubit-400 block bg-surface rounded p-3 mb-2">/** Transaction ID → Block for O(1) transaction lookups */<br>private transactionIndex: Map&lt;string, Block&gt; = new Map()</span>')}
${p('The key is the transaction ID (a 64-character hex hash). The value is a reference to the <span class="font-mono text-xs text-qubit-400">Block</span> object that contains it — not a copy. When the RPC handler needs the full transaction, it calls <span class="font-mono text-xs text-qubit-400">findTransactionBlock(txid)</span>, then does a single <span class="font-mono text-xs text-qubit-400">.find()</span> over that block\'s transactions to get the object back. The chain-level scan is gone; only the per-block scan remains, and a block holds at most a few thousand transactions.')}
${h2('Populating the Index During Block Application')}
${p('The index is built incrementally as blocks are connected to the chain. Inside <span class="font-mono text-xs text-qubit-400">applyBlock</span>, after the block passes all validation checks, every transaction gets registered:')}
${p('<span class="font-mono text-xs text-qubit-400 block bg-surface rounded p-3 mb-2">for (const tx of block.transactions) {<br>&nbsp;&nbsp;this.transactionIndex.set(tx.id, block)<br>&nbsp;&nbsp;undo.transactionIds.push(tx.id)<br>}</span>')}
${p('The <span class="font-mono text-xs text-qubit-400">undo.transactionIds</span> part is what makes this reorg-safe, and it is worth understanding in detail.')}
${h2('Why Reorg Safety Requires the Undo Log')}
${p('QubitCoin supports chain reorganisations: when a competing chain with more cumulative work arrives, the node disconnects blocks back to the fork point and connects the new chain forward. If the transaction index were a simple append-only map, a reorg would leave stale entries pointing at disconnected blocks. A lookup for a transaction that existed only on the old chain would return a block that is no longer canonical — a subtle, hard-to-debug inconsistency.')}
${p('The <span class="font-mono text-xs text-qubit-400">BlockUndo</span> struct already existed to make reorgs correct for UTXOs: it records which UTXOs were spent and created so they can be restored or removed when a block is disconnected. Adding <span class="font-mono text-xs text-qubit-400">transactionIds</span> to that struct gives <span class="font-mono text-xs text-qubit-400">disconnectBlock</span> exactly what it needs:')}
${p('<span class="font-mono text-xs text-qubit-400 block bg-surface rounded p-3 mb-2">for (const txId of undo.transactionIds) {<br>&nbsp;&nbsp;this.transactionIndex.delete(txId)<br>}</span>')}
${p('When a block is disconnected during a reorg, every transaction it contained is evicted from the index. When the replacement block is connected, its transactions are indexed instead. The invariant holds: the transaction index always reflects exactly the canonical chain.')}
${h2('The RPC Handler After the Change')}
${p('The before and after versions of the <span class="font-mono text-xs text-qubit-400">GET /tx/:txid</span> handler show the reduction clearly. The nested loop is replaced by an indexed lookup:')}
${p('<span class="font-mono text-xs text-qubit-400 block bg-surface rounded p-3 mb-2">const block = node.chain.findTransactionBlock(txid)<br>if (block) {<br>&nbsp;&nbsp;const foundTx = block.transactions.find(t => t.id === txid)<br>&nbsp;&nbsp;if (!foundTx) {<br>&nbsp;&nbsp;&nbsp;&nbsp;sendError(res, 404, \'Transaction not found\')<br>&nbsp;&nbsp;&nbsp;&nbsp;return<br>&nbsp;&nbsp;}<br>&nbsp;&nbsp;res.json(sanitize(foundTx))<br>&nbsp;&nbsp;return<br>}</span>')}
${p('The extra guard should never fire in a healthy index: <span class="font-mono text-xs text-qubit-400">findTransactionBlock</span> returns the block that was indexed against this txid, so the transaction should be in it.')}
${h2('Memory Trade-off')}
${p('Adding a <span class="font-mono text-xs text-qubit-400">Map&lt;string, Block&gt;</span> does use memory. Each entry is a 64-byte txid string key pointing at an existing block object (not a copy). At 10,000 transactions per block and 100,000 blocks, the map would hold 1 billion entries — well beyond realistic testnet scale. For mainnet planning, the same index could be persisted to an embedded key-value store (like LevelDB) so it survives restarts without full chain replay. For now, the in-memory approach is the right call: it is simple, correct, and fast enough for the testnet workload.')}
${h2('The Broader Pattern')}
${p('This is the second O(1) index in <span class="font-mono text-xs text-qubit-400">Blockchain</span>. The first was <span class="font-mono text-xs text-qubit-400">utxosByAddress</span> for balance lookups; this one is <span class="font-mono text-xs text-qubit-400">transactionIndex</span> for transaction lookups. Both follow the same discipline: build the index incrementally during block apply, track what was added in the undo log, and evict on disconnect. Any future index — for example, an address-to-transactions map — can follow the same pattern with confidence that reorg correctness comes for free.')}`,
};

export default post;
