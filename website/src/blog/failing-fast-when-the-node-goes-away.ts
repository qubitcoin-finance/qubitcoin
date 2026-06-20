import { type BlogPost, h2, p } from './types.js';

const post: BlogPost = {
  slug: 'failing-fast-when-the-node-goes-away',
  title: 'Failing Fast When the Node Goes Away',
  date: '2026-06-20',
  tags: ['technical', 'engineering', 'development'],
  excerpt: 'The explorer now treats transport failures, HTTP errors, and partial endpoint failures as different states. A 15-second timeout, a typed API result union, and browser tests keep the UI responsive without lying about what failed.',
  content: () => `<h1 class="text-2xl font-bold mb-2">Failing Fast When the Node Goes Away</h1>
<p class="text-text-muted text-xs font-mono mb-8">2026-06-20</p>
${p('A block explorer only looks reliable when the happy path works. The harder part is what happens when the node is slow, the reverse proxy is down, or one endpoint fails while another still answers. If every failure collapses into a blank screen, users cannot tell whether the chain is empty, the route is wrong, or the backend is simply unreachable.')}
${p('QubitCoin&rsquo;s explorer now treats those cases as separate states. The fetch layer in <span class="font-mono text-xs text-qubit-400">website/src/explorer-api.ts</span> sets a hard 15-second timeout, converts every response into a small typed result union, and lets each view decide whether to show a global connection error, a route-specific 404, or a partial-data page that still renders the healthy half.')}
${h2('The First Fix Is Refusing to Wait Forever')}
${p('Browser <span class="font-mono text-xs text-qubit-400">fetch()</span> calls do not time out on their own. If an upstream process stalls, the explorer can sit in a loading state indefinitely even though the user already knows something is wrong. The simplest fix is also the right one: put a deadline at the transport boundary.')}
${p('<span class="font-mono text-xs text-qubit-400 block bg-surface rounded p-3 mb-2">const res = await fetch(`${API}${path}`, {<br>&nbsp;&nbsp;signal: AbortSignal.timeout(15_000),<br>})</span>')}
${p('That one line changes the failure mode completely. A dead node, a broken proxy, and a request that never completes all converge into a fast, bounded failure instead of an unbounded spinner. Fifteen seconds is long enough for a small self-hosted node to answer normal explorer requests, but short enough that a user can retry or switch routes without feeling trapped by the page.')}
${h2('Three Outcomes, Not One')}
${p('The more important design choice is what happens after the timeout or response arrives. The explorer does not collapse everything into <span class="font-mono text-xs text-qubit-400">null</span>. It uses a three-way result shape: success, HTTP failure, or transport failure.')}
${p('<span class="font-mono text-xs text-qubit-400 block bg-surface rounded p-3 mb-2">export type ApiResult&lt;T&gt; =<br>&nbsp;&nbsp;| { ok: true; data: T }<br>&nbsp;&nbsp;| { ok: false; status: number; networkError: false }<br>&nbsp;&nbsp;| { ok: false; status: 0; networkError: true }</span>')}
${p('That distinction sounds small, but it is exactly what keeps the UI honest. A 404 means the server answered and the requested object does not exist. A network error means the server might be fine, but the browser could not complete the request at all. Those are operationally different problems, and the page should not blur them together.')}
${h2('How the Views Use It')}
${p('Block and transaction pages take the strict path. If the network is down, they render the shared <span class="font-mono text-xs text-qubit-400">Unable to reach the node</span> state with a Retry button. If the backend returns 404, they render route-specific errors like <span class="font-mono text-xs text-qubit-400">Block not found</span> or <span class="font-mono text-xs text-qubit-400">Transaction not found</span>.')}
${p('The address page is more interesting because it depends on two endpoints in parallel: balance and UTXOs. If both die at the transport layer, the whole view is unavailable and the global connection error is correct. But if only one side fails, the explorer keeps the surviving half on screen. A balance failure still shows the UTXO set. A UTXO failure still shows the balance.')}
${p('<span class="font-mono text-xs text-qubit-400 block bg-surface rounded p-3 mb-2">const [balanceResult, utxoResult] = await Promise.all([<br>&nbsp;&nbsp;apiFull(`/address/${addr}/balance`),<br>&nbsp;&nbsp;apiFull(`/address/${addr}/utxos`),<br>])</span>')}
${p('That is a better contract than all-or-nothing rendering. The explorer is not pretending the page succeeded, but it is also not throwing away valid data because one adjacent request returned 500. In practice that matters on small nodes during indexing, on overloaded hosts, and during deployments where one code path is healthy before another is.')}
${h2('Testing the Unhappy Path in a Browser')}
${p('This only works if the browser tests cover it. QubitCoin&rsquo;s Playwright suite in <span class="font-mono text-xs text-qubit-400">website/e2e/api-error-handling.spec.ts</span> intercepts <span class="font-mono text-xs text-qubit-400">/api/v1</span> requests and drives the explorer through the same hash routes real users hit in production.')}
${p('The tests deliberately separate transport and application failures. <span class="font-mono text-xs text-qubit-400">route.abort(\'connectionrefused\')</span> simulates the network disappearing underneath the page. Route handlers that fulfill with status 404 or 500 simulate a healthy connection carrying an application-level error. The assertions then verify that each route lands in the right branch: connection error, not-found message, or partial address view.')}
${p('That browser-level coverage is the key guardrail for a vanilla TypeScript app built around <span class="font-mono text-xs text-qubit-400">innerHTML</span> updates. Backend tests can prove the RPC handlers return the right payloads, but they cannot prove that the frontend keeps rendering useful information when only half the page loads.')}
${h2('Why This Matters')}
${p('The explorer is the most visible operational surface in the project. When it fails ambiguously, users lose trust in the chain faster than they lose trust in any internal subsystem. A precise failure model does the opposite: it tells users whether the object is missing, the node is unreachable, or the backend only answered part of the question.')}
${p('None of this is exotic. It is just disciplined boundary design: put a timeout on network I/O, preserve the difference between transport and HTTP failures, and let views degrade in the smallest truthful way. For explorer software, that is usually the difference between a page that feels brittle and one that feels like it understands its own failure modes.')}`,
};

export default post;
