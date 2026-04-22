// QubitCoin blog post content.
// Posts are defined here so the main explorer file doesn't grow unbounded as
// new entries are added. Helpers below mirror the prose formatters in
// explorer-main.ts — kept in sync intentionally so this module stays standalone.

export interface BlogPost {
  slug: string;
  title: string;
  date: string;
  tags: string[];
  excerpt: string;
  content: () => string;
}

export const BLOG_TAG_COLORS: Record<string, string> = {
  bitcoin: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  cryptography: 'text-qubit-400 bg-qubit-600/10 border-qubit-600/20',
  quantum: 'text-entropy-cyan bg-entropy-cyan/10 border-entropy-cyan/20',
  technical: 'text-entropy-blue bg-entropy-blue/10 border-entropy-blue/20',
  'ml-dsa': 'text-qubit-300 bg-qubit-600/10 border-qubit-600/20',
  dilithium: 'text-qubit-300 bg-qubit-600/10 border-qubit-600/20',
  development: 'text-green-400 bg-green-500/10 border-green-500/20',
  testnet: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  engineering: 'text-entropy-blue bg-entropy-blue/10 border-entropy-blue/20',
};

function h2(text: string): string {
  return `<h2 class="text-xl font-bold mt-8 mb-3">${text}</h2>`;
}

function p(text: string): string {
  return `<p class="text-text-secondary text-sm leading-relaxed mb-3">${text}</p>`;
}

function steps(items: string[]): string {
  const lis = items.map(item => `<li class="pl-1">${item}</li>`).join('\n  ');
  return `<div class="bg-surface rounded-lg glow-border p-4 mb-4">
<ol class="text-text-secondary text-sm leading-relaxed list-decimal list-inside space-y-3">
  ${lis}
</ol>
</div>`;
}

