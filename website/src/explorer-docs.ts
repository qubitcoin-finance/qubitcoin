// ---------------------------------------------------------------------------
// QubitCoin Block Explorer - embedded documentation section registry
// ---------------------------------------------------------------------------

import { renderDocsOverview, renderDocsGettingStarted } from './explorer-docs-intro';
import { renderDocsArchitecture, renderDocsConsensus, renderDocsP2p } from './explorer-docs-architecture';
import { renderDocsClaims, renderDocsSecurity, renderDocsWallet } from './explorer-docs-claims';
import { renderDocsApi } from './explorer-docs-api';
import { renderDocsFaq } from './explorer-docs-faq';

export type { DocSection } from './explorer-docs-helpers';
export { docIcon } from './explorer-docs-helpers';

import type { DocSection } from './explorer-docs-helpers';

export const DOC_SECTIONS: DocSection[] = [
  { id: 'overview', title: 'Overview', icon: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/>', render: renderDocsOverview, children: [
    { id: 'the-quantum-threat', title: 'The Quantum Threat' },
    { id: 'key-properties', title: 'Key Properties' },
    { id: 'supply', title: 'Supply' },
  ]},
  { id: 'security', title: 'Security', icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', render: renderDocsSecurity, children: [
    { id: 'why-ml-dsa-65', title: 'Why ML-DSA-65' },
    { id: 'key-size-tradeoffs', title: 'Key Size Tradeoffs' },
    { id: 'claim-safety', title: 'Claim Safety' },
  ]},
  { id: 'getting-started', title: 'Getting Started', icon: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>', render: renderDocsGettingStarted, children: [
    { id: 'quick-start-join-the-network', title: 'Quick Start' },
    { id: 'claiming-btc', title: 'Claiming BTC' },
    { id: 'cli-reference', title: 'CLI Reference' },
  ]},
  { id: 'architecture', title: 'Architecture', icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>', render: renderDocsArchitecture, children: [
    { id: 'utxo-model', title: 'UTXO Model' },
    { id: 'ml-dsa-65-signatures', title: 'ML-DSA-65' },
    { id: 'sha-256-proof-of-work', title: 'SHA-256 PoW' },
    { id: 'fork-genesis', title: 'Fork Genesis' },
  ]},
  { id: 'btc-claims', title: 'BTC Claims', icon: '<path d="M11.5 3v2m0 14v2m3-18v2m0 14v2"/><path d="M9 7h5.5a2.5 2.5 0 010 5H9V7zm0 5h6.5a2.5 2.5 0 010 5H9v-5z"/>', render: renderDocsClaims, children: [
    { id: 'how-it-works', title: 'How It Works' },
    { id: 'multisig-claims', title: 'Multisig Claims' },
    { id: 'snapshot', title: 'Snapshot' },
  ]},
  { id: 'wallet', title: 'Wallet Guide', icon: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M22 10h-4a2 2 0 100 4h4"/>', render: renderDocsWallet },
  { id: 'consensus', title: 'Consensus', icon: '<path d="M9 12l2 2 4-4"/><path d="M12 3a9 9 0 11-9 9 9 9 0 019-9z"/><path d="M12 7v1m0 8v1m4-5h1M6 12h1"/>', render: renderDocsConsensus, children: [
    { id: 'difficulty-adjustment', title: 'Difficulty' },
    { id: 'block-reward-supply', title: 'Block Reward' },
    { id: 'mining', title: 'Mining' },
  ]},
  { id: 'api', title: 'API Reference', icon: '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>', render: renderDocsApi },
  { id: 'p2p', title: 'P2P Protocol', icon: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98"/>', render: renderDocsP2p },
  { id: 'faq', title: 'FAQ', icon: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>', render: renderDocsFaq },
];
