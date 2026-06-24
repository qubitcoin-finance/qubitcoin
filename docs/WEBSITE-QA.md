# Website QA Workflow

This doc covers the browser-side QA workflow for the Vite/Tailwind explorer: Playwright visual screenshots, mocked `/api/v1` data, API-error rendering checks, block-height UI checks, and XSS prevention tests. Read it when changing `website/src/*`, `website/e2e/*`, `website/playwright.config.ts`, explorer route rendering, API failure states, or screenshot coverage.

The website test suite is separate from the backend Vitest harness. It builds the static Vite app, serves it through `vite preview`, intercepts explorer API calls in Playwright, and verifies the UI across Tailwind breakpoints without requiring a live `qbtcd` node. Search terms that should land here include `pnpm run website:screenshots`, `pnpm screenshots`, `test:visual`, `TAILWIND_VIEWPORTS`, `api-responses.json`, `Unable to reach the node`, `Block not found`, `Transaction not found`, `Address not found`, and `escapeHtml`.

## Why It Exists

The explorer is a vanilla TypeScript single-page app with hash routing and direct `innerHTML` rendering. That keeps the runtime small, but it also means UI regressions can happen at boundaries the backend tests do not exercise: mobile breakpoints, loading/error views, route disambiguation, browser escaping, and stale fixture assumptions about `/api/v1` response shapes.

The Playwright suite solves those problems at the browser boundary. It does not boot a node or depend on production RPC availability. Instead, tests use `page.route('**/api/v1/**', ...)` to return deterministic JSON from `website/e2e/fixtures/api-responses.json`, then navigate to the same hash routes users use in production. This catches mismatches between `website/src/explorer-api.ts` types, `website/src/explorer-main.ts` rendering branches, and `website/src/explorer-format.ts` formatting helpers.

The suite also makes visual review reproducible. `website/playwright.config.ts` defines the viewport matrix, runs `pnpm run build && pnpm run preview`, and points tests at `http://localhost:4173`. The screenshot spec disables animations and writes full-page PNGs by route and viewport, so layout changes can be inspected without live-chain timing or reveal animations changing between runs.

## Key Files

| Anchor | Role |
|--------|------|
| `package.json:31` | Root `website` script starts the Vite dev server from `website/`. |
| `package.json:32` | Root `website:build` script runs the website Vite build. |
| `package.json:33` | Root `website:screenshots` script runs the website screenshot workflow from the repo root. |
| `website/package.json:7` | Local `dev` script for `vite`. |
| `website/package.json:8` | Local `build` script for `vite build`. |
| `website/package.json:10` | Local `test:visual` script for the Playwright suite. |
| `website/package.json:11` | Local `screenshots` script that runs Playwright and reports the screenshot directory. |
| `website/playwright.config.ts:3` | `TAILWIND_VIEWPORTS`, the mobile-through-2xl viewport matrix. |
| `website/playwright.config.ts:12` | Playwright config: `testDir`, output directory, timeout, reporter, and shared browser options. |
| `website/playwright.config.ts:25` | One Playwright project per Tailwind viewport. |
| `website/playwright.config.ts:30` | Web server command: build the app and serve it with `vite preview` on port 4173. |
| `website/vite.config.ts:5` | Vite config, including Tailwind plugin and single `index.html` entry. |
| `website/vite.config.ts:14` | Dev-server `/api` proxy to `API_URL` or `https://qubitcoin.finance`. |
| `website/e2e/fixtures/api-responses.json:1` | Shared deterministic API fixture payloads for status, blocks, txs, mempool, claims, and address views. |
| `website/e2e/visual.spec.ts:16` | `mockApi`, the route interceptor used by screenshot tests. |
| `website/e2e/visual.spec.ts:56` | `stabilize`, which disables animations and reveal transforms before screenshots. |
| `website/e2e/visual.spec.ts:73` | Screenshot route matrix: landing, dashboard, block, tx, address, docs, and API docs. |
| `website/e2e/visual.spec.ts:97` | Screenshot path convention: `tmp/screenshots/<viewport>/<route>.png`. |
| `website/e2e/api-error-handling.spec.ts:16` | Success fixture interceptor for baseline browser tests. |
| `website/e2e/api-error-handling.spec.ts:51` | Network-error interceptor using `route.abort('connectionrefused')`. |
| `website/e2e/api-error-handling.spec.ts:89` | Address-view API error coverage. |
| `website/e2e/api-error-handling.spec.ts:147` | Block-view API error coverage. |
| `website/e2e/api-error-handling.spec.ts:164` | Transaction-view confirmation and error coverage. |
| `website/e2e/block-height.spec.ts:29` | Block detail height-display checks. |
| `website/e2e/block-height.spec.ts:53` | Recent-blocks height-column checks. |
| `website/e2e/xss-prevention.spec.ts:37` | `setHash`, which injects raw hash-route payloads without browser percent-encoding. |
| `website/e2e/xss-prevention.spec.ts:43` | Block error-view XSS checks. |
| `website/e2e/xss-prevention.spec.ts:88` | Transaction error-view XSS checks. |
| `website/e2e/xss-prevention.spec.ts:116` | Address-view XSS checks. |
| `website/src/explorer-api.ts:93` | `ApiResult<T>`, the frontend success / HTTP error / network error union. |
| `website/src/explorer-api.ts:106` | `apiFull`, which maps failed fetches into `ApiResult<T>`. |
| `website/src/explorer-main.ts:90` | `renderError`, the shared network-error view with Retry. |
| `website/src/explorer-main.ts:234` | `renderBlock`, including network errors, 404 behavior, and tx fallback. |
| `website/src/explorer-main.ts:341` | `renderTx`, including network errors and 404 behavior. |
| `website/src/explorer-main.ts:485` | `renderAddress`, including partial balance/UTXO failures. |
| `website/src/explorer-format.ts:25` | `escapeHtml`, the browser-side escaping helper covered by XSS tests. |
| `website/src/explorer-format.ts:133` | `txStatus`, the confirmation-state helper covered by transaction tests. |