export const BLOG_POSTS: BlogPost[] = [
  {
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
  },
  {
    slug: 'inside-ml-dsa-65',
    title: 'Inside ML-DSA-65: The Signature Algorithm Securing QubitCoin',
    date: '2026-04-10',
    tags: ['cryptography', 'ml-dsa', 'dilithium', 'technical'],
    excerpt: 'A technical walkthrough of Module-Lattice Digital Signature Algorithm — why NIST chose it, how it works at a high level, and what the tradeoffs mean for a Bitcoin-style UTXO chain.',
    content: () => `<h1 class="text-2xl font-bold mb-2">Inside ML-DSA-65: The Signature Algorithm Securing QubitCoin</h1>
<p class="text-text-muted text-xs font-mono mb-8">2026-04-10</p>
${p('QubitCoin replaces ECDSA secp256k1 with ML-DSA-65 — formally specified in NIST FIPS 204. This post walks through what that means, why we chose it, and what the practical tradeoffs look like on a UTXO chain.')}
${h2('What Is a Lattice-Based Signature?')}
${p('Classical public-key cryptography (RSA, ECDSA) relies on problems that quantum computers can solve efficiently with Shor\'s algorithm. Lattice-based cryptography relies on different hard problems — specifically the <strong>Module Learning With Errors (MLWE)</strong> problem.')}
${p('MLWE asks: given a matrix A and a vector b = As + e (where s is a secret vector and e is small random noise), recover s. No efficient classical or quantum algorithm is known for this. The best known attacks are exponential in the dimension of the lattice.')}
${p('ML-DSA (Module-Lattice Digital Signature Algorithm, formerly Dilithium) builds a signature scheme on top of MLWE. Signing involves producing a response to a challenge derived from a hash of the message, and verifying checks that the response is consistent with the public key without revealing the secret.')}
${h2('ML-DSA-65 Parameters')}
${p('NIST standardized three ML-DSA parameter sets. We use ML-DSA-65:')}
<div class="bg-surface rounded-xl glow-border p-5 my-4">
  <div class="space-y-3 font-mono text-xs">
    <div class="flex justify-between items-center py-2 border-b border-border">
      <span class="text-text-muted">Parameter set</span><span class="text-qubit-300">ML-DSA-65</span>
    </div>
    <div class="flex justify-between items-center py-2 border-b border-border">
      <span class="text-text-muted">NIST security level</span><span class="text-entropy-cyan">3 (≈ AES-192)</span>
    </div>
    <div class="flex justify-between items-center py-2 border-b border-border">
      <span class="text-text-muted">Public key size</span><span class="text-qubit-300">1,952 bytes</span>
    </div>
    <div class="flex justify-between items-center py-2 border-b border-border">
      <span class="text-text-muted">Secret key size</span><span class="text-qubit-300">4,000 bytes</span>
    </div>
    <div class="flex justify-between items-center py-2 border-b border-border">
      <span class="text-text-muted">Signature size</span><span class="text-qubit-300">3,293 bytes</span>
    </div>
    <div class="flex justify-between items-center py-2">
      <span class="text-text-muted">Library</span><span class="text-qubit-300">@noble/post-quantum</span>
    </div>
  </div>
</div>
${p('For comparison, a Bitcoin ECDSA public key is 33 bytes compressed and a DER signature is ~71 bytes. ML-DSA-65 is roughly 50× larger. This is the fundamental tradeoff of post-quantum signatures today — more security margin costs more bytes.')}
${h2('Why Level 3, Not Level 2 or 5?')}
${p('ML-DSA-44 (Level 2) is smaller but targets ~128-bit quantum security. ML-DSA-87 (Level 5) targets ~256-bit quantum security but signatures are 4,595 bytes. Level 3 gives us ~192-bit quantum security — comparable to a 192-bit symmetric key, which is well beyond any foreseeable attack.')}
${p('We picked Level 3 because it\'s the sweet spot: enough security margin that no realistic quantum computer in the next several decades threatens it, without the extra 40% signature overhead of Level 5.')}
${h2('Impact on Block Size')}
${p('Larger signatures mean larger transactions. A typical QubitCoin transaction with one input and two outputs is roughly 5–6 KB — versus ~250 bytes for a comparable Bitcoin transaction. This affects block capacity.')}
${p('We target the same 10-minute block time with a block size limit that accounts for these larger inputs. The UTXO model is otherwise identical to Bitcoin — same selection algorithm, same fee mechanics, same coin value structure.')}
${h2('Implementation')}
${p('We use <span class="font-mono text-xs text-qubit-400">@noble/post-quantum</span> — a zero-dependency TypeScript implementation of FIPS 204 by Paul Miller. It\'s audited, constant-time where it matters, and runs in both Node.js and browser environments.')}
${p('Key generation, signing, and verification all happen in-process. The private key never leaves the node that holds it — same trust model as Bitcoin.')}
${p('For the technical specification, see our <a href="#/docs/architecture" class="text-qubit-400 hover:text-qubit-300 transition-colors">architecture docs</a>. For the security analysis, see the <a href="#/docs/security" class="text-qubit-400 hover:text-qubit-300 transition-colors">security section</a>.')}`,
  },
  {
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
${p('The pipeline works. Running it end-to-end — from raw dump to a genesis block with a valid merkle commitment — takes several hours on commodity hardware. The output is a <span class="font-mono text-xs text-qubit-400">.jsonl</span> file that ships with the Docker image.')}
${p('What surprised us: aggregating by address (summing all UTXOs per address) is the right UX decision but complicates the merkle proof slightly. You can\'t prove a specific UTXO is in the set — you prove an address balance is in the set. This actually simplifies the claim flow since users think about addresses, not UTXOs.')}
${h2('The Claim Mechanism')}
${p('BTC claims work as special transactions. A claim transaction has no inputs in the traditional UTXO sense — instead it has a <span class="font-mono text-xs text-qubit-400">claimData</span> field containing the Bitcoin address, the ECDSA public key, an ECDSA signature over a canonical claim message, and the new QBTC address.')}
${p('The node verifies: the ECDSA public key hashes to the BTC address, the ECDSA signature is valid over the claim message, the address exists in the snapshot with unclaimed balance, and then mints the QBTC into the new ML-DSA-65 address. First claim wins — no double-claiming.')}
${p('This is clean and trustless. The claim message binds the QBTC address into the signature so you can\'t replay someone else\'s claim proof to redirect funds to your own key.')}
${h2('P2P and Mining')}
${p('We run two nodes on the testnet server — <span class="font-mono text-xs text-qubit-400">qbtc-node</span> and <span class="font-mono text-xs text-qubit-400">qbtc-q</span> — peered together and both mining. This gives us a live network with two independent miners, which exercises the P2P sync, block propagation, and difficulty adjustment code continuously.')}
${p('The difficulty adjustment runs every 2016 blocks targeting a 10-minute average. On testnet with two nodes, we see blocks come in much faster at the start (before difficulty catches up), which is expected.')}
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
  'More peers — testnet with two nodes is minimal. We want external nodes joining.',
  'Documentation — the technical docs are solid, but the user-facing claim guide needs work.',
])}
${p('Follow along on <a href="https://x.com/qubitcoin_" target="_blank" rel="noopener" class="text-qubit-400 hover:text-qubit-300 transition-colors">X</a> or join the <a href="https://t.me/qubitcoin_finance" target="_blank" rel="noopener" class="text-qubit-400 hover:text-qubit-300 transition-colors">Telegram</a> for updates. The code is all on <a href="https://github.com/qubitcoin-finance/qubitcoin" target="_blank" rel="noopener" class="text-qubit-400 hover:text-qubit-300 transition-colors">GitHub</a>.')}`,
  },
  {
    slug: 'fixing-the-deploy',
    title: 'Fixing the Deploy: How Every Push Was Breaking the Node',
    date: '2026-04-22',
    tags: ['development', 'engineering'],
    excerpt: 'The block explorer was showing "Unable to reach the node" after every deploy, yet the node ran fine on the server. Here\'s what was happening and how we fixed it.',
    content: () => `<h1 class="text-2xl font-bold mb-2">Fixing the Deploy: How Every Push Was Breaking the Node</h1>
