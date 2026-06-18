# DoS Hardening Map

How QubitCoin bounds untrusted input across RPC, P2P, storage replay, mempool admission, block validation, and snapshot loading. Read this when working on request limits, wire-message validation, transaction or block caps, malformed persisted data, peer abuse scoring, or symptoms such as "Too many requests", "Message size ... exceeds max", "buffer overflow", "Mempool full: transaction fee density too low", "hex string too large", or "Block has too many transactions".

This is a synthesis page. The subsystem docs explain each flow in depth; this page shows how the node defends itself when hostile clients, peers, disk records, or snapshot files try to make validation allocate too much memory, perform too much cryptography, or keep too much state. The implementation uses layered limits rather than one global throttle: cheap shape checks happen at ingress, size and count caps happen before expensive loops, caches prevent repeated work, and misbehaving peers are disconnected before their traffic reaches consensus code.

## Why It Exists

QubitCoin's expensive operations are easy to identify: ML-DSA-65 signatures are large, block merkle trees can be wide, P2P messages can carry serialized blocks or transactions, and persisted JSON can contain arbitrary strings if the data file or network payload is hostile. A public node has to reject malformed data before it becomes a CPU, memory, or disk amplification path.

The code therefore treats every boundary as untrusted:

- HTTP requests arrive through Express and can be large, repeated, or malformed.
- TCP peers can send oversized frames, invalid JSON, too many messages, or slow connections.
- P2P payloads can contain blocks and transactions with untrusted binary-heavy fields.
- Persisted `blocks.jsonl` data is replayed on startup and can be corrupted.
- Mempool entries can reserve UTXOs or BTC claims indefinitely unless bounded.
- Snapshot files come from an external Bitcoin UTXO export and determine fork genesis.

The hardening strategy is not to make one subsystem "secure" and trust the rest. Data is checked again as it crosses boundaries: `deserializeTransaction` caps binary fields before `Node.receiveTransaction`; `validateTransaction` caps input/output counts before signature verification; `validateBlock` caps transaction count and size before merkle and duplicate scans; P2P framing caps raw bytes before JSON decode and structured payload validation.

## Key Files

| Anchor | Role |
|---|---|
| `src/rpc-rate-limit.ts:4` | `GET_RATE_LIMIT = 600`, the default read request cap per IP per minute. |
| `src/rpc-rate-limit.ts:5` | `POST_RATE_LIMIT = 100`, the default write request cap per IP per minute. |
| `src/rpc.ts:15` | `MAX_BODY_SIZE = '1mb'`, the Express JSON body cap. |
| `src/rpc.ts:55` | RPC rate limiter wiring before JSON body parsing and routes. |
| `src/rpc.ts:73` | `express.json({ limit: MAX_BODY_SIZE, strict: false })`. |
| `src/p2p/protocol.ts:8` | `MAX_MESSAGE_SIZE = 5 * 1024 * 1024`, the P2P frame cap. |
| `src/p2p/protocol.ts:149` | `validateDecodedMessage`, the wire-level message shape gate. |
| `src/p2p/protocol.ts:193` | `decodeMessages`, the length-prefixed frame decoder. |
| `src/p2p/peer.ts:19` | Per-peer token bucket capacity (`RATE_LIMIT_MAX = 200`). |
| `src/p2p/peer.ts:20` | Per-peer token refill rate (`RATE_LIMIT_REFILL = 100/sec`). |
| `src/p2p/peer.ts:110` | `Peer.addMisbehavior`, score accumulation and disconnect threshold. |
| `src/p2p/peer.ts:149` | `Peer.handleData`, buffered byte cap, frame decode, and rate checks. |
| `src/p2p/server.ts:47` | Inbound/outbound peer caps and sync/relay cache constants. |
| `src/p2p/server.ts:63` | `MAX_ORPHAN_BLOCKS = 50`, bound for out-of-order block retention. |
| `src/p2p/orphan-pool.ts:31` | `OrphanBlockPool.add`, cheap PoW/hash gate before storage. |
| `src/storage.ts:45` | Binary field maximum hex lengths for deserialization. |
| `src/storage.ts:80` | `validateTransactionShape`, array/type caps before binary decoding. |
| `src/storage.ts:214` | `deserializeBlock`, block transaction cap before per-transaction decode. |
| `src/transaction.ts:74` | `MAX_TX_INPUTS = 1000`, signature-loop cap. |
| `src/transaction.ts:77` | `MAX_TX_OUTPUTS = 1000`, output-loop cap. |
| `src/transaction.ts:256` | `validateTransaction`, transaction-level cheap-to-expensive ordering. |
| `src/block.ts:70` | `MAX_BLOCK_TRANSACTIONS = 10_000`, block-wide transaction count cap. |
| `src/block.ts:310` | `validateBlock`, block-level cheap-to-expensive ordering. |
| `src/mempool.ts:17` | `MAX_MEMPOOL_BYTES = 50 MB`, global pending transaction memory cap. |
| `src/mempool.ts:19` | `MAX_CLAIM_COUNT = 5000`, cap for fee-free BTC claim entries. |
| `src/mempool.ts:61` | `Mempool.addTransaction`, admission limits, duplicate reservations, and eviction. |
| `src/snapshot-loader.ts:13` | `loadSnapshot`, streaming NDJSON snapshot loader. |
| `src/snapshot-loader.ts:56` | Snapshot address and amount shape validation. |

