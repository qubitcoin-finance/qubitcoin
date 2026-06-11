import { type BlogPost, h2, p, steps } from './types.js';

const post: BlogPost = {
  slug: 'testnet-what-weve-learned',
  title: 'Building on Testnet: What We\'ve Learned',
  date: '2026-04-20',
  tags: ['development', 'testnet', 'engineering'],
  excerpt: 'Six weeks into testnet. What worked, what surprised us, and what changed from the original design — an engineering retrospective.',
  content: () => `<h1 class="text-2xl font-bold mb-2">Building on Testnet: What We've Learned</h1>
<p class="text-text-muted text-xs font-mono mb-8">2026-04-20</p>
${p('QubitCoin has been running on testnet for several weeks. This is a retrospective on what we\'ve built, what surprised us, and what evolved from the original design.')}
${h2('The Snapshot Pipeline')}
${p('The biggest engineering challenge was the UTXO snapshot pipeline. Bitcoin Core\'s <span class="font-mono text-xs text-qubit-400">dumptxoutset</span> produces a binary file with ~160M UTXO entries. We parse, filter, and aggregate these into ~58M address balances, then build a merkle tree and commit the root in the genesis block.')}
${p('The pipeline works. Running it end-to-end — from raw dump to a genesis block with a valid merkle commitment — takes several hours on commodity hardware. The output is a <span class="font-mono text-xs text-qubit-400">.jsonl</span> file that nodes download or mount at startup.')}
${p('What surprised us: aggregating by address (summing all UTXOs per address) is the right UX decision but complicates the merkle proof slightly. You can\'t prove a specific UTXO is in the set — you prove an address balance is in the set. This actually simplifies the claim flow since users think about addresses, not UTXOs.')}
${h2('The Claim Mechanism')}
${p('BTC claims work as special transactions. A claim transaction has no inputs in the traditional UTXO sense — instead it has a <span class="font-mono text-xs text-qubit-400">claimData</span> field containing the Bitcoin address, the ECDSA public key, an ECDSA signature over a canonical claim message, and the new QBTC address.')}
${p('The node verifies: the ECDSA public key hashes to the BTC address, the ECDSA signature is valid over the claim message, the address exists in the snapshot with unclaimed balance, and then mints the QBTC into the new ML-DSA-65 address. First claim wins — no double-claiming.')}
${p('This is clean and trustless. The claim message binds the QBTC address into the signature so you can\'t replay someone else\'s claim proof to redirect funds to your own key.')}
${h2('P2P and Mining')}
${p('The difficulty adjustment runs every 10 blocks targeting a 10-minute average. On testnet with a single node, we see consistent block times once difficulty stabilizes.')}
${h2('What Changed From the Design')}
${p('A few things evolved during implementation:')}
${steps([
  '<strong>Transaction index:</strong> We added an O(1) transaction index to the chain. Block search is fast, but looking up a TX by ID without scanning every block was slow at scale. The index is rebuilt on startup if missing.',
  '<strong>Input/output limits:</strong> We added per-transaction input and output count limits after realizing unbounded transactions could be used to bloat blocks trivially.',
  '<strong>Validation helpers:</strong> Signature verification and validation logic got extracted into dedicated modules after the main chain file grew unwieldy. This made testing significantly easier.',
  '<strong>P2P snapshot tests:</strong> We added snapshot tests for P2P message serialization — these caught a subtle encoding regression during a refactor.',
])}
${h2('What\'s Next')}
${p('The testnet is stable. Current focus areas:')}
${steps([
  'Wallet tooling — right now claiming requires using the RPC directly. We want a simple web interface for claim transactions.',
  'More peers — testnet with one node is minimal. We want external nodes joining.',
  'Documentation — the technical docs are solid, but the user-facing claim guide needs work.',
])}
${p('Follow along on <a href="https://x.com/qubitcoin_" target="_blank" rel="noopener" class="text-qubit-400 hover:text-qubit-300 transition-colors">X</a> or join the <a href="https://t.me/qubitcoin_finance" target="_blank" rel="noopener" class="text-qubit-400 hover:text-qubit-300 transition-colors">Telegram</a> for updates. The code is all on <a href="https://github.com/qubitcoin-finance/qubitcoin" target="_blank" rel="noopener" class="text-qubit-400 hover:text-qubit-300 transition-colors">GitHub</a>.')}`,
};

export default post;
