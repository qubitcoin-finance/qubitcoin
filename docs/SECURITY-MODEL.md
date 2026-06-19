# Security Model

How QubitCoin draws trust boundaries across consensus, BTC claims, P2P, RPC, snapshots, storage, and local operator files. Read this when auditing security controls, checking whether a threat is handled by consensus or by policy, or debugging symptoms such as "Too many requests", "misbehavior score", "BTC address already claimed", "Snapshot missing btcTimestamp", "Block hash does not meet difficulty target", or "Invalid signature at input".

This is a synthesis page. The subsystem docs explain the mechanics; this page explains what the implementation treats as trusted, what it treats as adversarial, and which residual risks are accepted by the current code. It is not a formal third-party audit. It maps the current code paths so maintainers can evaluate changes without assuming that one boundary protects all others.

## Why It Exists

QubitCoin has several independent security boundaries because its inputs arrive from different trust domains:

- Blocks and transactions arrive from peers, miners, disk replay, and RPC clients.
- BTC claim proofs bind old secp256k1 ownership to new ML-DSA-65 outputs.
- The P2P layer accepts raw TCP bytes from unauthenticated peers.
- The RPC layer accepts browser and CLI JSON requests through Express and, in production, nginx.
- The snapshot is an external Bitcoin UTXO export that becomes part of fork identity.
- Local data files such as `blocks.jsonl`, `metadata.json`, `wallet.json`, `anchors.json`, and `banned.json` can be missing or corrupt.

The implementation does not rely on one global sanitizer. Each boundary performs the checks it can do cheaply, then delegates deeper validation to the subsystem that owns the relevant state. P2P frame checks happen before JSON payloads reach `P2PServer`; RPC request limits happen before deserialization; transaction validation happens before mempool insertion; block validation happens before UTXO mutation; claim proof validation happens next to snapshot and genesis data.

That layering matters because QubitCoin deliberately combines two cryptographic eras. Native QBTC spends use ML-DSA-65 signatures. BTC claims use ECDSA or Schnorr only to prove ownership of a pre-fork Bitcoin address, after which value moves into native quantum-safe outputs. A security review must therefore distinguish "legacy proof for migration" from "native signing for ongoing consensus".

## Key Files

| Anchor | Role |
| --- | --- |
| `src/block.ts:67` | `MAX_BLOCK_SIZE`, the 1 MB block-size consensus cap. |
| `src/block.ts:70` | `MAX_BLOCK_TRANSACTIONS`, an O(1) cap before merkle and signature work. |
| `src/block.ts:73` | `MAX_FUTURE_BLOCK_TIME_MS`, the two-hour future-time bound. |
| `src/block.ts:310` | `validateBlock`, the structural consensus validation entrypoint. |
| `src/transaction.ts:62` | `COINBASE_MATURITY`, the 100-block coinbase spend delay. |
| `src/transaction.ts:65` | `CLAIM_MATURITY`, the 10-block claim-output spend delay. |
| `src/transaction.ts:71` | `MAX_MONEY`, the 21M QBTC satoshi cap. |
| `src/transaction.ts:74` | `MAX_TX_INPUTS`, the transaction input-count DoS cap. |
| `src/transaction.ts:77` | `MAX_TX_OUTPUTS`, the transaction output-count DoS cap. |
| `src/transaction.ts:256` | `validateTransaction`, native spend validation. |
| `src/chain.ts:122` | `replaceGenesis`, fresh-node peer genesis replacement guarded by hash and PoW. |
| `src/chain.ts:141` | `addBlock`, contextual block acceptance and claim proof gate. |
| `src/mempool.ts:16` | `MAX_MEMPOOL_BYTES`, the 50 MB mempool cap. |
| `src/mempool.ts:19` | `MAX_CLAIM_COUNT`, the pending claim-count cap. |
| `src/mempool.ts:61` | `addTransaction`, mempool admission policy. |
| `src/p2p/protocol.ts:8` | `MAX_MESSAGE_SIZE`, the 5 MB P2P message cap. |
| `src/p2p/protocol.ts:149` | `validateDecodedMessage`, structured wire-message validation. |
| `src/p2p/peer.ts:110` | `addMisbehavior`, the score-and-disconnect threshold. |
| `src/p2p/server.ts:47` | P2P peer count, cache, reorg, address-book, and discovery limits. |
| `src/p2p/server.ts:99` | `P2PServer` constructor, including ban and anchor persistence. |
| `src/rpc.ts:43` | `startRpcServer`, the public HTTP API factory. |
| `src/rpc.ts:68` | RPC CORS policy based on bind address. |
| `src/rpc.ts:69` | Per-method RPC rate-limit middleware. |
| `src/qbtcd.ts:104` | `downloadFile`, redirect-limited snapshot downloader. |
| `src/qbtcd.ts:197` | Runtime snapshot load and fork-genesis integrity check. |
| `src/snapshot-loader.ts:13` | `loadSnapshot`, streaming snapshot parser. |
| `src/snapshot-loader.ts:56` | Snapshot address and amount validation. |