## How It Works

### Boundary Order

The node applies limits in the same direction data flows:

```text
RPC client
  -> per-IP limiter
  -> 1 MB JSON body cap
  -> deserializeTransaction shape + binary caps
  -> Node.receiveTransaction
  -> mempool / consensus validation

P2P peer
  -> socket buffer cap
  -> frame length cap
  -> JSON + message type validation
  -> per-peer token bucket
  -> P2PServer payload handlers
  -> storage deserialization / node validation

disk replay
  -> JSON parse per line
  -> deserializeBlock shape + binary caps
  -> chain replay through normal addBlock validation

snapshot file
  -> line-by-line read
  -> header / entry shape validation
  -> deterministic genesis + claim lookup index
```

This ordering matters. The code tries to reject with O(1) or linear-in-small-input checks before operations that are linear in the attacker-controlled payload size, perform hashing, or verify signatures.

### RPC Boundary

The RPC server installs rate limiting before route handlers and before any endpoint-specific work. `createRateLimiter` keeps a sliding timestamp window per method bucket and IP address; a saturated bucket returns `429` with `Too many requests`. `startRpcServer` creates separate GET and POST limiters so transaction submission can be throttled independently from read-heavy explorer traffic.

JSON bodies are capped at `1mb`. This is especially important for `POST /api/v1/tx`, because a submitted transaction can contain ML-DSA public keys, ML-DSA signatures, BTC claim proof fields, and server-owned metadata fields if a client copied an explorer response. After Express parses the body, the route calls `deserializeTransaction`, which removes server-owned metadata and validates the transaction shape before node admission.

Read endpoints also cap query work. `/api/v1/blocks` validates `count` and clamps it to `100` before slicing from the end of the chain, so a client cannot ask the server to reverse and serialize the entire chain through one request. Hash and address routes reject non-hex identifiers before touching chain indexes.

### P2P Framing And Peer Pressure

P2P uses length-prefixed JSON over TCP. The first defense is the raw frame size: `encodeMessage` refuses to produce frames over `MAX_MESSAGE_SIZE`, and `decodeMessages` rejects inbound frames whose length prefix exceeds the same cap. `Peer.handleData` also tracks accumulated socket bytes and disconnects on `buffer overflow` if the peer keeps sending an incomplete oversized frame.

After a complete frame is available, `validateDecodedMessage` verifies that the message is an object, has a known type, and has the expected high-level payload shape for structured message types such as `blocks`, `tx`, `inv`, `getdata`, `getheaders`, `headers`, and `addr`. This keeps arbitrary JSON values from reaching the server's message handlers as if they were protocol messages.