<p class="text-text-muted text-xs font-mono mb-8">2026-04-22</p>
${p('For the past week, pushing to <span class="font-mono text-xs text-qubit-400">main</span> would leave the block explorer showing "Unable to reach the node." Log in to the server, and the node was running fine. Deploy again, and it would break again. Classic heisenbug.')}
${h2('The Setup')}
${p('The node runs on a single server via Docker Compose. The GitHub Actions workflow builds a new Docker image on every push to <span class="font-mono text-xs text-qubit-400">main</span>, then the self-hosted runner on the server pulls the image and restarts the stack. The node should come back up on port 3010, nginx proxies to it, done.')}
${p('The original design ran two nodes — <span class="font-mono text-xs text-qubit-400">qbtc-node</span> (main) and <span class="font-mono text-xs text-qubit-400">qbtc-q</span> (peer miner) — both on host networking sharing the server, connected to each other for a minimal testnet network. <span class="font-mono text-xs text-qubit-400">qbtc-node</span> on P2P port 6001, <span class="font-mono text-xs text-qubit-400">qbtc-q</span> on P2P port 6002.')}
${h2('The Problem')}
${p('Two bugs compounded each other.')}
${p('<strong>First:</strong> the CLI argument parser in the daemon only handled space-separated flags (<span class="font-mono text-xs text-qubit-400">--key value</span>), but Docker Compose was passing them as <span class="font-mono text-xs text-qubit-400">--key=value</span>. Every argument was silently ignored and the daemon started with defaults — including the default P2P port of 6001 for both containers. With host networking, the second container to start would crash with <span class="font-mono text-xs text-qubit-400">EADDRINUSE :::6001</span>.')}
${p('<strong>Second:</strong> the main node container was named <span class="font-mono text-xs text-qubit-400">qbtc-node</span> in Compose, but a legacy container called <span class="font-mono text-xs text-qubit-400">qbtc-miner</span> had been running on the server from before Compose was introduced. Compose didn\'t know about it, so <span class="font-mono text-xs text-qubit-400">--remove-orphans</span> left it running. It was the container that actually served traffic — which is why the node appeared healthy between deploys.')}
${p('Each deploy: old containers recreated with broken args → both grab port 6001 → qbtc-node crashes → health check times out after 5 minutes → deploy fails → qbtc-miner still running → site works until next push.')}
${h2('The Fix')}
${p('The fix was simpler than the diagnosis. We dropped down to a single node — the CPU overhead of running two miners on the same box for a testnet network wasn\'t worth it. One node mines, one node is enough.')}
${p('The container is now named <span class="font-mono text-xs text-qubit-400">qbtc-miner</span> in Compose to match what was already running, so the first deploy adopts the existing container rather than fighting it. The <span class="font-mono text-xs text-qubit-400">--key=value</span> argument parsing bug is fixed in the daemon so CLI flags are actually read. Blockchain data lives in a bind-mounted directory on the host, so recreating the container doesn\'t touch it.')}
${p('The next push will be the first clean deploy in a week.')}`,
  },
  {
    slug: 'run-a-node',
    title: 'Run a Node. Help Build the Network.',
    date: '2026-04-22',
    tags: ['testnet', 'development'],
    excerpt: 'QubitCoin is a one-node testnet right now. That needs to change. Here\'s how to spin up a node in minutes and why it matters.',
    content: () => `<h1 class="text-2xl font-bold mb-2">Run a Node. Help Build the Network.</h1>
