# Explorer Presentation Semantics

How the explorer turns raw `/api/v1` data into user-visible amounts, statuses, badges, timing, links, and escaped HTML. Read this when working on `website/src/explorer-format.ts`, transaction amount display, confirmation labels, dashboard ETA/difficulty cards, hash links, or symptoms such as "wrong transfer amount", "confirmed tx shows unconfirmed", "claim amount looks like change", or "hash route can inject HTML".

This page is about the display layer, not fetching or routing. `website/src/explorer-api.ts` defines the JSON shapes, and `website/src/explorer-main.ts` decides which view to render. The shared presentation contract lives in `website/src/explorer-format.ts`: small helpers convert satoshi integers, timestamps, raw targets, transaction structure, and route values into HTML snippets or plain strings used across dashboard, block, transaction, address, docs, and blog views.

## Why It Exists

The explorer does not use React, Vue, a virtual DOM, or a template engine. It renders strings through `innerHTML`, so display decisions are centralized in pure helpers where possible. That matters for three reasons.

First, the backend intentionally exposes structural data rather than UI labels. A transaction response says whether it has `claimData`, whether it has chain-owned `blockHash` / `blockHeight` / `confirmations`, and what its inputs and outputs are. The browser decides whether that should read as "Claim", "Transfer", "Unconfirmed", "Confirming", or "Confirmed".

Second, a UTXO transaction's "amount" is not always the sum of outputs. Regular spends often include change back to the sender, while coinbase and claim transactions have no normal sender. The explorer therefore needs one consistent rule for dashboard rows, block transaction lists, and transaction detail headers.

Third, every route parameter and many RPC fields are eventually interpolated into HTML strings. The explorer's security boundary is not automatic framework escaping; it is explicit use of `escapeHtml`, `hashLink`, `badge`, and route-specific escaping before writing to `innerHTML`.

## Key Files

| Anchor | Role |
|---|---|
| `website/src/explorer-format.ts:10` | `formatQBTC`, satoshi integer to human QBTC string without floating-point display artifacts. |
| `website/src/explorer-format.ts:25` | `escapeHtml`, shared HTML escaping helper for string-rendered views. |
| `website/src/explorer-format.ts:48` | `formatHashrate`, status hashrate formatter for dashboard cards. |
| `website/src/explorer-format.ts:59` | `formatDuration`, positive millisecond duration formatter. |
| `website/src/explorer-format.ts:69` | `avgBlockInterval`, recent-block interval estimator for the dashboard. |
| `website/src/explorer-format.ts:80` | `blockEta`, "next block" display using the memoryless PoW wait rule. |
| `website/src/explorer-format.ts:90` | `formatDifficulty`, simplified human difficulty label from a target hex string. |
| `website/src/explorer-format.ts:106` | `senderAddress`, browser-side SHA-256 derivation from the first input public key. |
| `website/src/explorer-format.ts:116` | `transferAmount`, amount display rule that excludes change back to the sender. |
| `website/src/explorer-format.ts:121` | `isCoinbase`, sentinel-input classifier using the all-zero txid. |
| `website/src/explorer-format.ts:125` | `isClaim`, claim classifier based on `claimData` presence. |
| `website/src/explorer-format.ts:129` | `isConfirmedTx`, chain-owned metadata classifier. |
| `website/src/explorer-format.ts:133` | `txStatus`, confirmation-state label and badge color. |
| `website/src/explorer-format.ts:158` | `txTypeBadge`, transaction type label: coinbase, claim, or transfer. |
| `website/src/explorer-format.ts:165` | `badge`, shared colored status pill renderer. |
| `website/src/explorer-format.ts:175` | `methodBadge`, docs/API method badge helper. |
| `website/src/explorer-format.ts:179` | `hashLink`, escaped hash/address link builder for hash routes. |
| `website/src/explorer-format.ts:184` | `renderBlockStrip`, dashboard block-strip renderer. |
| `website/src/explorer-format.ts:219` | `card`, shared dashboard stat card renderer. |
| `website/src/explorer-main.ts:136` | `renderDashboard`, primary consumer of cards, ETA, difficulty, block strip, and mempool amount labels. |
| `website/src/explorer-main.ts:234` | `renderBlock`, block detail view that applies transaction type and amount helpers. |
| `website/src/explorer-main.ts:341` | `renderTx`, transaction detail view that applies sender, amount, fee, status, and claim display helpers. |
| `website/src/explorer-main.ts:485` | `renderAddress`, address detail view that applies amount and link helpers to UTXOs. |
| `website/src/explorer-docs-api.ts:5` | API docs import of `methodBadge`, showing presentation helpers are shared by static docs too. |
| `website/e2e/xss-prevention.spec.ts:118` | Browser test coverage for escaped route-derived address rendering. |
| `docs/WEBSITE-QA.md:120` | QA doc section that treats `escapeHtml` as the browser-side XSS boundary. |