Each decoded message consumes a per-peer token. A peer starts with a burst allowance of 200 and refills at 100 messages per second. If tokens are exhausted, the peer disconnects with `rate limit exceeded`. This protects the event loop and consensus path even if every individual message is small and well-formed.

### P2P State Caps

The server also caps retained peer and relay state:

- `MAX_INBOUND = 25` and `MAX_OUTBOUND = 25` bound active peer counts.
- `MAX_INBOUND_PER_IP = 3` limits inbound concentration from one address.
- `SEEN_CACHE_MAX = 10_000` bounds seen block and transaction relay caches.
- `MAX_HEADERS_RESPONSE = 500` bounds one headers response.
- `MAX_ADDR_BOOK = 1_000` and `MAX_ADDR_RESPONSE = 100` bound address-discovery state and responses.
- `MAX_OUTBOUND_PER_SUBNET = 2` limits outbound peer concentration by `/16`.
- `MAX_ORPHAN_BLOCKS = 50` and `ORPHAN_EXPIRY_MS = 10 minutes` bound orphan retention.

`OrphanBlockPool.add` applies cheap hash and PoW checks before storing a block whose parent is missing. If the pool is full, it evicts the oldest entry. The pool is keyed by parent hash and rejects duplicate parent slots, so a peer cannot keep unlimited competing orphans for the same missing predecessor.

### Storage And Deserialization

Storage deserialization is a hardening boundary for both disk replay and P2P/RPC payloads. Blocks on disk are not trusted just because the node wrote the file in a previous run; JSON can be corrupted, truncated, or manually edited.

`validateTransactionShape` checks that transaction fields have the right container types, that timestamps are finite numbers, and that input/output arrays do not exceed `MAX_TX_INPUTS` / `MAX_TX_OUTPUTS`. That happens before binary fields are decoded.

Known binary fields then pass through `safeHexToBytes`. The maximum hex lengths are protocol-derived: ML-DSA-65 public keys are capped at 3,904 hex chars, ML-DSA signatures at 6,618, compressed secp256k1 public keys at 66, ECDSA/Schnorr signatures at 128, witness scripts at 10,240, and concatenated witness signatures at 3,840. Oversized strings fail with `Field '<name>' hex string too large` instead of allocating an attacker-controlled buffer.

`deserializeBlock` validates header shape and block transaction count before deserializing every transaction. This duplicates the consensus cap intentionally: the deserializer rejects pathological input before `validateBlock` needs to hash or inspect it.

### Transaction And Block Validation

Transaction validation is ordered to avoid expensive signature loops until cheaper checks pass. `validateTransaction` rejects empty input/output arrays, excessive input/output counts, bad timestamps, invalid output addresses, non-positive or non-integer amounts, dust outputs, maximum-money violations, and duplicate inputs before looking up UTXOs or verifying ML-DSA signatures.

Only after those cheap checks does it derive each input address and call `verifySignature`. That protects the expensive cryptographic path from transactions with obviously invalid structure.

Block validation follows the same pattern. `validateBlock` rejects more than `MAX_BLOCK_TRANSACTIONS` before computing merkle trees or scanning for duplicate transaction IDs. It verifies the block hash, PoW, previous hash, height, timestamp bounds, and estimated block size before merkle-root computation. Duplicate transaction IDs are rejected before coinbase and transaction validation continue, which is also defense-in-depth against duplicate-txid merkle ambiguity.

### Mempool Admission

The mempool is a bounded queue, not a second chain state. `MAX_MEMPOOL_BYTES` caps total estimated transaction bytes at 50 MB. Regular transactions must pass `validateTransaction`, meet `MIN_RELAY_FEE_PER_KB`, avoid double-spending another pending transaction's inputs, and compete by fee density when the pool is full.

