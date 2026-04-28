import { type BlogPost, h2, p } from './types.js';

const post: BlogPost = {
  slug: 'hardening-the-node-against-dos',
  title: 'Hardening the Node: Five Layers of DoS Defense',
  date: '2026-04-28',
  tags: ['technical', 'engineering', 'development'],
  excerpt: 'Opening a testnet immediately raises the question: what happens when adversarial peers show up? We added five layers of defense — from RPC input validation to P2P chain continuity checks — and why each one matters.',
  content: () => `<h1 class="text-2xl font-bold mb-2">Hardening the Node: Five Layers of DoS Defense</h1>
<p class="text-text-muted text-xs font-mono mb-8">2026-04-28</p>
${p('Running a testnet node is an invitation. Once the RPC and P2P ports are open, the node will receive requests from people who are curious, careless, or deliberately adversarial. We spent the past few weeks auditing every entry point and adding targeted defenses. Here is what we found and what we changed.')}
${h2('Layer 1: Hash and Address Validation at the RPC Boundary')}
${p('The block and transaction lookup endpoints — <span class="font-mono text-xs text-qubit-400">GET /api/v1/block/:hash</span> and <span class="font-mono text-xs text-qubit-400">GET /api/v1/tx/:txid</span> — originally accepted any string and passed it to the chain lookup. A 256-character garbage string would just miss the index, but it still consumed a lookup and logged an error.')}
${p('The fix is strict upfront rejection: both hashes must be exactly 64 lowercase hex characters. The <span class="font-mono text-xs text-qubit-400">isValidHash</span> helper in <span class="font-mono text-xs text-qubit-400">src/utils.ts</span> does the check and returns a 400 with a clear error message before any chain code runs. Same for addresses: the address lookup endpoint now validates the format before touching the UTXO index.')}
${h2('Layer 2: Transaction Input and Output Limits')}
${p('ML-DSA-65 signature verification is expensive — intentionally so, because strong post-quantum security has a cost. A transaction with 10,000 inputs would force the node to run 10,000 Dilithium verifications before rejecting it. That is a free CPU burn for the attacker.')}
${p('We added hard limits: 1,000 inputs and 1,000 outputs per transaction. Both limits are enforced early in <span class="font-mono text-xs text-qubit-400">validateTransaction</span>, before any signature loops start. The limits are generous enough that no legitimate transaction would come close, and tight enough to bound the worst-case verification work per message.')}
${h2('Layer 3: Hex Field Size Caps in Deserialization')}
${p('Transactions arrive over the wire as JSON with hex-encoded binary fields. The deserializer converts those strings to <span class="font-mono text-xs text-qubit-400">Uint8Array</span> values. If a field contains a megabyte-long hex string, that conversion allocates half a megabyte of memory — silently, per field, per transaction.')}
${p('The fix is a size check table derived from protocol constants. An ML-DSA-65 public key is 1,952 bytes, so the <span class="font-mono text-xs text-qubit-400">publicKey</span> field is capped at 3,904 hex chars. An ML-DSA-65 signature is 3,309 bytes, so <span class="font-mono text-xs text-qubit-400">signature</span> is capped at 6,618. Secp256k1 keys and signatures, witness scripts, and Schnorr fields all have their own tight bounds. Any field that exceeds its cap throws before the allocation happens.')}
${h2('Layer 4: Strict RPC Parameter Validation')}
${p('The mempool listing endpoint accepts an optional <span class="font-mono text-xs text-qubit-400">?limit=N</span> query parameter. The original implementation used <span class="font-mono text-xs text-qubit-400">parseInt</span> and fell back to a default on NaN. This is subtler than it looks: <span class="font-mono text-xs text-qubit-400">parseInt("100abc", 10)</span> returns <span class="font-mono text-xs text-qubit-400">100</span>, not <span class="font-mono text-xs text-qubit-400">NaN</span>. A caller sending <span class="font-mono text-xs text-qubit-400">limit=100abc</span> would silently get 100 results instead of an error.')}
${p('The fix uses a regex guard — the entire string must match <span class="font-mono text-xs text-qubit-400">/^\\d+$/</span> before parsing — and rejects negative values and non-integers with a 400. Returning an error on bad input is strictly better than silently tolerating it: the caller learns their request was malformed, and the server signals that it is not guessing.')}
${h2('Layer 5: P2P Header Chain Continuity Checks')}
${p('The P2P <span class="font-mono text-xs text-qubit-400">headers</span> message lets peers advertise their chain tip during sync. A peer can send a list of headers with arbitrary heights and hashes. Before this fix, the node accepted any list and used it to guide which blocks to request — meaning a malicious peer could advertise a fabricated chain, trigger unnecessary block fetches, or waste sync bandwidth.')}
${p('We now validate two structural invariants on every incoming headers batch: heights must be strictly sequential with step 1 (no gaps, no decreasing), and each header\'s <span class="font-mono text-xs text-qubit-400">previousHash</span> must match the hash of the preceding header in the list. Any batch that fails either check scores the sending peer for misbehavior. A peer that accumulates enough misbehavior points gets disconnected.')}
${h2('Defense in Depth')}
${p('None of these five changes is individually dramatic. Each one closes a narrow gap. But a node that enforces strict limits at every entry point — the HTTP boundary, the deserializer, the validator, the P2P message handler — gives an attacker far fewer angles to work with. The goal is not to make attacks impossible; it is to make them expensive enough that the node stays healthy under realistic adversarial conditions on testnet while we build toward mainnet.')}`,
};

export default post;