<p class="text-text-muted text-xs font-mono mb-8">2026-04-22</p>
${p('QubitCoin testnet is currently running on a single node. One server, one miner, one point of failure. That\'s not a network — it\'s a demo. We need more nodes, and we\'re asking you to run one.')}
${h2('Why It Matters')}
${p('A blockchain with one node isn\'t decentralized. Every property we care about — censorship resistance, trustless verification, resilience — requires a real peer-to-peer network. Every node you add makes the network harder to shut down and easier to trust.')}
${p('Testnet is also where we find the bugs that mainnet can\'t afford. Nodes in different network conditions, on different hardware, run by people who aren\'t us — that\'s the only real test. If you run into something broken, we want to know.')}
${h2('How to Run a Node')}
${p('You need Docker. That\'s it.')}
<div class="bg-surface rounded-lg glow-border p-4 mb-4 font-mono text-xs text-text-secondary leading-relaxed space-y-2">
  <p class="text-qubit-400"># pull and run</p>
  <p>docker run -d \\</p>
  <p>&nbsp;&nbsp;--name qbtc \\</p>
  <p>&nbsp;&nbsp;--network host \\</p>
  <p>&nbsp;&nbsp;--restart unless-stopped \\</p>
  <p>&nbsp;&nbsp;-v $(pwd)/qbtc-data:/data \\</p>
  <p>&nbsp;&nbsp;ghcr.io/qubitcoin-finance/qbtcd:main \\</p>
  <p>&nbsp;&nbsp;--datadir=/data --port=3010 --mine</p>
</div>
${p('Your node will connect to <span class="font-mono text-xs text-qubit-400">qubitcoin.finance:6001</span> as a seed peer, sync the chain, and start mining. P2P is on port 6001 — open it inbound if you\'re behind a firewall so other nodes can reach you.')}
${p('Check it\'s running:')}
<div class="bg-surface rounded-lg glow-border p-4 mb-4 font-mono text-xs text-text-secondary">
  <p>curl http://localhost:3010/api/v1/status</p>
</div>
${h2('What You Get')}
${p('Mining on testnet means every block you find earns QBTC. No value yet — this is testnet — but early miners are the ones who build up balances before any claim mechanism goes live. When the snapshot import is finalized and mainnet launches, the network you helped build is the one everyone uses.')}
${h2('Come Talk to Us')}
${p('We\'re a small team building in public. If you run a node, hit a bug, have a question, or just want to follow along:')}
<div class="bg-surface rounded-xl glow-border p-5 my-4 space-y-4">
  <a href="https://x.com/qubitcoin_" target="_blank" rel="noopener" class="flex items-center gap-3 group">
    <span class="text-lg">𝕏</span>
    <div>
      <div class="text-sm font-medium text-text-primary group-hover:text-qubit-400 transition-colors">@qubitcoin_ on X</div>
      <div class="text-xs text-text-muted">announcements, updates, technical threads</div>
    </div>
  </a>
  <a href="https://t.me/qubitcoin_finance" target="_blank" rel="noopener" class="flex items-center gap-3 group">
    <span class="text-lg">✈</span>
    <div>
      <div class="text-sm font-medium text-text-primary group-hover:text-qubit-400 transition-colors">Telegram: qubitcoin_finance</div>
      <div class="text-xs text-text-muted">questions, node operators, community chat</div>
    </div>
  </a>
  <a href="https://github.com/qubitcoin-finance/qubitcoin" target="_blank" rel="noopener" class="flex items-center gap-3 group">
    <span class="text-lg">⌥</span>
    <div>
      <div class="text-sm font-medium text-text-primary group-hover:text-qubit-400 transition-colors">GitHub: qubitcoin-finance/qubitcoin</div>
      <div class="text-xs text-text-muted">source code, issues, PRs welcome</div>
    </div>
  </a>
</div>
${p('The more nodes, the better. Run one.')}`,
  },
];