BTC claim transactions are intentionally fee-free, so they have a separate state cap. `MAX_CLAIM_COUNT` limits pending claim transactions to 5,000, and `pendingBtcClaims` prevents two pending transactions from reserving the same BTC address. If a snapshot is available, claim proofs are verified before admission. Claims can evict low-fee regular transactions for byte-space, but a pool full of claims is still bounded by count.

The mempool also caches transaction sizes and fee densities. Size is immutable per transaction ID; fee density is cleared when the UTXO set changes. These caches avoid recalculating the same values during sorting, eviction, block assembly, and revalidation.

### Snapshot Loading

`loadSnapshot` streams NDJSON line by line instead of reading the full file into a string. The first line may carry metadata; remaining lines must parse as compact entries with `a` and `b` fields. Addresses must be 40 or 64 lowercase hex characters, and amounts must be non-negative safe integers.

The loader still accumulates valid entries because the running node needs an in-memory claim lookup, but it does not let malformed lines silently enter the consensus input. Header snapshots without a timestamp fail because fork genesis must be deterministic. Legacy/test snapshots get fallback metadata only through explicit compatibility branches documented in the snapshot pipeline.

## Invariants And Edge Cases

- Limits must be enforced before expensive work. If a new route, P2P handler, or deserializer path performs hashing, sorting, signature verification, or whole-chain scans before validating sizes, it weakens the current model.
- Deserialization caps are not a replacement for consensus caps. Storage rejects pathological shapes early; `validateTransaction` and `validateBlock` still enforce consensus rules after typed objects exist.
- RPC rate limiting depends on Express `req.ip`, so `--rpc-trust-proxy` configuration affects which client address is charged. See [RPC](./RPC.md) before changing proxy trust defaults.
- P2P message-size limits protect frame memory, not semantic payload cost by themselves. Handlers still need count limits such as `MAX_HEADERS_RESPONSE`, `IBD_BATCH_SIZE`, and transaction/block caps.
- Peer misbehavior and malformed framing are separate mechanisms. Bad byte streams disconnect immediately because framing state cannot be trusted; higher-level protocol violations can accrue misbehavior points.
- Orphan storage is intentionally shallow. A valid-looking orphan still requires cheap hash and PoW checks, fits inside a bounded pool, and expires if the parent never arrives.
- Mempool byte limits use estimated serialized size from `transactionSize`, not JSON body length. HTTP body limits and mempool limits protect different resources.
- Claim transactions skip normal UTXO validation by design, so their DoS controls are duplicate BTC address reservations, optional snapshot proof verification, and `MAX_CLAIM_COUNT`.
- Snapshot loading is streaming at the I/O boundary but not constant-memory for accepted entries. The final `BtcSnapshot` is intentionally held in memory for O(1) claim lookup through the snapshot index.
- The hardening tests are split by subject under `src/__tests__/hardening-*.test.ts`; keep new abuse cases near the boundary they exercise.

## Cross-References

- [RPC-ENDPOINTS](./RPC-ENDPOINTS.md) for route ordering, request validation, response sanitization, and RPC error behavior.
- [RPC](./RPC.md) for proxy-trust configuration and how client IPs are selected for rate limiting.
- [P2P-SYNC](./P2P-SYNC.md) for handshake, frame validation, peer discovery, banning, IBD, and fork-resolution flow.
- [BLOCK-STORAGE](./BLOCK-STORAGE.md) for persisted block JSON shape validation and binary field deserialization.
- [TRANSACTION-ANATOMY](./TRANSACTION-ANATOMY.md) for transaction count, amount, dust, maturity, and signature-validation rules.
- [BLOCK-VALIDATION](./BLOCK-VALIDATION.md) for cheap-to-expensive block acceptance ordering.
- [MEMPOOL-LIFECYCLE](./MEMPOOL-LIFECYCLE.md) for mempool admission, eviction, claim reservation, and revalidation.
- [SNAPSHOT-PIPELINE](./SNAPSHOT-PIPELINE.md) for snapshot parsing, deterministic fork genesis, and claim lookup indexing.
- [TEST-HARNESS](./TEST-HARNESS.md) for hardening test utilities and loopback TCP test guards.
