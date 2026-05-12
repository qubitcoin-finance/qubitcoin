import { type BlogPost, h2, p, steps } from './types.js';

const post: BlogPost = {
  slug: 'server-owned-transaction-confirmations',
  title: 'Server-Owned Confirmation Metadata for Transactions',
  date: '2026-05-12',
  tags: ['technical', 'engineering', 'development'],
  excerpt: 'A transaction payload should describe what was signed, not claim where the chain included it. QubitCoin now computes block linkage and confirmation count at the RPC boundary, strips fake metadata from submitted transactions, and lets the explorer render finality from server-owned state.',
  content: () => `<h1 class="text-2xl font-bold mb-2">Server-Owned Confirmation Metadata for Transactions</h1>
<p class="text-text-muted text-xs font-mono mb-8">2026-05-12</p>
${p('A signed transaction can prove who authorized a spend. It cannot honestly tell you whether the network mined it, which block included it, or how many confirmations it has. That state belongs to the chain, not to the payload. Recent RPC and explorer work tightened that boundary in a useful way: confirmed transactions now come back with server-derived inclusion metadata, while mempool transactions stay free of it.')}
${h2('The Boundary Problem')}
${p('Before this change, the transaction shape did not distinguish cleanly between user-authored data and server-owned chain state. That creates two problems. First, explorer clients have to infer confirmation status indirectly. Second, an untrusted caller submitting JSON to the node could include fields like block height that look authoritative even though they were never part of consensus or validation.')}
${p('That is the wrong trust model. A transaction should serialize the thing users sign: inputs, outputs, timestamp, and claim data when relevant. Confirmation status should be attached only when the node has actually located the transaction in its own active chain.')}
${h2('What the RPC Now Adds')}
${p('The transaction lookup endpoint keeps its two-source behavior. It checks the mempool first and then falls back to the chain index. The important change is what happens on the chain path: if the node finds the containing block, it returns three extra fields derived from local chain state rather than transaction bytes.')}
${steps([
  '<span class="font-mono text-xs text-qubit-400">blockHash</span>: the hash of the block that currently contains the transaction.',
  '<span class="font-mono text-xs text-qubit-400">blockHeight</span>: the height where that block sits in the active chain.',
  '<span class="font-mono text-xs text-qubit-400">confirmations</span>: computed as current chain length minus the block height, so the count rises as new blocks extend the tip.',
])}
${p('If the transaction is still in the mempool, none of those fields are present. That omission is deliberate. “Unconfirmed” is not block height zero; it is a different state with different semantics.')}
${h2('Why the Server Must Own These Fields')}
${p('The storage layer now strips server-owned metadata during transaction deserialization. If a client submits JSON with made-up block linkage fields, they are deleted before the node treats the object as a real transaction. That keeps the serialization boundary honest: transport JSON can carry extra garbage, but the in-memory transaction model used for validation and mempool admission does not inherit it.')}
${p('This matters beyond cleanliness. Explorer views, API clients, and future wallet tooling all need a stable answer to a simple question: which fields describe what was signed, and which fields describe what the node later observed? Once that distinction is crisp, downstream code can trust that confirmation metadata is observational state, not attacker-controlled input.')}
${h2('Why This Helps the Explorer')}
${p('The explorer transaction page can now render confirmation status directly instead of reconstructing it from partial clues. Confirmed transactions show a status badge, a link to the containing block, and the live confirmation count. Mempool transactions show neither block linkage nor fake zero-confirmation placeholders.')}
${p('That is a small UX improvement, but it reflects a more important architectural decision. The frontend is no longer guessing about finality. It is displaying a server assertion derived from the active chain, which is exactly where finality information belongs in a Bitcoin-style node.')}
${h2('A Small Change With Good Discipline')}
${p('None of this changes consensus. It changes ownership of metadata. In systems like this, that distinction is worth protecting. Signed payloads should stay minimal and portable. Derived chain facts should be added at the RPC edge by the node that actually has the chain.')}
${p('That discipline scales. The same rule will matter for any future transaction annotations: if a field can be forged by a caller and is not part of what was signed, it should not survive deserialization as though it were real. Confirmation counts are just the latest place where keeping that boundary strict made the API and the explorer better.')}`,
};

export default post;