## Threat Domains

### Consensus Inputs

Blocks are untrusted whether they come from mining, P2P, or storage replay. `validateBlock` recomputes the block hash, checks proof of work, verifies previous-hash and height continuity, enforces timestamp bounds, caps size and transaction count, recomputes the merkle root, rejects duplicate transaction IDs, and validates transaction-level rules before a block mutates the UTXO set.

`Blockchain.addBlock` owns contextual checks that cannot live in pure block validation. It verifies that the block target equals the node's expected difficulty, checks BTC claim proofs against the loaded snapshot, rejects already claimed BTC addresses, records undo data, updates cumulative work, and only then persists the block.

Native transactions are address-based rather than script-based. `validateTransaction` checks input/output counts, output address and amount shape, dust, `MAX_MONEY`, duplicate inputs, UTXO existence, coinbase maturity, claim maturity, public-key/address match, and ML-DSA-65 signatures.

### BTC Claim Inputs

BTC claims are not ordinary UTXO spends. A claim transaction uses the sentinel `CLAIM_TXID` input shape and carries `claimData` proving control of a snapshotted Bitcoin address. The mempool verifies claim proofs before admission when a snapshot is available, and chain acceptance verifies them again in `addBlock`.

The claim message binds the BTC address, destination QBTC address, Bitcoin snapshot block hash, and QBTC genesis hash. This prevents a signature for one fork or destination from being replayed into a different fork or recipient. The resulting output is marked as a claim output and cannot be spent until `CLAIM_MATURITY` blocks have accumulated.

Double-claim prevention has two layers. `Mempool` tracks `pendingBtcClaims` so two unconfirmed claim transactions for the same BTC address cannot coexist locally. `Blockchain` tracks `claimedBtcAddresses` so a BTC address cannot be claimed twice on-chain, and undo data reverses that set during reorgs.

### P2P Inputs

The P2P transport is length-prefixed JSON over TCP. `decodeMessages` rejects zero-length frames, frames larger than `MAX_MESSAGE_SIZE`, unknown message types, and structurally malformed payloads before the server handlers run. `Peer` also tracks buffered bytes, disconnects on overflow, applies a token bucket to decoded messages, and times out idle or half-handshaken sockets.

`P2PServer` owns peer limits, address discovery, fork resolution, seen-object caches, orphan blocks, and ban persistence. It caps inbound and outbound peers, limits inbound peers per IP, caps address book size and `addr` responses, bounds orphan storage, and keeps rejected block/transaction caches to avoid repeated expensive validation.

Misbehavior is a scoring system, not a boolean. Invalid data, impossible fork claims, oversized payloads, rapid sync requests, and rejected transactions add score. A peer that reaches the threshold is rejected, disconnected, and can be persisted to `banned.json`.

### RPC Inputs

RPC is a JSON boundary around the node. `startRpcServer` disables `x-powered-by`, sets Express proxy trust before rate limiting, installs separate GET and POST rate buckets, applies CORS based on the bind address, and limits JSON bodies to 1 MB.

