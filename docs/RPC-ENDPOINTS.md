# RPC Endpoint Surface

How the implemented `/api/v1` RPC API is wired, validated, sanitized, and exposed to the explorer. Read this when adding or debugging `startRpcServer`, `GET /api/v1/status`, `GET /api/v1/blocks`, `GET /api/v1/block/:hash`, `GET /api/v1/block-by-height/:height`, `GET /api/v1/tx/:txid`, `POST /api/v1/tx`, `GET /api/v1/mempool/txs`, `GET /api/v1/address/:address/*`, `GET /api/v1/claims/stats`, `GET /api/v1/snapshot/address/:btcAddress`, `GET /api/v1/difficulty`, or `GET /api/v1/peers`.

This page is the endpoint catalog for the live RPC server in `src/rpc.ts`. It covers route ordering, request validation, response shaping, binary sanitization, body-size errors, and the split between confirmed-chain reads and mempool reads. For deployment-specific proxy and rate-limit configuration, see [RPC](./RPC.md); for frontend fetch wiring, see [EXPLORER-DATA-FLOW](./EXPLORER-DATA-FLOW.md).

## Why It Exists

The RPC server is the public JSON boundary around the node. It has to expose chain, mempool, claim, difficulty, and peer state without leaking raw `Uint8Array` values, without trusting client-provided confirmation metadata, and without letting malformed query strings or large JSON bodies become expensive work.

The implementation is deliberately thin: `startRpcServer` reads from `Node`, `Blockchain`, `Mempool`, and optional `P2PServer` objects, then delegates real consensus and admission checks to the modules that own them. `POST /api/v1/tx` deserializes the submitted transaction and calls `Node.receiveTransaction`; block and address queries read the chain indexes; mempool listing calls the same ordering path the miner uses.

The fragile part is not business logic, but the boundary behavior. Hashes and addresses must be 64-character hex strings, numeric query parameters must be whole non-negative decimal strings, response bodies must pass through `sanitize`, and unrecognized API routes must still produce JSON errors so browser and CLI clients do not have to special-case Express HTML responses.

## Key Files

| Anchor | Role |
|---|---|
| `src/rpc.ts:43` | `startRpcServer`, the single Express app factory for all RPC routes |
| `src/rpc.ts:52` | `app.set('trust proxy', trustProxy)` applies parsed proxy trust before rate limiting |
| `src/rpc.ts:68` | CORS policy: permissive only when bound to `127.0.0.1` |
| `src/rpc.ts:69` | Per-method rate limiter middleware, POST bucket separated from all other methods |
| `src/rpc.ts:73` | JSON body parser with `MAX_BODY_SIZE = '1mb'` |
| `src/rpc.ts:76` | `GET /api/v1/status` |
| `src/rpc.ts:83` | `GET /api/v1/block/:hash` |
| `src/rpc.ts:98` | `GET /api/v1/block-by-height/:height` |
| `src/rpc.ts:116` | `GET /api/v1/blocks` |
| `src/rpc.ts:130` | `GET /api/v1/tx/:txid` |
| `src/rpc.ts:161` | `POST /api/v1/tx` |
| `src/rpc.ts:178` | `GET /api/v1/mempool/txs` |
| `src/rpc.ts:191` | `GET /api/v1/mempool/stats` |
| `src/rpc.ts:198` | `GET /api/v1/address/:address/balance` |
| `src/rpc.ts:209` | `GET /api/v1/address/:address/utxos` |
| `src/rpc.ts:220` | `GET /api/v1/claims/stats` |
| `src/rpc.ts:225` | `GET /api/v1/snapshot/address/:btcAddress` |
| `src/rpc.ts:240` | `GET /api/v1/difficulty` |
| `src/rpc.ts:251` | `GET /api/v1/peers` |
| `src/rpc.ts:261` | API-scoped JSON 404 handler |
| `src/rpc.ts:269` | JSON parse, body-size, and fallback error handler |
| `src/rpc-mempool.ts:14` | `summarizeMempoolTransaction`, lightweight mempool response mapper |
| `src/rpc-rate-limit.ts:18` | `createRateLimiter`, in-memory sliding-window limiter |
| `src/rpc-trust-proxy.ts:5` | `parseRpcTrustProxy`, CLI value parser used before server startup |
| `src/utils.ts:4` | `isValidHash`, strict lowercase 64-hex hash guard |
| `src/utils.ts:40` | `sanitize`, recursive `Uint8Array` to hex conversion for JSON |
| `src/node.ts:161` | `Node.getState`, source of `/api/v1/status` fields |