## How It Works

### Data Boundary

The frontend API layer imports no presentation helpers. It only returns typed values:

```text
/api/v1/status          -> Status
/api/v1/blocks          -> Block[]
/api/v1/tx/:txid        -> Transaction
/api/v1/mempool/txs     -> MempoolTx[]
/api/v1/address/*       -> balance or UTXO[]
```

`explorer-main.ts` receives those objects, then calls `explorer-format.ts` helpers at the last possible moment before building HTML. This keeps route/render logic readable while avoiding per-view reimplementation of QBTC amount formatting, transaction classification, badge colors, and hash links.

### Amount Display

`formatQBTC` treats all values as satoshi integers. It rounds the incoming number, splits whole and fractional units by `1e8`, trims trailing fractional zeros, and preserves a negative sign for fee-like calculations. It does not convert through a floating-point QBTC value, so values like `312_500_000` render cleanly as `3.125`.

`transferAmount` is the semantic layer above raw output totals:

- If `sender` is `null`, it returns the sum of all outputs.
- If `sender` is present, it sums only outputs whose address differs from `sender`.

That means coinbase and claim transactions display their minted or claimed output totals, while regular transfers display the value sent away from the sender and hide change outputs. Dashboard mempool rows use the backend-provided `MempoolTx.sender`; confirmed block and tx views derive the sender in the browser with `senderAddress`.

### Sender Derivation

`senderAddress` mirrors the native address rule: `SHA-256(publicKey)`. It returns `null` for coinbase and claim transactions because those inputs are sentinel inputs, not normal spend authority.

For regular transactions it reads the first input's `publicKey` hex, decodes it into bytes, and calls `crypto.subtle.digest('SHA-256', bytes)`. This is intentionally browser-local. The frontend does not call a backend address-derivation route just to render a sender label or compute change exclusion.

The helper uses only the first input. That matches the current wallet model where a normal transaction is created from UTXOs controlled by one ML-DSA wallet. If a future transaction builder supports mixed-sender inputs, `transferAmount` and sender display will need a different rule.

### Transaction Type And Status

Transaction type is structural:

- `isCoinbase` checks for exactly one input whose `txId` equals `COINBASE_TXID` (`'0'.repeat(64)`).
- `isClaim` checks whether `claimData` is present.
- `txTypeBadge` labels coinbase first, claim second, and all remaining transactions as transfer.

Confirmation status is also structural:

- `isConfirmedTx` requires `blockHash` to be a string and `blockHeight` to be a number.
- `txStatus` returns `Unconfirmed` when those fields are absent.
- Confirmed transactions with fewer than 6 confirmations show `Confirming`.
- Confirmed transactions with 6 or more confirmations show `Confirmed`.

The backend owns the confirmation metadata for confirmed transactions. The frontend only interprets fields returned by `/api/v1/tx/:txid`; it does not trust fields that may have existed in a submitted mempool transaction.

### Dashboard Timing And Difficulty

The dashboard combines live status fields with recent blocks:

```text
fetchStatus()
fetchBlocks(10)
fetchMempoolStats()
fetchClaimStats()
  -> renderDashboard()
  -> card(), formatHashrate(), formatDifficulty(), formatDuration()
  -> avgBlockInterval(), blockEta(), renderBlockStrip()
```

`avgBlockInterval` expects blocks newest-first, matching `/api/v1/blocks`. It subtracts each next timestamp from the previous timestamp and averages the intervals. If there are fewer than two blocks, it falls back to `status.targetBlockTime`.

`blockEta` treats proof-of-work as memoryless. If the projected next block time is already in the past, it still displays the average expected wait rather than `0s`. This avoids suggesting that a block is guaranteed immediately just because the network is overdue.

