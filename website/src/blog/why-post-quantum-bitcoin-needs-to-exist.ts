import { type BlogPost, h2, p } from './types.js';

const post: BlogPost = {
  slug: 'why-post-quantum-bitcoin-needs-to-exist',
  title: 'Why Post-Quantum Bitcoin Needs to Exist',
  date: '2026-04-01',
  tags: ['bitcoin', 'cryptography', 'quantum'],
  excerpt: 'Quantum computers are no longer science fiction. Here\'s why Bitcoin\'s ECDSA signatures are a ticking clock — and what we\'re doing about it.',
  content: () => `<h1 class="text-2xl font-bold mb-2">Why Post-Quantum Bitcoin Needs to Exist</h1>
<p class="text-text-muted text-xs font-mono mb-8">2026-04-01</p>
${p('Bitcoin is the most robust financial network humanity has ever built. Over a decade of adversarial conditions — hackers, state actors, market crashes — and the base protocol has never been breached. But there\'s a structural vulnerability that no amount of operational security can patch: ECDSA secp256k1.')}
${h2('The Attack Surface')}
${p('Every Bitcoin transaction is authorized by an Elliptic Curve Digital Signature Algorithm signature. ECDSA security rests on the hardness of the elliptic curve discrete logarithm problem (ECDLP). A classical computer with all the energy in the universe cannot crack a 256-bit ECDSA key in any useful timeframe.')}
${p('A sufficiently large quantum computer running Shor\'s algorithm can. The math is settled — Shor\'s reduces ECDLP to polynomial time. The open question is purely engineering: how many logical qubits, and when.')}
${p('Conservative estimates put a "cryptographically relevant" quantum computer — one large enough to break 256-bit ECDSA in hours — at 10–20 years out. Less conservative estimates say 5–7 years. No credible researcher says "never".')}
${h2('Why Not Just Upgrade Bitcoin?')}
${p('Bitcoin governance moves slowly by design. Changing the signature algorithm touches every wallet, every transaction, every piece of infrastructure ever built. A soft-fork that adds a new address type takes years of coordination. A hard-fork that removes ECDSA would be the most contentious event in Bitcoin\'s history — and there\'s no guarantee it happens before a large-scale quantum computer exists.')}
${p('The migration problem is also severe. Exposed public keys — from address reuse, P2PK outputs, and early coinbase transactions — hold an estimated 4 million BTC. Owners of those coins need time to migrate. If a quantum computer arrives before a coordinated migration, those coins are at risk.')}
${h2('What QubitCoin Does')}
${p('We forked Bitcoin at a specific block height, replacing ECDSA with ML-DSA-65 (Dilithium) — a NIST-standardized lattice-based signature scheme with no known quantum attack. The UTXO set from that block height is committed in our genesis block.')}
${p('BTC holders can prove ownership of their address balance using a one-time ECDSA signature and claim the equivalent QBTC balance into a new ML-DSA-65 keypair. After that, all transactions are quantum-safe. The ECDSA proof is only used once — to migrate, not to transact.')}
${p('We\'re not trying to replace Bitcoin. We\'re building the financial layer that will still work when "harvest now, decrypt later" becomes "decrypt now". The codebase is open source, the snapshot is verifiable, and the claim mechanism requires no trust in us or anyone else.')}
${h2('What\'s Next')}
${p('We\'re on testnet. The core protocol is working: ML-DSA-65 signatures, BTC claims, SHA-256 proof-of-work, UTXO indexing. The claim pipeline — parsing 160M UTXOs from a Bitcoin Core dump and committing the merkle root in genesis — is running.')}
${p('If you want to dig into the cryptographic arguments, read our <a href="#/docs/security" class="text-qubit-400 hover:text-qubit-300 transition-colors">security docs</a>. If you want to run a node, see the <a href="#/docs/getting-started" class="text-qubit-400 hover:text-qubit-300 transition-colors">getting started guide</a>. If you just want to follow along, <a href="https://x.com/qubitcoin_" target="_blank" rel="noopener" class="text-qubit-400 hover:text-qubit-300 transition-colors">@qubitcoin_ on X</a>.')}`,
};

export default post;
