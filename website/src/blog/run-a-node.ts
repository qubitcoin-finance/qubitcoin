import { type BlogPost, h2, p } from './types.js';

const post: BlogPost = {
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
};

export default post;