`formatDifficulty` is a display approximation from the target string, not a consensus calculation. It strips trailing dots, counts leading zero hex nibbles, uses the first non-zero byte as a divisor, then applies K/M/G/T suffixes. Consensus target checks stay in backend block validation.

### HTML Snippets And Escaping

Several helpers return HTML snippets:

- `badge` escapes its text before creating the colored pill.
- `methodBadge` delegates to `badge`.
- `hashLink` escapes the route value used in the `href`.
- `renderBlockStrip` builds dashboard links for known `Block` objects.
- `card` builds stat-card HTML from labels and values controlled by the renderer.

Views still have to escape values they interpolate directly. Examples include route-derived not-found messages, user-entered address routes, and decoded coinbase messages. `hashLink` is the preferred path for block, tx, and address links because it centralizes hash-route escaping and styling.

```text
route or RPC field
  -> escapeHtml() if written as text
  -> hashLink() if written as a hash-route link
  -> badge() if written inside a status pill
  -> root.innerHTML
```

## Invariants and Edge Cases

### Amounts Stay In Satoshis

`formatQBTC` accepts satoshi numbers. Callers should not pre-divide by `1e8`; doing so would display tiny values as if they were satoshis. Backend RPC responses and explorer API types all use satoshi integers for amounts.

### Change Exclusion Needs A Sender

`transferAmount` can only exclude change when a sender address is available. Mempool rows get `sender` from `summarizeMempoolTransaction`; confirmed block rows call `senderAddress` for each transaction. If sender derivation fails or intentionally returns `null`, the displayed amount becomes total outputs.

### Claim And Coinbase Inputs Are Sentinels

Coinbase and claim transactions should not pass through normal sender derivation or fee lookup. Their inputs do not reference normal UTXOs, and their amount display is the sum of minted or claimed outputs.

### Six Confirmations Is A UI Threshold

The `txStatus` six-confirmation threshold is a browser label threshold. It does not change consensus, mempool acceptance, claim maturity, coinbase maturity, or block validation. Consensus maturity rules remain in backend transaction and chain validation.

### Difficulty Labels Are Approximate

`formatDifficulty` is suitable for compact dashboard display only. It should not be reused for proof-of-work validation, difficulty retargeting, or tests that need exact target math.

### Time Helpers Assume Milliseconds

All explorer time helpers expect millisecond timestamps. Passing seconds will produce dates near 1970 and incorrect relative ages. Backend `BlockHeader.timestamp`, transaction `timestamp`, and status timing fields are already exposed in milliseconds.

### HTML Escaping Is Explicit

The explorer's `innerHTML` rendering means a new view can create an injection path even if existing tests pass. Any route parameter, decoded string, user-entered hash/address, or untrusted RPC field that is not going through `hashLink` or `badge` must go through `escapeHtml` before interpolation.

### `hashLink` Escapes The Route, Not The Display Override

`hashLink(hash, type, display)` escapes `hash` for the `href`. The default display is derived from the hash, but custom display strings are inserted as provided. Use custom displays only when the display value is known-safe, such as `#${block.height}` or a string already derived from a validated hash.

### Static Docs Share The Same Badge System

`website/src/explorer-docs-api.ts` imports `methodBadge` from `explorer-format.ts`, so presentation helper changes can affect static docs pages as well as live explorer views. A visual QA run should cover both live-data routes and docs routes when badge markup or colors change.

## Cross-References

- [EXPLORER-DATA-FLOW](./EXPLORER-DATA-FLOW.md) for hash routing, fetch helpers, and render function ownership.
- [WEBSITE-QA](./WEBSITE-QA.md) for Playwright visual checks, API-error rendering, confirmation-state tests, and XSS coverage.
- [RPC-ENDPOINTS](./RPC-ENDPOINTS.md) for the `/api/v1` response shapes that feed these presentation helpers.
- [TRANSACTION-ANATOMY](./TRANSACTION-ANATOMY.md) for transaction structure, coinbase sentinel inputs, and satoshi-denominated amounts.
- [CLAIM-FLOW](./CLAIM-FLOW.md) for `claimData` semantics and claim transaction validation.
- [UTXO-INDEXING](./UTXO-INDEXING.md) for address balances and UTXO lists rendered by the address view.
- [MINING-LIFECYCLE](./MINING-LIFECYCLE.md) for block timing, mining stats, and reward values shown on the dashboard.