## How It Works

### Command Entry Points

There are root-level and website-local command forms. From the repository root, use `pnpm run website:build` for the static build and `pnpm run website:screenshots` for the Playwright screenshot/test workflow. From `website/`, use `pnpm build`, `pnpm test:visual`, or `pnpm screenshots`.

The root `pnpm build` is the backend TypeScript build only. It does not build `website/src/*`. Any change under `website/src/`, `website/index.html`, `website/vite.config.ts`, Tailwind styling, or browser-test wiring needs the website build command as its verification path.

The website `screenshots` script runs the full Playwright suite and then prints a message about `tmp/screenshots/`. It is not a separate lightweight screenshot-only command: the assertion specs and screenshot spec all run through `playwright test`.

### Playwright Runtime

`website/playwright.config.ts` is the runtime contract. Its `testDir` is `./e2e`, its test output directory is `./tmp/test-results`, and it uses a 30-second timeout with no retries. Screenshots and traces are disabled globally, because the screenshot spec writes its own route screenshots to stable paths.

The config defines six projects from `TAILWIND_VIEWPORTS`: `mobile`, `sm`, `md`, `lg`, `xl`, and `2xl`. Each project uses Desktop Chrome with a fixed viewport. This means every Playwright spec runs once per viewport, not just the visual capture spec. If a selector or text assertion is only valid on one breakpoint, it will fail across the whole matrix.

The `webServer` command is `pnpm run build && pnpm run preview`. Playwright therefore exercises the production Vite bundle served by preview, not the dev server. `reuseExistingServer: true` allows a server already listening on port 4173 to be reused, but the expected base URL is still `http://localhost:4173`.

```text
pnpm run website:screenshots
  -> cd website && pnpm run screenshots
    -> playwright test
      -> pnpm run build && pnpm run preview
      -> run every e2e spec for each viewport project
      -> visual.spec.ts writes tmp/screenshots/<viewport>/<route>.png
```

### API Mocking Boundary

The browser tests mock `/api/v1` at the network layer with `page.route`. That keeps tests close to real browser behavior: `fetch('/api/v1/status')` still runs from `website/src/explorer-api.ts`, but the response body is deterministic and local to the test process.

The shared fixture file is `website/e2e/fixtures/api-responses.json`. It contains representative `status`, recent `blocks`, one block detail, one transaction, mempool stats, mempool transactions, claim stats, balance, and UTXO payloads. Specs derive sample route parameters such as `SAMPLE_BLOCK_HASH`, `SAMPLE_TX_ID`, and `SAMPLE_ADDRESS` from that fixture rather than duplicating magic strings.

When adding a frontend view that fetches a new endpoint, update the fixture and every relevant `mockApi` helper in the specs that navigate through a route needing that endpoint. A missing route interceptor usually becomes a 404 fixture response, which can make the page render an error state instead of the intended happy path.

### Screenshot Coverage

`website/e2e/visual.spec.ts` covers the route matrix used for manual visual review:

- landing page at `/`
- explorer dashboard at `/#/mempool`
- block detail at `/#/block/<fixture hash>`
- transaction detail at `/#/tx/<fixture txid>`
- address detail at `/#/address/<fixture address>`
- docs index at `/#/docs`
- API docs at `/#/docs/api`

Before each screenshot, the spec waits for the SPA route to render, waits for network idle, and calls `stabilize`. `stabilize` injects CSS that disables animations/transitions and forces `.reveal` elements to visible, then waits briefly. This is why screenshot output is useful for layout review instead of being dominated by animation timing.

