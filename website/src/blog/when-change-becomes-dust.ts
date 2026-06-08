import { type BlogPost, h2, p, steps } from './types.js';

const post: BlogPost = {
  slug: 'when-change-becomes-dust',
  title: 'When Change Becomes Dust: Folding Tiny Remainders Into Fees',
  date: '2026-06-08',
  tags: ['technical', 'engineering', 'development'],
  excerpt: 'QubitCoin transactions now drop change outputs below the 546-satoshi dust threshold instead of manufacturing outputs the validator would reject. The remainder is intentionally absorbed into the effective fee, keeping wallet-side transaction construction aligned with consensus rules.',
  content: () => `<h1 class="text-2xl font-bold mb-2">When Change Becomes Dust: Folding Tiny Remainders Into Fees</h1>
<p class="text-text-muted text-xs font-mono mb-8">2026-06-08</p>
${p('A wallet constructor and a transaction validator should agree on what a legal transaction looks like. If they do not, the wallet can build payloads that are doomed before they ever reach the mempool. A recent fix in QubitCoin closes exactly that gap for one common edge case: tiny change outputs.')}
${h2('The Problem With Tiny Change')}
${p('QubitCoin enforces a dust threshold of <span class="font-mono text-xs text-qubit-400">546</span> satoshis. Outputs below that line are rejected during validation. That rule already protected the chain from being filled with economically useless outputs, but transaction construction still had a mismatch: if a spend left any positive remainder at all, the wallet logic would add a change output for it.')}
${p('That meant a transaction could be assembled with a 100-satoshi or 300-satoshi change output even though the validator would later reject it as dust. The code producing the transaction and the code checking the transaction were following different definitions of “valid.”')}
${h2('What Changed')}
${p('The constructor in <span class="font-mono text-xs text-qubit-400">src/transaction.ts</span> now uses the same threshold as validation. Change is only emitted when the remainder is at least <span class="font-mono text-xs text-qubit-400">DUST_THRESHOLD</span>. If the leftover amount is smaller, QubitCoin does not create a second output for it.')}
${steps([
  'If the remainder is negative, transaction creation still fails with insufficient funds.',
  'If the remainder is exactly zero, there is no change output.',
  'If the remainder is between <span class="font-mono text-xs text-qubit-400">1</span> and <span class="font-mono text-xs text-qubit-400">545</span> satoshis, the would-be change is folded into the fee.',
  'If the remainder is <span class="font-mono text-xs text-qubit-400">546</span> satoshis or more, a normal change output is added back to the sender address.',
])}
${h2('Why Folding Dust Into Fees Is Correct')}
${p('Suppose a wallet spends a 6,000-satoshi UTXO, sends 5,000 satoshis to the recipient, and asks for a 500-satoshi fee. The mathematical remainder is 500 satoshis. Before the fix, the constructor would add that 500-satoshi change output, and the validator would reject the transaction because 500 is below the dust floor.')}
${p('Now the transaction is built with only the recipient output. The spend still consumes 6,000 satoshis, but it only creates 5,000 satoshis of outputs. The validator therefore observes an effective fee of 1,000 satoshis. Nothing is lost or ambiguous: the tiny remainder simply becomes additional miner fee rather than an invalid output.')}
${h2('Why This Matters More in QubitCoin')}
${p('QubitCoin uses ML-DSA-65 signatures, which are large compared with classical Bitcoin signatures. That makes small UTXOs more expensive to spend, and it makes dust handling more than a cosmetic policy. If the network already rejects tiny outputs, wallet-side construction has to be disciplined about not creating them in the first place.')}
${p('This is the kind of fix that looks small in a diff and large in behavior. It removes a class of self-inflicted invalid transactions, reduces pointless mempool churn, and keeps fee accounting honest under edge-case remainders.')}
${h2('The Test Boundary Is Clear Now')}
${p('The transaction tests now lock in both sides of the threshold. A remainder below dust must produce no change output and must still validate successfully, with the fee calculation reflecting the absorbed remainder. A remainder exactly equal to <span class="font-mono text-xs text-qubit-400">546</span> must still produce a normal change output.')}
${p('That is the right contract for a UTXO wallet: build only transactions the chain can actually accept, and make threshold behavior explicit instead of accidental.')}`,
};

export default post;
