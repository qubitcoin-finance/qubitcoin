import { type BlogPost, h2, p, steps } from './types.js';

const post: BlogPost = {
  slug: 'why-claim-transactions-must-use-a-sentinel-input',
  title: 'Why Claim Transactions Must Use a Sentinel Input',
  date: '2026-06-14',
  tags: ['technical', 'engineering', 'bitcoin'],
  excerpt: 'QubitCoin claim transactions are mints, not ordinary UTXO spends. A recent block-validation rule now requires every claim to use exactly one `CLAIM_TXID` sentinel input, closing off hybrid transactions that could mint from the BTC snapshot while quietly leaving a real QBTC input unconsumed.',
  content: () => `<h1 class="text-2xl font-bold mb-2">Why Claim Transactions Must Use a Sentinel Input</h1>
<p class="text-text-muted text-xs font-mono mb-8">2026-06-14</p>
${p('Claim transactions sit in an unusual spot in QubitCoin. They create QBTC from a Bitcoin snapshot, but they do not spend an existing QBTC output to do it. That means the validator cannot treat them like ordinary UTXO spends, and it also cannot leave their structure ambiguous. A recent hardening change makes that boundary explicit: every claim transaction must contain exactly one input, and that input must use the <span class="font-mono text-xs text-qubit-400">CLAIM_TXID</span> sentinel.')}
${h2('The Risk Was Not In The Signature Check')}
${p('Claim verification already had the expensive part covered. The chain checks <span class="font-mono text-xs text-qubit-400">claimData</span>, reconstructs the signed message from the Bitcoin snapshot block hash and the chain genesis hash, and verifies the claimant controlled the original BTC address. The bug class here was different. It lived in the structural gap between "this looks like a claim" and "this consumes normal UTXOs."')}
${p('Inside block validation, claim transactions intentionally bypass regular UTXO verification. That is correct because there is no prior QBTC output to unlock. But if a malformed claim were allowed to include a real QBTC input anyway, the validator would skip consuming that input while still accepting the newly minted output. The result would be a hybrid transaction: part claim, part spend, with the spend side silently ignored.')}
${h2('Why A Sentinel Exists At All')}
${p('QubitCoin already uses sentinel transaction IDs to mark special transaction classes. Coinbase uses a fake all-zero input because block subsidy has no previous output. Claims follow the same pattern with <span class="font-mono text-xs text-qubit-400">CLAIM_TXID</span>, a 64-character string of <span class="font-mono text-xs text-qubit-400">c</span>s. That value is not meant to point at anything on-chain. It is a structural marker that tells the validator: this transaction is minting from the BTC snapshot path, not spending a QBTC UTXO.')}
${p('The important part is that the marker must be exclusive. If the sentinel can appear next to real inputs, or be replaced by a real input entirely, the transaction stops being unambiguous. The validator needs one clear branch or the other.')}
${h2('The New Rule In Block Validation')}
${p('The hardening check now lives directly in <span class="font-mono text-xs text-qubit-400">validateBlock</span>. Once a transaction is identified as a claim, the block is rejected unless it has exactly one input and that input&apos;s <span class="font-mono text-xs text-qubit-400">txId</span> equals <span class="font-mono text-xs text-qubit-400">CLAIM_TXID</span>.')}
${steps([
  'If a claim is missing <span class="font-mono text-xs text-qubit-400">claimData</span>, the block is rejected immediately.',
  'If it has anything other than one input, the block is rejected immediately.',
  'If that sole input does not use <span class="font-mono text-xs text-qubit-400">CLAIM_TXID</span>, the block is rejected immediately.',
  'Only after that structural gate does the validator continue with claim-specific output rules and the later ownership-proof checks.',
])}
${p('That ordering matters. The node now refuses malformed claim structure before any downstream state transition can depend on it. This is cheaper than trying to repair the ambiguity later during block application or reorg handling.')}
${h2('What The Attack Looked Like')}
${p('The new hardening tests build two concrete failure cases. The first crafts a claim transaction whose input points to a real-looking transaction ID instead of the sentinel. The second starts with the sentinel input and then appends a second real-looking input. In both cases, the transaction still carries valid-looking <span class="font-mono text-xs text-qubit-400">claimData</span> and a normal claim output amount.')}
${p('Without the sentinel rule, block validation would classify the transaction as a claim and skip the ordinary input-consumption path. The attacker could then mint the claim output while keeping the referenced QBTC UTXO available for a later spend. That is not a signature forgery or a replay bug. It is a state-accounting bug caused by letting one transaction straddle two validation modes at once.')}
${h2('Why This Check Belongs In The Cheap Phase')}
${p('QubitCoin block validation is deliberately ordered from cheap structural checks toward expensive contextual ones. The claim sentinel rule belongs near the front because it is just shape validation: count the inputs and compare one fixed string. That is exactly the sort of invariant that should fail early, before the node reaches UTXO accounting, snapshot lookups, or secp256k1 verification.')}
${p('This also keeps the rule consistent with the rest of the system. Mempool logic, chain application, and reorg handling all work better when claim transactions are guaranteed to be structurally distinct from ordinary spends. The earlier that guarantee is enforced, the less special-case cleanup every later stage needs.')}
${h2('A Small Rule That Protects A Hard Boundary')}
${p('The broader lesson is that special transaction types need hard serialization boundaries, not just different business logic. A claim is a mint from external state. A regular transaction is a spend of internal state. Combining the two inside one payload is not flexibility; it is ambiguity.')}
${p('By forcing every claim transaction onto the single-input <span class="font-mono text-xs text-qubit-400">CLAIM_TXID</span> path, QubitCoin makes that boundary machine-checkable. The validator can keep treating claims as a special branch because it now knows, structurally, that they really are special and nothing else is hiding inside them.')}`,
};

export default post;
