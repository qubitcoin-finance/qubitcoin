export { type BlogPost, BLOG_TAG_COLORS } from './blog/types.js';

import keepingBitcoinKeysInTheBrowser from './blog/keeping-bitcoin-keys-in-the-browser.js';
import failingFastWhenTheNodeGoesAway from './blog/failing-fast-when-the-node-goes-away.js';
import orphanBlocksAndOutOfOrderArrival from './blog/orphan-blocks-and-out-of-order-arrival.js';
import whyClaimTransactionsMustUseASentinelInput from './blog/why-claim-transactions-must-use-a-sentinel-input.js';
import oneClaimOneMintWhyQbtcClaimOutputsWaitTenBlocks from './blog/one-claim-one-mint-why-qbtc-claim-outputs-wait-ten-blocks.js';
import whenChangeBecomesDust from './blog/when-change-becomes-dust.js';
import treatingPersistedBlocksAsUntrustedInput from './blog/treating-persisted-blocks-as-untrusted-input.js';
import serverOwnedTransactionConfirmations from './blog/server-owned-transaction-confirmations.js';
import bridgingBitcoinClaimsAcrossScriptTypes from './blog/bridging-bitcoin-claims-across-script-types.js';
import perPeerTransactionRateLimiting from './blog/per-peer-transaction-rate-limiting.js';
import whyPostQuantum from './blog/why-post-quantum-bitcoin-needs-to-exist.js';
import insideMlDsa65 from './blog/inside-ml-dsa-65.js';
import testnetWhatWeveLearned from './blog/testnet-what-weve-learned.js';
import runANode from './blog/run-a-node.js';
import hardeningTheNode from './blog/hardening-the-node-against-dos.js';
import o1TransactionIndex from './blog/o1-transaction-index.js';
import miningWithoutBlocking from './blog/mining-without-blocking-the-event-loop.js';
import revalidatingTheMempoolAfterAReorg from './blog/revalidating-the-mempool-after-a-reorg.js';
import validatingP2pMessagesAtTheWire from './blog/validating-p2p-messages-at-the-wire.js';
import anchorPeersAndSubnetDiversity from './blog/anchor-peers-and-subnet-diversity.js';
import trustingProxiesWithoutBreakingRpcRateLimits from './blog/trusting-proxies-without-breaking-rpc-rate-limits.js';

export const BLOG_POSTS = [
  keepingBitcoinKeysInTheBrowser,
  failingFastWhenTheNodeGoesAway,
  orphanBlocksAndOutOfOrderArrival,
  whyClaimTransactionsMustUseASentinelInput,
  oneClaimOneMintWhyQbtcClaimOutputsWaitTenBlocks,
  whenChangeBecomesDust,
  trustingProxiesWithoutBreakingRpcRateLimits,
  anchorPeersAndSubnetDiversity,
  validatingP2pMessagesAtTheWire,
  revalidatingTheMempoolAfterAReorg,
  miningWithoutBlocking,
  treatingPersistedBlocksAsUntrustedInput,
  serverOwnedTransactionConfirmations,
  bridgingBitcoinClaimsAcrossScriptTypes,
  perPeerTransactionRateLimiting,
  o1TransactionIndex,
  hardeningTheNode,
  whyPostQuantum,
  insideMlDsa65,
  testnetWhatWeveLearned,
  runANode,
];