Endpoint handlers validate route parameters before touching node state. Hashes and addresses must be 64-character hex strings, height/count/limit query values must be decimal whole numbers, list sizes are capped, and submitted transactions go through `deserializeTransaction` before `Node.receiveTransaction`.

Responses use `sanitize` or narrow response mappers so binary fields and internal shapes do not leak directly into JSON. Confirmed transaction metadata such as block hash, height, and confirmations is computed server-side from the chain index, not trusted from submitted transaction payloads.

### Snapshot Inputs

The snapshot is a consensus input because its metadata and merkle root determine fork genesis. Runtime loading goes through `loadSnapshot`, which streams NDJSON line by line, parses a header when present, validates entry addresses and amounts, normalizes known snapshot types, and rejects header snapshots without deterministic timestamp metadata.

The default `--full` downloader writes to a temporary file before rename, caps redirects, rejects non-HTTPS redirects after the first request, and has a request timeout. After loading a full snapshot, `qbtcd` constructs the fork genesis as an integrity check so a corrupt or MITM-altered file changes fork identity instead of being silently equivalent.

The loader does not make the snapshot "trusted" for all time. Claim validation still checks that a submitted proof matches the loaded entry, mempool policy still limits pending claims, and block acceptance still enforces one claim per BTC address.

### Local Files

Local files are trusted only as operator-owned state, not as always-valid input. Block storage deserializes persisted blocks through bounded shape checks. Snapshot loading validates JSON and metadata. P2P anchors and ban lists tolerate missing or malformed files by starting fresh. Wallet loading in `qbtcd` is wrapped so a corrupt wallet file does not crash daemon startup.

This means local disk corruption may cause a node to skip data, rebuild state, generate a new wallet, or reconnect differently, but it should not bypass consensus validation. The strongest invariant is that persisted blocks are replayed through the same `Blockchain` mutation paths that live blocks use.

## How It Works

The security path is a set of staged gates:

```text
TCP bytes
  -> Peer buffer cap + frame decode
  -> protocol payload validation
  -> P2PServer handler limits and misbehavior scoring
  -> deserializeBlock / deserializeTransaction
  -> Node.receiveBlock / Node.receiveTransaction
  -> Blockchain.addBlock / Mempool.addTransaction
  -> validateBlock / validateTransaction / verifyClaimProof
  -> UTXO, claim, index, storage mutation

HTTP JSON
  -> Express body limit + method rate bucket
  -> route parameter validation
  -> deserializeTransaction or chain read
  -> Node / Blockchain / Mempool owner method
  -> sanitized response
```

The important property is ownership of state. RPC never marks a BTC address as claimed; it delegates to `Node.receiveTransaction`, mempool admission, and later chain acceptance. P2P never rewrites UTXOs directly; it deserializes and asks `Node.receiveBlock`. Snapshot loading never spends value; it creates immutable lookup data that claim verification consumes.

The reverse is also true: consensus code does not know about HTTP rate limits or peer subnets. A transaction that passed RPC validation can still fail mempool admission. A block that passed P2P framing can still fail PoW, merkle, target, timestamp, transaction, or claim checks.

## Invariants And Edge Cases

### Consensus Invariants

- A block must match its own header hash and satisfy its target before deeper block checks matter.
- A non-genesis block must extend the current tip when accepted by `addBlock`.
- The block target must equal the chain's expected difficulty at the time of acceptance.
- Transaction IDs inside one block must be unique.
- Native spends must reference confirmed UTXOs; unconfirmed transaction chains are not supported.
- Coinbase and claim outputs are spendable only after their maturity windows.
- Output amounts must be positive integers, above dust, and within `MAX_MONEY`.

### Claim Invariants

- A BTC address can be absent, pending in mempool, claimed on-chain, or claimable; it cannot be both pending and claimed.
- Claim proof signatures are legacy BTC ownership proofs only. They do not authorize future QBTC spends.
- The same claim must bind to the snapshot block hash and QBTC genesis hash or it is fork-replay unsafe and rejected.
- Reorg undo must reverse `claimedBtcAddresses`, `claimedCount`, and `claimedAmount` so the winning chain owns claim state.

