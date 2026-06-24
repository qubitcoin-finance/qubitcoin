# Explorer Data Flow

Read this when working on `website/src/explorer-main.ts` or `website/src/explorer-api.ts`, adding new explorer views, hooking up new `/api/v1` endpoints in the frontend, or debugging why a route renders wrong or goes blank.

The explorer is a vanilla TypeScript app. `website/src/explorer-main.ts` drives all block-explorer views, the embedded documentation, and the blog; `website/src/explorer-api.ts` owns the typed `/api/v1` fetch layer. It uses `window.location.hash` for routing, `fetch` against `/api/v1` for data, and innerHTML assignment for rendering. There is no framework, no virtual DOM, and no global state store.

## Key Files

| Path | Lines | Role |
|---|---|---|
| `website/src/explorer-api.ts` | — | TypeScript interfaces for every API response shape |
| `website/src/explorer-api.ts` | — | `API = '/api/v1'`, `ApiResult<T>`, `apiFull<T>`, `api<T>` — fetch helpers |
| `website/src/explorer-api.ts` | — | Named fetch shortcuts (`fetchStatus`, `fetchBlocks`, …) |
| `website/src/explorer-main.ts` | 48–69 | `Route` union type + `parseRoute()` — hash router |
| `website/src/explorer-main.ts` | 92–106 | `isExplorerRoute()`, `showExplorer()`, `showLanding()` |
| `website/src/explorer-main.ts` | 108–150 | `renderError()`, `renderLoading()` — UI chrome |
| `website/src/explorer-main.ts` | 229–340 | `renderDashboard()` — main overview page |
| `website/src/explorer-main.ts` | 344–447 | `renderBlock()` — block detail view |
| `website/src/explorer-main.ts` | 451–591 | `renderTx()` — transaction detail view |
| `website/src/explorer-main.ts` | 595–659 | `renderAddress()` — address balance + UTXOs |
| `website/src/explorer-main.ts` | 844–875 | `setupSearch()` — search-bar disambiguation |
| `website/src/explorer-main.ts` | 881–945 | `dispatch()` — central router; `hashchange` + init |
| `website/index.html` | — | Landing page and explorer shell (id=`landing-content`, id=`explorer-main`, id=`explorer-content`) |
| `website/vite.config.ts` | — | Single-page build for `index.html` |

## Routing

The explorer uses URL-hash routing. No server-side navigation — the browser never reloads.

```text
URL hash              parseRoute() result
──────────────────    ──────────────────────────────
(empty or #/)         { view: 'dashboard' } → showLanding()
#/block/<hash>        { view: 'block', hash }
#/tx/<txid>           { view: 'tx', txid }
#/address/<addr>      { view: 'address', addr }
#/mempool             { view: 'mempool' }
#/docs                { view: 'docs' }
#/docs/<section>      { view: 'docs', section }
#/blog                { view: 'blog' }
#/blog/<slug>         { view: 'blog', slug }
```

`parseRoute()` at `explorer-main.ts:58` slices `location.hash` after `#/`, splits on `/`, and matches the first segment. Unknown segments fall through to `{ view: 'dashboard' }`.

`dispatch()` at `explorer-main.ts:881` is called on page load and on every `hashchange` event. It:

1. Clears any running `refreshTimer` (dashboard auto-refresh).
2. Calls `isExplorerRoute()` — returns `false` only for `#/` or an empty hash. When false, `showLanding()` is called and dispatch returns immediately.
3. Otherwise calls `showExplorer()`, which toggles CSS `hidden` between `#landing-content` and `#explorer-main`.
4. Calls `parseRoute()` and dispatches to the appropriate render function via `switch`.
5. Sets `max-w-6xl` for data views, `max-w-[90rem]` for docs/blog (sidebar/grid layout).
6. Calls `window.scrollTo(0, 0)` after every render.

Only the `#/mempool` route installs a `setInterval` refresh (every 15 s) by re-rendering the dashboard. All other views are one-shot renders.

## Fetch Layer

Every network call flows through two wrappers:

