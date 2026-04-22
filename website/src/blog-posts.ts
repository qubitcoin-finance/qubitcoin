export { type BlogPost, BLOG_TAG_COLORS } from './blog/types.js';

import whyPostQuantum from './blog/why-post-quantum-bitcoin-needs-to-exist.js';
import insideMlDsa65 from './blog/inside-ml-dsa-65.js';
import testnetWhatWeveLearned from './blog/testnet-what-weve-learned.js';
import fixingTheDeploy from './blog/fixing-the-deploy.js';
import runANode from './blog/run-a-node.js';

export const BLOG_POSTS = [
  whyPostQuantum,
  insideMlDsa65,
  testnetWhatWeveLearned,
  fixingTheDeploy,
  runANode,
];
