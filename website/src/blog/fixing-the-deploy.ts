import { type BlogPost, h2, p } from './types.js';

const post: BlogPost = {
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
};

export default post;