## How It Works

### Server Construction

`startRpcServer(node, port, p2pServer?, bindAddress?, trustProxy?, rateLimitConfig?)` creates an Express app and returns it to the caller. The `port` argument is part of the function signature, but the app is not listened inside `startRpcServer`; callers still call `app.listen(...)`.

Before routes are registered, the app:

1. Sets Express proxy trust from the supplied `RpcTrustProxy`.
2. Disables `X-Powered-By`.
3. Installs the per-method rate limiter.
4. Installs CORS according to `bindAddress`.
5. Installs the JSON parser with a 1 MB body limit.

The middleware order matters. Rate limiting runs before JSON parsing, so a client cannot avoid the limiter with a malformed or oversized body. The JSON error handler is registered after all routes, so parse failures and body-size failures are normalized into JSON payloads rather than Express defaults.

```text
request
  -> trust proxy affects req.ip
  -> GET or POST rate bucket
  -> express.json({ limit: '1mb', strict: false })
  -> /api/v1 route handlers
  -> /api/v1 JSON 404
  -> non-API JSON 404
  -> JSON parse/body-size/fallback error handler
```

### Shared Validation And Serialization

Hash routes lower-case the path parameter before calling `isValidHash`. That helper only accepts a string matching lowercase `[0-9a-f]{64}`, so lower-casing in the route lets uppercase client hashes work while still rejecting non-hex, too-short, and too-long values.

Address routes use the local `isValidAddress`, which accepts either case through `ADDRESS_RE`, then lower-case before `getBalance` or `findUTXOs`. This is important because address indexes are keyed by lowercase native addresses; without the normalization, uppercase query strings would silently look empty.

Most responses call `sanitize` before `res.json`. That recursively turns `Uint8Array` values into hex strings, preserving the JSON boundary used by storage, P2P-facing shapes, explorer rendering, and tests. The mempool summary route does not return full transactions; it calls `summarizeMempoolTransaction`, which strips input `publicKey` and `signature` fields and returns only outpoints, outputs, sender, timestamp, and optional sanitized claim data.

### Endpoint Flow

`GET /api/v1/status` calls `node.getState()` and adds `peers` from `p2pServer.getPeers().length` if a P2P server is attached. It returns node name, height, mempool size, UTXO count, truncated difficulty, last block time, target block time, average block time, next block reward, total transaction count, estimated hashrate, cumulative work, live mining stats, and peer count.

`GET /api/v1/block/:hash` validates a 64-hex hash and linearly searches `node.chain.blocks` for a matching block hash. A malformed hash is `400`; a well-formed but unknown hash is `404`.

`GET /api/v1/block-by-height/:height` accepts only `/^\d+$/`, parses base 10, rejects values above `2_147_483_647`, then indexes `node.chain.blocks[height]`. Height `0` is genesis; a height equal to or greater than `blocks.length` is `404`.

`GET /api/v1/blocks?count=N` returns the newest blocks in reverse height order. `count` defaults to `10`, accepts `0`, rejects non-integer strings like `100abc` and negative values, and caps the requested count at `100`. The implementation slices the newest window before reversing so a large chain is not copied and reversed in full.

### Transaction Reads And Writes

`GET /api/v1/tx/:txid` checks the mempool before the chain. If the transaction is still unconfirmed, the raw transaction is returned without `blockHash`, `blockHeight`, or `confirmations`. If it is confirmed, the chain lookup goes through `node.chain.findTransactionBlock(txid)` and the handler overlays authoritative `blockHash`, `blockHeight`, and `confirmations`.