### `apiFull<T>` (`explorer-api.ts`)

Returns a discriminated union `ApiResult<T>`:

- `{ ok: true, data: T }` — HTTP 2xx, JSON parsed.
- `{ ok: false, status: number, networkError: false }` — HTTP error (4xx/5xx).
- `{ ok: false, status: 0, networkError: true }` — fetch threw (no connection, CORS, etc.).

All errors are logged via `logApiError()` to `console.error` with a timestamp and the API path.

### `api<T>` (`explorer-api.ts`)

Thin wrapper over `apiFull`. Returns `T | null`. Render functions use this for convenience; they treat `null` as a signal to call `renderError()`.

### Named shortcuts (`explorer-api.ts`)

```
fetchStatus()           → GET /api/v1/status
fetchBlocks(count)      → GET /api/v1/blocks?count=N
fetchBlock(hash)        → GET /api/v1/block/:hash
fetchTx(txid)           → GET /api/v1/tx/:txid
fetchMempoolTxs(limit)  → GET /api/v1/mempool/txs[?limit=N]
fetchMempoolStats()     → GET /api/v1/mempool/stats
fetchBalance(addr)      → GET /api/v1/address/:addr/balance
fetchUtxos(addr)        → GET /api/v1/address/:addr/utxos
fetchClaimStats()       → GET /api/v1/claims/stats
fetchSnapshotAddress(a) → GET /api/v1/snapshot/address/:btcAddress
```

The Vite dev server proxies `/api` to `API_URL` when set, otherwise `https://qubitcoin.finance`. In production, nginx proxies `/api` → `127.0.0.1:3010`.

## TypeScript Interfaces

The interfaces in `website/src/explorer-api.ts` are the frontend's view of the RPC contract. They are maintained by hand — there is no code-generation step that derives them from the backend types.

Key shapes:

- `Status` (line 11) — `/api/v1/status` response; includes `height`, `difficulty`, `hashrate`, `peers`, `totalTxs`, and `targetBlockTime`.
- `Transaction` (line 45) — used by both `/api/v1/tx/:txid` and embedded inside `Block`. Carries optional `blockHash`/`blockHeight` for confirmed tx, optional `claimData` for claim transactions.
- `MempoolTx` (line 72) — lighter shape returned by `/api/v1/mempool/txs`; omits block fields.
- `Block` (line 65) — `/api/v1/blocks` and `/api/v1/block/:hash`; includes `transactions: Transaction[]`.
- `ClaimStats` (line 81) — `/api/v1/claims/stats`; aggregate claim totals plus `btcBlockHash` and `genesisHash` for replay-protected claim signing.
- `SnapshotAddressLookup` (line 90) — `/api/v1/snapshot/address/:btcAddress`; one BTC snapshot key's amount, script type, claim status, and claiming QBTC address when known.
- `UTXO` (line 99) — element of `/api/v1/address/:addr/utxos`.

## Render Functions

Each render function is `async`, fetches its own data, and writes to `root.innerHTML` (the `#explorer-content` div inside `index.html`).

### `renderDashboard()` (`explorer-main.ts:229`)

Fires five parallel fetches: `fetchStatus()`, `fetchBlocks(10)`, `fetchMempoolStats()`, `fetchClaimStats()`, and `fetchMempoolTxs(8)`. Renders the stats card grid, the BTC snapshot eligibility lookup (`fetchSnapshotAddress()` on form submit), the block strip (`renderBlockStrip()`), and up to 8 recent mempool transactions.

### `renderBlock(hash)` (`explorer-main.ts:344`)

Fetches `/api/v1/block/:hash`. If the hash is 64-hex but the block API returns null, attempts `/api/v1/tx/:hash` and redirects to the tx view. Renders block header fields, then a transaction list with type badges.

### `renderTx(txid)` (`explorer-main.ts:451`)

Fetches `/api/v1/tx/:txid`. For each non-coinbase, non-claim input, it then batches secondary `fetchTx(inp.txId)` calls with `Promise.all` to resolve source output amounts. Renders inputs, outputs, claim data if present, and confirmation status.

