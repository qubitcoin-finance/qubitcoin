import { type BlogPost, h2, p, steps } from './types.js';

const post: BlogPost = {
  slug: 'one-claim-one-mint-why-qbtc-claim-outputs-wait-ten-blocks',
  title: 'One Claim, One Mint: Why QBTC Claim Outputs Wait Ten Blocks',
  date: '2026-06-11',
  tags: ['technical', 'engineering', 'bitcoin'],
  excerpt: 'QubitCoin treats BTC claims as one-shot mints tied to a snapshot address. The chain tracks claimed addresses separately from ordinary UTXOs and then time-locks each claimed output for 10 blocks, combining replay resistance, branch-safe rollback, and a clean reorg boundary.',
  content: () => `<h1 class="text-2xl font-bold mb-2">One Claim, One Mint: Why QBTC Claim Outputs Wait Ten Blocks</h1>
<p class="text-text-muted text-xs font-mono mb-8">2026-06-11</p>
${p('A BTC claim in QubitCoin is not a normal spend. There is no previous QubitCoin UTXO to unlock, no fee market race to spend a fresh output, and no reason to allow the same Bitcoin snapshot balance to mint twice. That is why the claim path has two separate safety rules: a Bitcoin address can only be claimed once on a branch, and the resulting QBTC output cannot be spent until it is ten blocks deep.')}
${h2('Claims Are Mints, Not Transfers')}
${p('Ordinary transactions consume existing UTXOs. Claim transactions do not. They use the <span class="font-mono text-xs text-qubit-400">CLAIM_TXID</span> sentinel as a structural marker, carry proof material in <span class="font-mono text-xs text-qubit-400">claimData</span>, and mint exactly one output whose amount must match the snapshotted BTC balance. The actual ownership check happens in <span class="font-mono text-xs text-qubit-400">verifyClaimProof</span>, which recomputes the signed message from the trusted snapshot hash and the chain genesis hash before accepting the mint.')}
${p('That distinction matters because the chain is not just validating a signature. It is converting an immutable Bitcoin snapshot entry into a live QBTC UTXO. If that conversion can be repeated, the snapshot becomes an inflation bug instead of a distribution mechanism.')}
${h2('The First Guardrail: One Claim Per BTC Address')}
${p('The active chain keeps an in-memory <span class="font-mono text-xs text-qubit-400">claimedBtcAddresses</span> set. When a block arrives, each claim transaction is checked against that set before the mint is applied. If the BTC address is already present, the block is rejected. This is intentionally separate from the UTXO set because the source asset is not a spendable QubitCoin output. The thing being exhausted is the right to claim a snapshot entry, not a prior transaction output.')}
${p('The mempool uses the same idea earlier in the pipeline. It rejects claims for BTC addresses that are already claimed on-chain and also deduplicates competing claim transactions for the same address while they are still pending. That keeps duplicate claims from churning through block assembly just because they have not been mined yet.')}
${h2('Reorgs Need Reversible Claim State')}
${p('A claimed-address set only works if it can roll back cleanly. QubitCoin records claimed BTC addresses in block undo data when a claim is applied. If a reorg disconnects that block later, the address is removed from the set again. That means the losing branch gives up the claim and the winning branch can legitimately re-claim it if it includes the corresponding transaction.')}
${p('Fork evaluation uses a temporary claim set as well. While replaying a competing branch, QubitCoin tracks claims seen inside that candidate branch so the fork cannot sneak in the same BTC address twice during re-application. The result is consistent behavior in three places: mempool admission, active-chain validation, and fork selection.')}
${h2('The Second Guardrail: Wait Ten Blocks Before Spending')}
${p('Once a claim is accepted, the created UTXO is tagged with <span class="font-mono text-xs text-qubit-400">isClaim: true</span>. Transaction validation then treats it differently from ordinary outputs. If the current chain height is less than ten blocks past the claim height, the spend is rejected as immature. The constant is <span class="font-mono text-xs text-qubit-400">CLAIM_MATURITY = 10</span>.')}
${steps([
  'A claim transaction mints a normal-looking QBTC output, but the UTXO carries an <span class="font-mono text-xs text-qubit-400">isClaim</span> flag internally.',
  'Validation computes the output age from the block height where the claim was created.',
  'If the age is below <span class="font-mono text-xs text-qubit-400">10</span>, the spend is rejected as not mature.',
  'At exactly ten blocks of age, the output becomes spendable like any other mature UTXO.',
])}
${h2('Why The Delay Exists')}
${p('Without a maturity window, a user could claim and immediately fan that value out into downstream transactions before the network has much confidence that the claim will survive. If a short reorg then disconnects the claim, every descendant spend becomes invalid at once. The 10-block delay narrows that blast radius by preventing fresh claim outputs from being forwarded through the economy while they are still close to the reorg boundary.')}
${p('This mirrors the reason coinbase outputs mature before they can be spent, but the risk is slightly different. Coinbase maturity protects consensus around newly mined subsidy. Claim maturity protects a one-time conversion from a foreign snapshot into the live ledger. In both cases, the chain benefits from forcing a cooling-off period before newly created value starts chaining into other transactions.')}
${h2('Why The Two Rules Belong Together')}
${p('Double-claim prevention and claim maturity solve different halves of the same problem. The first guarantees that a BTC snapshot entry can only mint once per surviving branch. The second makes that mint wait before it can propagate into additional state transitions. Together they give QubitCoin a much cleaner reorg story: duplicate claims are rejected early, disconnected claims are reversible, and newly minted claim outputs do not become spendable until the branch has had time to settle.')}
${p('That is the right shape for a fork claim system. Snapshot balances must be redeemable, but redemption cannot behave like an unconstrained faucet. QubitCoin treats claims as scarce rights, tracks them explicitly, and only lets the resulting coins enter normal circulation after the chain has earned a bit of time.')}`,
};

export default post;
