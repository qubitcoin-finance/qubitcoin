import { type BlogPost, h2, p, steps } from './types.js';

const post: BlogPost = {
  slug: 'treating-persisted-blocks-as-untrusted-input',
  title: 'Treating Persisted Blocks as Untrusted Input',
  date: '2026-05-20',
  tags: ['technical', 'engineering', 'development'],
  excerpt: 'QubitCoin startup now hardens the storage replay path with block-shape checks, transaction-shape validation, bounded hex decoding, canonical hash enforcement, and line-level error logging so one bad JSONL entry cannot silently poison chain restore.',
  content: () => `<h1 class="text-2xl font-bold mb-2">Treating Persisted Blocks as Untrusted Input</h1>
<p class="text-text-muted text-xs font-mono mb-8">2026-05-20</p>
${p('A node restart feels local. It is easy to think of <span class="font-mono text-xs text-qubit-400">blocks.jsonl</span> as private state the process wrote itself, so reading it back should be a boring detail. In practice, the storage replay path is a parser sitting directly on the route to chain reconstruction. If that parser is too trusting, one malformed entry can crash startup, allocate more memory than it should, or rebuild in-memory indexes from garbage. Recent storage work tightened that boundary across the full deserialize path.')}
${h2('Why Startup Replay Matters')}
${p('The <span class="font-mono text-xs text-qubit-400">Blockchain</span> constructor restores persisted blocks before it does anything else. Genesis comes from storage, later blocks are replayed into the UTXO set, the transaction index is rebuilt, and cumulative work is recomputed from the restored chain. That means storage is not just archival output. It is an input path that seeds the live node state every time the process boots.')}
${p('Once you look at it that way, the right rule is obvious: persisted JSON should get the same skepticism as any other boundary object. It may have been truncated by a crash, hand-edited during debugging, or left behind by older code that serialized shapes the current node no longer wants to trust.')}
${h2('What the Storage Layer Now Checks')}
${p('The hardening work is deliberately simple. Before transaction or block objects are accepted into the in-memory model, the storage layer validates structure first, then performs any binary decoding only after the shape is known to be sane. The main checks are:')}
${steps([
  '<span class="font-mono text-xs text-qubit-400">validateBlockShape()</span> rejects malformed headers, non-canonical block hashes, bad heights, and invalid hash-like fields before replay starts.',
  '<span class="font-mono text-xs text-qubit-400">validateTransactionShape()</span> ensures IDs, inputs, outputs, timestamps, and claim data all have the expected types and array bounds.',
  '<span class="font-mono text-xs text-qubit-400">safeHexToBytes()</span> caps hex string length for ML-DSA keys, signatures, and BTC-claim witness data so deserialization cannot trigger unbounded allocations.',
  '<span class="font-mono text-xs text-qubit-400">loadBlocks()</span> logs the exact line number and reason for any rejected entry, then skips it instead of letting one corrupted record abort the whole restore.',
])}
${p('That order matters. Count limits on inputs, outputs, and block transactions run before deeper field handling. Binary fields are decoded only after the surrounding object passes shape validation. A malformed record now fails early and cheaply.')}
${h2('Canonical Hashes Are Not Cosmetic')}
${p('One of the more useful checks is the insistence on canonical lowercase 64-character hex strings for block hashes and header hash fields. Without that guard, storage can contain values that look hash-like to casual code but violate the format expected everywhere else in the node.')}
${p('That sounds minor until you remember how often hashes are used as map keys, routing parameters, and equality checks. A block replayed from disk with uppercase hex is not just ugly data. It is a value that can miss lookups, diverge from RPC sanitisation rules, and create state that no peer or client would ever produce on the wire. Rejecting those records at load time keeps the internal chain model consistent with every other boundary in the system.')}
${h2('Bounded Hex Decoding Closes a Quiet DoS Gap')}
${p('The other important improvement is less visible: hex decoding is now size-bounded by protocol reality. Storage deserialization handles large binary fields such as ML-DSA-65 public keys and signatures, plus BTC-claim witness material. If the loader blindly trusted any hex string length, a crafted or corrupted record could force large allocations during startup before the node even began validation.')}
${p('The fix is not fancy. Each known binary field gets a maximum hex length derived from the protocol-defined byte size, and anything over the limit is rejected immediately. That keeps the storage path aligned with the actual envelope of valid QubitCoin transactions instead of the much larger envelope of "whatever JSON can encode."')}
${h2('Good Failure Reporting Matters Too')}
${p('The logging change is worth calling out because defensive parsing without usable diagnostics often turns into operational guesswork. When the loader rejects a record now, it reports the storage component, the JSONL line number, and the validation detail that caused the skip. For example, a bad transaction nested inside an otherwise valid-looking block is reported as the exact transaction index and field failure, not as a generic parse error.')}
${p('That is useful for debugging, but it also encodes a discipline: corruption handling should be explicit, narrow, and observable. If startup succeeds after skipping a bad line, operators still need enough detail to decide whether the file is recoverable, whether a previous version wrote broken data, or whether something worse happened on disk.')}
${h2('The Broader Lesson')}
${p('This change does not alter consensus rules. It tightens a trust boundary. QubitCoin already treats RPC payloads and P2P messages as hostile until validated. Persisted chain data deserves the same posture because it is one restart away from becoming live state again.')}
${p('That principle scales beyond storage. Any path that reconstructs authoritative in-memory objects should validate shape first, enforce protocol-sized limits before allocation-heavy work, and log failures precisely enough to be actionable. The recent storage hardening is a good example of how much resilience you can buy with a few well-placed checks and no extra dependencies.')}`,
};

export default post;