### `renderAddress(addr)` (`explorer-main.ts:595`)

Fires `fetchBalance(addr)` and `fetchUtxos(addr)` in parallel. Renders the balance summary and a UTXO list. Empty UTXO list with non-zero balance is possible while UTXOs are still being indexed on a fresh node.

## Search Disambiguation (`setupSearch`, `explorer-main.ts:844`)

On Enter keypress, the search bar applies this heuristic:

1. If the query matches `/^[0-9a-fA-F]{64}$/` — try `fetchBlock(q)` first.
2. If block not found — try `fetchTx(q)`.
3. If neither — treat as address (SHA-256 derived addresses are also 64-hex).
4. Anything else — treat as address directly.

The search triggers a hash change, which drives `dispatch()` normally.

## Helper Utilities

A set of pure functions formats display values without touching the DOM:

| Function | Lines | Purpose |
|---|---|---|
| `formatQBTC(satoshis)` | 10 | Satoshis → QBTC string with up to 8 decimal places |
| `truncHash(hash, len)` | 29 | Shorten a hash to `len` prefix chars |
| `timeAgo(ms)` | 38 | Millisecond timestamp → "X seconds ago" |
| `formatHashrate(h)` | 48 | H/s → KH/s / MH/s / GH/s |
| `formatDifficulty(hexTarget)` | 90 | Hex target → decimal difficulty ratio |
| `isCoinbase(tx)` | 121 | True when inputs[0].txId === `'0'.repeat(64)` |
| `isClaim(tx)` | 125 | True when `tx.claimData !== undefined` |
| `senderAddress(tx)` | 106 | Async: SHA-256 of `inputs[0].publicKey` hex → sender addr |

`senderAddress` uses the browser's `crypto.subtle.digest` — it never calls the backend.

## Docs and Blog Views

The docs and blog views are self-contained within the module:

- `renderDocs(section?)` (`explorer-main.ts:760`) — renders one of ten doc sections defined in `DOC_SECTIONS` by matching `section` against their `id` field. Falls back to the overview when `section` is undefined.
- `renderBlogList()` / `renderBlogPost(slug)` (`explorer-main.ts:663`, `723`) — renders the blog index or a single post. Blog posts are imported as TypeScript modules from `website/src/blog/`.

Neither view makes network requests; all content is bundled at build time.

## Invariants and Edge Cases

- **`root` never null** — `document.getElementById('explorer-content')!` uses a non-null assertion; if `index.html` changes the element id, every render call throws at runtime.
- **Hash format** — `parseRoute()` strips exactly two characters (`#/`). A hash without the slash prefix (e.g. `#block/...`) will not route correctly.
- **Concurrent dispatches** — `hashchange` events can fire in rapid succession. The `refreshTimer` is cleared at the top of `dispatch()`, but there is no in-flight fetch cancellation; a slow render from a prior hash can still write to `root` after a new dispatch has already started a new render.
- **senderAddress race** — `renderTx` resolves sender addresses with secondary fetches inside a loop. If the RPC returns 404 for a spent input's txid (pruned or reorged), `fetchTx` returns null and the input renders without an address rather than erroring.
- **Landing vs. explorer split** — `isExplorerRoute()` treats `#/` as the landing page. Any other `#/...` hash still shows the explorer shell; unknown segments fall through to `{ view: 'dashboard' }`, which renders the dashboard inside the explorer rather than switching back to the landing page.

## Cross-References

- [BLOCK-STORAGE.md](./BLOCK-STORAGE.md) — how the backend serializes blocks that the explorer fetches via `/api/v1/block/:hash`
- [MEMPOOL-LIFECYCLE.md](./MEMPOOL-LIFECYCLE.md) — what `/api/v1/mempool/txs` returns and when transactions are evicted
- [CLAIM-FLOW.md](./CLAIM-FLOW.md) — `claimData` fields rendered by `renderTx()`
- [RPC.md](./RPC.md) — reverse-proxy setup that routes `/api` to the backend RPC port