The screenshot path uses the Playwright project name as the viewport directory: `tmp/screenshots/mobile/landing.png`, `tmp/screenshots/lg/block-detail.png`, and so on. From the repo root, those files live under `website/tmp/screenshots/...` because the command runs inside `website/`.

### API Error Coverage

`website/e2e/api-error-handling.spec.ts` verifies the difference between network failures, HTTP 404s, partial endpoint failures, and confirmation metadata.

Network failures are simulated with `route.abort('connectionrefused')`. These should flow through `apiFull` as `{ ok: false, status: 0, networkError: true }`, then render the shared `Unable to reach the node` view with a Retry button.

HTTP 404 responses are not network errors. Block and transaction detail views render `Block not found` or `Transaction not found`; block lookup also attempts transaction fallback before showing the block 404. Address lookup calls balance and UTXO endpoints in parallel: two 404s become `Address not found`, but one failed endpoint can still leave the other half of the view visible.

Transaction confirmation states are tested by overriding the fixture transaction. No block metadata means `Unconfirmed`; low confirmation counts render `Confirming`; six or more confirmations render `Confirmed`. That behavior comes from `txStatus` rather than from backend-side string labels.

### XSS Coverage

The explorer uses `innerHTML` in many views, so browser tests cover the user-controlled pieces that can arrive through `location.hash`: block hashes, tx IDs, and addresses. The security boundary is `escapeHtml` in `website/src/explorer-format.ts`, with route-specific rendering in `explorer-main.ts`.

`website/e2e/xss-prevention.spec.ts` sets `location.hash` via `page.evaluate` instead of `page.goto`. That is intentional: `page.goto` can percent-encode raw characters before the router sees them, hiding the exact class of bug the tests are supposed to catch.

The XSS tests use payloads with `<img onerror=...>` and quote-breaking strings. They assert that marker properties like `window.__xss_block` remain undefined, that no live `img` element appears inside the error message, and that `innerHTML` does not contain unescaped fragments such as `<img` or `" onclick=`.

## Invariants and Edge Cases

The website tests must stay node-independent. Do not make Playwright depend on `qbtcd`, production RPC availability, or local chain data. Use route interception and fixtures unless a test is explicitly introduced as an integration test with a different command.

Fixture shapes must track `website/src/explorer-api.ts` interfaces and the actual RPC responses documented in [RPC-ENDPOINTS](./RPC-ENDPOINTS.md). If the backend adds server-owned fields such as `blockHeight` or `confirmations`, browser fixtures should represent both present and absent cases when the UI branches on them.

Every route that fetches data needs mocked responses for all requests it triggers. Dashboard rendering asks for status, blocks, mempool stats, and claim stats at once; address rendering asks for balance and UTXOs in parallel. A spec that only mocks the endpoint under direct inspection can accidentally test an unrelated error branch.

Route fixtures should stay minimal but complete. Prefer adding the smallest response fields the current renderer reads, because oversized fixtures make it harder to notice when frontend code starts depending on a field the RPC endpoint does not actually guarantee.

Screenshots are full-page and viewport-specific. If a page includes asynchronous reveal effects, polling, or time-relative labels, stabilize them before capture or assert against deterministic content. Existing screenshot tests disable animation, but they do not freeze `Date.now()`, so fixture timestamps should be old/stable enough that exact relative-time strings are not the primary screenshot signal.

Text assertions should target the stable UI contract rather than Tailwind implementation details when possible. Some existing tests use classes such as `p.text-red-500` because the XSS boundary is in an error paragraph; new tests should prefer semantic text, headings, route URLs, or explicit containers when that is enough.

Use `escapeHtml` for every user-controlled value rendered through `innerHTML`: route parameters, error text, addresses, hashes, badge text, and link attributes. The XSS tests cover the known hash-route entry points, but a new view can still introduce a separate injection path if it interpolates raw data directly.

Do not treat the website screenshot command as a replacement for backend tests. Browser tests verify that the frontend consumes `/api/v1` shapes correctly and renders them safely; consensus, mempool, storage, RPC handler behavior, and P2P logic remain covered by the backend Vitest suite.

## Cross-References

- [EXPLORER-DATA-FLOW](./EXPLORER-DATA-FLOW.md) explains the explorer hash router, `/api/v1` fetch helpers, and render functions that the browser tests exercise.
- [EXPLORER-CONTENT](./EXPLORER-CONTENT.md) explains the embedded docs/blog content rendered by the `#/docs` and `#/blog` routes.
- [RPC-ENDPOINTS](./RPC-ENDPOINTS.md) documents the backend response surface mirrored by the website fixture payloads.
- [RPC](./RPC.md) covers deployment-time proxy trust and rate-limit behavior for the live RPC server, outside the browser fixture boundary.
- [TEST-HARNESS](./TEST-HARNESS.md) covers the backend Vitest harness; use it for `src/__tests__/*`, not the Playwright browser suite.