### Network Invariants

- P2P messages are unauthenticated and plaintext. Every peer payload remains adversarial until decoded, shape-checked, deserialized, and accepted by node state.
- Misbehavior score decays over time. This avoids permanently penalizing transient failures, but it means slow, low-rate abuse can stay below the ban threshold.
- Outbound discovery enforces subnet diversity; inbound slots are protected by per-IP and total limits, not by a full Sybil-proof identity system.
- Orphan blocks are cached only after hash and PoW checks, and the pool is bounded and expiring.

### RPC Invariants

- `req.ip` depends on `app.set('trust proxy', ...)`; deployment must choose proxy trust deliberately or rate limits can bucket the wrong client.
- Localhost-bound RPC allows browser origins for local tooling. Externally bound RPC disables CORS in the app; a reverse proxy may add its own policy.
- RPC parameter validation protects handler shape, but consensus decisions still belong to chain and mempool code.

### Snapshot Invariants

- Header snapshots need deterministic timestamp metadata or fork genesis is not stable.
- Snapshot entries must use lowercase 40- or 64-character hex addresses and safe integer amounts.
- The in-memory snapshot index assumes loaded entries are immutable after indexing.
- Snapshot downloads are transport-checked and genesis-checked, but the expected snapshot identity still ultimately comes from the snapshot file used by the node.

## Residual Risks

### Plaintext P2P

The P2P protocol does not provide encryption or peer authentication. A network-level attacker can observe inventory, blocks, transactions, and timing, and can delay or drop traffic. Consensus validation protects state correctness, not traffic confidentiality or liveness under a hostile network path.

### Eclipse And Sybil Pressure

Per-IP limits, outbound `/16` diversity, anchors, seeds, bans, and misbehavior scoring reduce eclipse risk. They do not make peer selection Sybil-proof. An attacker with many routable IPs across subnets can still compete for peer slots, especially inbound slots.

### Public RPC Exposure

RPC is built to be rate-limited and parameter-validated, but it is not an authenticated wallet API. Exposing write endpoints publicly means anyone can submit transactions and consume the configured POST budget. Production keeps node RPC bound to loopback and exposes website API access through nginx.

### Snapshot Source Trust

`--full` fetches the default snapshot over HTTPS and validates that it can create fork genesis. That catches corruption and redirect downgrade attempts, but it does not independently prove that the file represents the intended Bitcoin block unless operators also verify snapshot provenance and published metadata.

### No Formal Audit Boundary

The implementation has extensive tests and layered validation, but the repo does not record a completed third-party security audit. Treat security-sensitive changes as requiring subsystem tests plus an explicit review of the boundary they touch.

## Cross-References

- [DOS-HARDENING](./DOS-HARDENING.md) for resource-exhaustion controls across RPC, P2P, storage, mempool, block validation, and snapshots.
- [BLOCK-VALIDATION](./BLOCK-VALIDATION.md) for cheap-to-expensive block acceptance order.
- [TRANSACTION-ANATOMY](./TRANSACTION-ANATOMY.md) for native transaction signing, hashing, maturity, dust, and fee rules.
- [CLAIM-FLOW](./CLAIM-FLOW.md) for BTC ownership proofs and one-shot claim semantics.
- [P2P-SYNC](./P2P-SYNC.md) for handshake, peer discovery, IBD, fork resolution, anchors, bans, and relay behavior.
- [RPC-ENDPOINTS](./RPC-ENDPOINTS.md) for route-level validation, response shaping, and API error behavior.
- [RPC](./RPC.md) for proxy trust and rate-limit client-IP handling.
- [SNAPSHOT-PIPELINE](./SNAPSHOT-PIPELINE.md) for snapshot loading, merkle commitment, deterministic genesis, and claim lookup.
- [BLOCK-STORAGE](./BLOCK-STORAGE.md) for persisted block deserialization and replay.
- [REORG-UNDO](./REORG-UNDO.md) for reversing UTXO and claim state across forks.