That overlay is intentional. Clients can submit extra confirmation-like fields in a `POST /api/v1/tx` payload, but confirmed responses recompute those fields from chain state, and mempool responses do not include them.

`POST /api/v1/tx` deserializes the request body through `deserializeTransaction`, then calls `node.receiveTransaction(tx)`. A successful mempool admission returns `{ txid }`; a validation or admission failure returns `400` with the error from the mempool or deserializer. This route accepts both regular QBTC spends and BTC claim transactions, but it does not verify them itself; `Node.receiveTransaction` delegates to `Mempool.addTransaction`.

Malformed JSON produces `400` with `Malformed JSON request body`. Bodies over 1 MB produce `413` with `Request body too large`. Non-object JSON bodies reach `deserializeTransaction` because the parser uses `strict: false`, then return transaction-shape errors such as `Transaction must be an object`.

### Mempool Reads

`GET /api/v1/mempool/txs?limit=N` calls `node.mempool.getTransactionsForBlock(node.chain.utxoSet)`, slices the result, and maps each transaction through `summarizeMempoolTransaction`. That means the RPC listing uses the same priority order as block assembly: claim transactions first, then regular transactions by fee density.

`limit` defaults to `1000`, accepts `0`, rejects malformed or negative strings, and caps at `1000`. The summary shape is intentionally smaller than a full transaction:

```text
{
  id,
  timestamp,
  sender,       // derived from first input publicKey for regular txs, null for claims/coinbase
  inputs,       // txId + outputIndex only
  outputs,
  claimData     // present only for claim txs, sanitized
}
```

`GET /api/v1/mempool/stats` currently returns only `{ size }`, sourced from `node.mempool.size()`. It is a count endpoint, not a byte-size or fee histogram endpoint.

### Address, Claims, Difficulty, And Peers

`GET /api/v1/address/:address/balance` validates and lower-cases the address, then returns `{ balance }` from `node.chain.getBalance(address)`.

`GET /api/v1/address/:address/utxos` validates and lower-cases the address, then returns sanitized `UTXO[]` from `node.chain.findUTXOs(address)`. Unknown but well-formed addresses return an empty array, not `404`.

`GET /api/v1/claims/stats` returns `node.chain.getClaimStats()`. The RPC layer does not compute claim totals; it only serializes the chain's current aggregate view. The response includes `btcBlockHeight`, `btcBlockHash`, `genesisHash`, `totalEntries`, `claimed`, `unclaimed`, `claimedAmount`, and `unclaimedAmount`. Browser and CLI claim builders use the snapshot block hash and genesis hash to sign the same replay-protected claim message that consensus verifies.

`GET /api/v1/snapshot/address/:btcAddress` validates the snapshot key as either 40 hex characters for HASH160 entries or 64 hex characters for witness-script, script-hash, or Taproot-style entries. Uppercase hex is accepted and normalized before lookup. A malformed key returns `400`; a well-formed key absent from the snapshot returns `404`. A hit returns:

```json
{
  "btcAddress": "751e76e8199196d454941c45d1b3a323f1433bd6",
  "amount": 5000000000,
  "type": "p2pkh",
  "claimed": false,
  "claimedBy": null
}
```

`claimedBy` is the QBTC destination address recorded from the accepted claim transaction when the entry is already claimed; otherwise it is `null`.

`GET /api/v1/difficulty` returns a compact target history. It always includes genesis at height `0`, includes each `DIFFICULTY_ADJUSTMENT_INTERVAL` boundary, and includes the current tip only when the tip is not already an adjustment boundary. Each entry is `{ height, target, timestamp }`.

`GET /api/v1/peers` returns `[]` when no P2P server is attached. When attached, it returns `p2pServer.getPeers()` filtered to hide addresses containing `127.0.0.1`, `::1`, or `localhost`, so the public API does not advertise local-only peer endpoints.

## Invariants And Edge Cases

### Route And Error Shape

All `/api/v1` misses return JSON `{ error: 'RPC endpoint not found' }`. Non-API misses return JSON `{ error: 'Route not found' }`. A POST to a GET-only API route also falls through to the API-scoped 404, so clients get the same JSON shape.

