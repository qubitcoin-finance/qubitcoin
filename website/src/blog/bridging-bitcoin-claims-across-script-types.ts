import { type BlogPost, h2, p, steps } from './types.js';

const post: BlogPost = {
  slug: 'bridging-bitcoin-claims-across-script-types',
  title: 'Bridging Bitcoin Claims Across Script Types',
  date: '2026-05-06',
  tags: ['bitcoin', 'technical', 'engineering', 'cryptography'],
  excerpt: 'QubitCoin does not wrap BTC or reuse Bitcoin signatures on-chain. It snapshots Bitcoin balances, asks holders to prove control of their old keys once, and supports claims from P2PKH, wrapped SegWit, Taproot, P2WSH, and multisig outputs.',
  content: () => `<h1 class="text-2xl font-bold mb-2">Bridging Bitcoin Claims Across Script Types</h1>
<p class="text-text-muted text-xs font-mono mb-8">2026-05-06</p>
${p('A Bitcoin fork that swaps ECDSA for ML-DSA has an awkward bootstrapping problem. Existing BTC holders control secp256k1 keys and script paths, but QubitCoin wants post-quantum native UTXOs. The claim mechanism is the bridge: prove ownership of a Bitcoin snapshot entry once, mint the equivalent amount on the qbtc chain, and move forward with a new ML-DSA address.')}
${h2('The Core Design Constraint')}
${p('The goal is not to carry Bitcoin scripts into the new chain forever. QubitCoin keeps its consensus model simple: claim transactions are a one-time import path, and the resulting output is just a normal qbtc UTXO. After the claim is mined, future spends use ML-DSA like any other transaction.')}
${p('That separation matters. It lets the chain recognize historic Bitcoin ownership without making secp256k1, Taproot, witness execution, or multisig script evaluation permanent parts of day-to-day validation.')}
${h2('What Gets Signed')}
${p('Every claim signs a message derived from five fields: a fixed domain string, the Bitcoin address being claimed, the destination qbtc address, the Bitcoin snapshot block hash, and the qbtc genesis hash.')}
${p('This does three jobs at once. It binds the proof to one snapshot entry, binds the payout to one post-quantum destination address, and prevents replay across forks that might share the same snapshot but not the same genesis block.')}
${h2('One Flow, Multiple Bitcoin Address Families')}
${p('The recent test work made this clearer by expanding coverage beyond the basic pay-to-pubkey-hash path. A valid claim can now be demonstrated end to end for several distinct Bitcoin ownership models, each with its own verification path.')}
${steps([
  'P2PKH and P2WPKH: hash the compressed secp256k1 public key and verify one ECDSA signature over the claim message.',
  'P2SH-P2WPKH: derive the wrapped SegWit address from the public key, then verify the same one-key ECDSA proof.',
  'P2TR: treat the snapshot entry as a Taproot output, recompute the tweaked output key from the x-only internal key, then verify a Schnorr signature.',
  'P2WSH: require the full witness script, confirm the script hashes to the snapshot address, parse the script, and verify the ordered signatures it demands.',
  'P2SH multisig: do the same script-and-signature dance, but against HASH160(redeemScript) instead of SHA256(witnessScript).',
])}
${h2('Why the Script Cases Matter')}
${p('Single-key claims are straightforward. Multisig claims are where the bridge becomes real engineering instead of a demo. The verifier has to prove that the submitted script actually corresponds to the snapshotted address, parse out whether it is single-key or m-of-n multisig, and then check signatures in Bitcoin-style order.')}
${p('That last point is subtle. For multisig, it is not enough to verify that some keys signed. The signatures must satisfy the script the same way Bitcoin would: ordered against the pubkeys, with the right threshold. That is what lets a snapshot include more than simple wallet outputs without reducing the claim path to “trust us.”')}
${h2('Claiming Does Not Mean Double Counting')}
${p('The chain also has to remember which snapshot entries have already been consumed. Once a claim transaction for a BTC address is mined, that address disappears from the claimable set and starts returning true from the claimed check. Recent tests added explicit coverage for that behavior across P2SH-P2WPKH, P2TR, P2WSH, and P2SH multisig entries, not just the original simple-key case.')}
${p('That sounds like a small testing change, but it closes an important confidence gap. A bridge is only trustworthy if every supported path is excluded after successful import, no matter how exotic the original Bitcoin output type was.')}
${h2('The Architectural Payoff')}
${p('The result is a narrow compatibility layer instead of a permanent hybrid chain. QubitCoin can acknowledge how Bitcoin balances were originally locked, accept one proof of control, and then collapse everything back into the simpler post-quantum UTXO model.')}
${p('That is the right trade-off for a post-quantum fork. Compatibility belongs at the boundary. Inside the chain, the model stays opinionated: ML-DSA for ongoing ownership, Bitcoin scripts only for proving where the starting balances came from.')}`,
};

export default post;
