export { type BlogPost, BLOG_TAG_COLORS } from './blog/types.js';

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

export const BLOG_POSTS = [
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