Route handlers use `sendError(res, status, error)` for expected failures. Unexpected middleware errors are logged through `log.error` and return `500` with `{ error: 'Internal server error' }` unless headers have already been sent.

### Numeric Query Parameters

The query guards intentionally validate strings before `parseInt`. This prevents values like `1abc` or `100abc` from being accepted as `1` or `100`. The accepted grammar is decimal digits only; negative numbers, floats, and alphabetic values are rejected.

The two list endpoints have different caps:

| Endpoint | Query | Default | Maximum | Zero |
|---|---:|---:|---:|---|
| `GET /api/v1/blocks` | `count` | `10` | `100` | returns `[]` |
| `GET /api/v1/mempool/txs` | `limit` | `1000` | `1000` | returns `[]` |

### Confirmation Metadata

Confirmed transaction metadata belongs to the chain, not to clients. `GET /api/v1/tx/:txid` recomputes `blockHash`, `blockHeight`, and `confirmations` from the block found by `findTransactionBlock`. Mempool transactions do not receive those fields, even if the submitted JSON included lookalike properties.

This protects explorer views from showing client-invented confirmation state and keeps the mempool/chain distinction simple: mempool response means unconfirmed; confirmed response means the handler found a block.

### Binary Payloads

Full transactions and blocks contain large post-quantum public keys and signatures as `Uint8Array` values in memory. RPC responses must pass through `sanitize` or a purpose-built mapper before JSON serialization. Otherwise Node would serialize typed arrays as index-keyed objects, which is larger and incompatible with the explorer's expected hex-string shapes.

`POST /api/v1/tx` performs the reverse boundary through `deserializeTransaction`. It accepts the storage/RPC JSON shape, validates it, and reconstructs typed transaction fields before mempool admission.

### P2P Optionality

The RPC server can run without a `P2PServer`. In that mode, `/api/v1/status` still works and reports `peers: 0`, while `/api/v1/peers` returns `[]`. Handlers must keep this optionality because tests and local relay/mining modes instantiate RPC without networking.

### Public Binding

When `bindAddress` is `127.0.0.1`, CORS is permissive for local browser clients. When bound elsewhere, CORS is disabled by setting `origin: false`. Proxy trust and rate-limiting details are documented in [RPC](./RPC.md), but endpoint authors still need to remember that `req.ip` is only meaningful after Express proxy trust has been set.

## Cross-References

- [RPC](./RPC.md) — proxy trust and per-IP rate-limit configuration for `/api/v1/*`.
- [EXPLORER-DATA-FLOW](./EXPLORER-DATA-FLOW.md) — frontend fetch helpers and route rendering for these endpoints.
- [MEMPOOL-LIFECYCLE](./MEMPOOL-LIFECYCLE.md) — why `POST /api/v1/tx` can reject a transaction and why `/api/v1/mempool/txs` is ordered claim-first then by fee density.
- [UTXO-INDEXING](./UTXO-INDEXING.md) — chain indexes behind `/api/v1/address/*` and confirmed `/api/v1/tx/:txid` lookups.
- [TRANSACTION-ANATOMY](./TRANSACTION-ANATOMY.md) — transaction shape, signing fields, txid rules, and validation used after RPC deserialization.
- [CLAIM-FLOW](./CLAIM-FLOW.md) — BTC claim transaction construction and validation behind `POST /api/v1/tx`, `/api/v1/claims/stats`, and `/api/v1/snapshot/address/:btcAddress`.
- [MINING-LIFECYCLE](./MINING-LIFECYCLE.md) — live mining stats exposed by `/api/v1/status` and transaction ordering shared with block assembly.
- [P2P-SYNC](./P2P-SYNC.md) — peer objects filtered by `/api/v1/peers` and block/transaction relay outside the RPC surface.
- [BLOCK-VALIDATION](./BLOCK-VALIDATION.md) — contextual block acceptance rules that make `/api/v1/blocks` and `/api/v1/block/:hash` trustworthy chain views.
