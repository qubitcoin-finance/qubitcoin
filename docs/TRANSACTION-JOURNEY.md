# Transaction Journey

End-to-end walkthrough of one transaction and the block that confirms it, traced chronologically across RPC, `Node`, mempool, miner, and the P2P layer. Read this when you need the *whole* path — from an `HTTP POST /api/v1/tx` on one node to that transaction being mined into a block and validated by a remote peer — rather than any single subsystem in isolation. It is the synthesis view that ties together `RPC-ENDPOINTS.md`, `NODE-ORCHESTRATION.md`, `MEMPOOL-LIFECYCLE.md`, `MINING-LIFECYCLE.md`, and `P2P-SYNC.md`.

This doc does not restate validation rules, fee policy, proof-of-work internals, or peer handshake/IBD; each of those has its own page. What it adds is the *ordering and hand-off* between subsystems: who calls whom, in what sequence, and the announce-then-pull (`inv` → `getdata` → payload) gossip pattern that QubitCoin uses for both transactions and blocks. If you are debugging "my tx reached the mempool but never appeared on the peer", "the miner included a tx but the peer rejected the block", or "relay seems to push full payloads twice", start here.

## Why this view exists

Each subsystem doc answers "how does this part work". None of them answer "what happens, in order, when a user broadcasts a transaction". That ordering is load-bearing: a transaction must be accepted by the mempool *before* it is announced, a block must be accepted by the chain *before* its txids are purged from the mempool, and gossip must announce an inventory hash *before* sending the heavy payload so peers can deduplicate. Getting the sequence wrong causes relay storms, stale mempool entries, or premature broadcasts of rejected data. The single `Node` object is the join point where all five subsystems meet, so the journey is best understood as a sequence of `Node` method calls with subsystem work hanging off each one.

## Key files

| Symbol | Location | Role in the journey |
|---|---:|---|
| `POST /api/v1/tx` handler | `src/rpc.ts:161` | Entry point: deserialize body, call `node.receiveTransaction` |
| `deserializeTransaction` | `src/storage.ts` | Rebuild a `Transaction` from JSON at the serialization boundary |
| `Node.receiveTransaction` | `src/node.ts:42` | Mempool admission + fire `onNewTransaction` on success |
| `Mempool.addTransaction` | `src/mempool.ts:62` | The actual admission decision |
| `Node.onNewTransaction` | `src/node.ts:26` | Broadcast hook, set by the P2P server |
| `P2PServer.broadcastTx` | `src/p2p/server.ts:1102` | Announce tx via `inv` to all handshaked peers |
| `Node.startMining` | `src/node.ts:108` | Continuous async mining loop |
| `assembleCandidateBlock` | `src/miner.ts:28` | Pull mempool txs + coinbase into a candidate |
| `mineBlockAsync` | `src/miner.ts:142` | Non-blocking proof-of-work |
| `Node.onNewBlock` | `src/node.ts:25` | Broadcast hook for accepted blocks |
| `P2PServer.broadcastBlock` | `src/p2p/server.ts:1089` | Announce block via `inv` |
| `P2PServer.handleInv` | `src/p2p/server.ts:807` | Receiver: request unknown hashes via `getdata` |
| `P2PServer.handleGetData` | `src/p2p/server.ts:826` | Sender: reply with full `tx` / `blocks` payload |
| `P2PServer.handleTx` | `src/p2p/server.ts:758` | Receiver: deserialize, admit, re-announce |
| `P2PServer.handleBlocks` | `src/p2p/server.ts:651` | Receiver: validate + `node.receiveBlock` |
| `Node.receiveBlock` | `src/node.ts:89` | Peer block acceptance + mining abort |

## Phase 1 — Submission on the origin node

A client serializes a signed transaction and `POST`s it to `/api/v1/tx`. The handler at `src/rpc.ts:161` runs `deserializeTransaction(req.body)` to cross the JSON→`Transaction` serialization boundary, then calls `node.receiveTransaction(tx)`. On success it responds `{ txid }`; a deserialize failure or a mempool rejection both return a `400` with the error message. The RPC layer does no validation of its own beyond shape — admission policy lives entirely downstream.

`Node.receiveTransaction` (`src/node.ts:42`) forwards the transaction to `Mempool.addTransaction`, passing the current `chain.utxoSet`, `chain.claimedBtcAddresses`, `height + 1`, the optional `chain.btcSnapshot`, and the genesis hash. The mempool makes the real accept/reject decision (fee density, UTXO availability, claim reservation — see `MEMPOOL-LIFECYCLE.md`).

The ordering invariant here is the whole point: only **after** `result.success` does `Node` fire `this.onNewTransaction?.(tx)`. A rejected transaction is never announced to the network. This is what keeps invalid or duplicate transactions from triggering relay traffic.

## Phase 2 — Gossip announce (origin → peers)

`onNewTransaction` is the hook the P2P server installed at startup (`node.onNewTransaction = (tx) => this.broadcastTx(tx)`, `src/p2p/server.ts:117`). `broadcastTx` (`src/p2p/server.ts:1102`) does **not** push the transaction body. It adds the txid to `seenTxs`, then sends every handshaked peer a lightweight `inv` message carrying only `{ type: 'tx', hash: tx.id }`.

This announce-first design means a peer that already has the transaction simply ignores the announcement, and the heavy ML-DSA-65-laden payload is only ever transferred once per peer that actually needs it.

## Phase 3 — Pull and re-admit (peer side)

A peer receives the `inv` and runs `handleInv` (`src/p2p/server.ts:807`). If the hash is unknown (`!seenTxs.has(hash)`), the peer replies with a `getdata` request for that tx. Back on the origin, `handleGetData` (`src/p2p/server.ts:826`) looks the transaction up via `node.mempool.getTransaction(hash)` and, if still present, sends a `tx` payload built with `sanitizeForStorage(tx)`.

The peer's `handleTx` (`src/p2p/server.ts:758`) then mirrors Phase 1: it rate-limits rapid submissions, `deserializeTransaction`s the payload, checks `isValidHash`, short-circuits on `seenTxs`/`rejectedTxs`, and calls `node.receiveTransaction(tx)` — the *same* admission path the origin used. On success the peer adds the txid to `seenTxs` and **re-announces** with an `inv` via `broadcastExcept(peer.id, …)`, so the gossip ripples outward without echoing back to the sender. On failure the txid goes into `rejectedTxs` and the peer accrues misbehavior score.

The transaction now sits in the mempool of every reachable node, each having made its own independent admission decision against its own UTXO set.

## Phase 4 — Mining into a block

On a mining node, `startMining` (`src/node.ts:108`) loops while `this.mining`. Each round creates a fresh `AbortController`, calls `assembleCandidateBlock(chain, mempool, minerAddress, message)` (`src/miner.ts:28`) — which pulls fee-ordered transactions from the mempool and prepends a coinbase via `createCoinbaseTransaction` (`src/miner.ts:56`) — and records `miningStats`. It then runs `mineBlockAsync` (`src/miner.ts:142`), which yields to the event loop between nonce batches so RPC and P2P stay responsive.

When a valid block is found, the sequence is strict: `chain.addBlock(block)` first; only on `result.success` does the node call `mempool.removeTransactions(minedTxIds)` and then `this.onNewBlock?.(block)`. Purging the mempool before acceptance would drop transactions that a validation failure leaves unconfirmed; broadcasting before acceptance would announce a block the node itself rejected. (`Node.mine` at `src/node.ts:58` is the synchronous equivalent used by tests and simulations and follows the same add→purge→broadcast order.)

## Phase 5 — Block gossip and peer acceptance

`onNewBlock` is wired to `broadcastBlock` (`src/p2p/server.ts:1089`), which — like tx relay — sends only an `inv` of `{ type: 'block', hash }`. A peer's `handleInv` requests the block with `getdata`; the sender's `handleGetData` replies with a `blocks` payload built from `chain.blocksByHash.get(hash)` and `sanitizeForStorage`. The peer's `handleBlocks` (`src/p2p/server.ts:651`) validates and calls `node.receiveBlock(block)` (`src/node.ts:89`).

`receiveBlock` runs `chain.addBlock`; on success it purges the included txids from the mempool and then does the mining-specific step that `receiveTransaction` has no analogue for: it nulls `miningStats` and calls `this.miningAbort?.abort()`. That abort breaks the in-flight `mineBlockAsync` round so `startMining`'s loop immediately reassembles a candidate on top of the new tip — preventing the node from wasting work mining a now-stale height.

## Invariants and edge cases

- **Accept-before-announce (tx).** `onNewTransaction` fires only inside the `result.success` branch of `receiveTransaction`. Never relay an unaccepted transaction.
- **Accept-before-purge-before-announce (block).** Every block path runs `addBlock` → `removeTransactions` → `onNewBlock` in that order. Reordering breaks mempool consistency or relays rejected blocks.
- **Announce, then pull.** Both `broadcastTx` and `broadcastBlock` send `inv` hashes, never payloads. Payloads move only in response to `getdata`. If you see full bodies being pushed unsolicited, something bypassed the gossip path.
- **No echo.** `handleTx` re-announces with `broadcastExcept(peer.id, …)` so a transaction never bounces straight back to its sender; deduplication via `seenTxs` stops wider loops.
- **getdata can come up empty.** By the time a `getdata` arrives, the tx may have been mined and removed (`getTransaction` returns undefined) or the block evicted; the sender simply sends nothing, and the requester will re-learn the data through the next relevant `inv` or during sync.
- **Independent admission.** Each node re-runs `receiveTransaction` against its *own* UTXO/claim state. A transaction valid on the origin can be rejected by a peer whose tip differs — that is expected, not a bug.
- **Mining abort is block-only.** Receiving a transaction does not interrupt mining; only `receiveBlock` aborts, because only a new tip invalidates the current candidate.

## Cross-references

- [RPC-ENDPOINTS.md](./RPC-ENDPOINTS.md) — the `/api/v1/tx` POST contract, validation, and response shaping.
- [NODE-ORCHESTRATION.md](./NODE-ORCHESTRATION.md) — the coordinator map for `receiveTransaction`/`receiveBlock`/`startMining` and the broadcast hooks.
- [MEMPOOL-LIFECYCLE.md](./MEMPOOL-LIFECYCLE.md) — what `addTransaction` actually decides and how entries are revalidated.
- [MINING-LIFECYCLE.md](./MINING-LIFECYCLE.md) — `assembleCandidateBlock`, `mineBlockAsync`, abort-on-new-tip internals.
- [P2P-SYNC.md](./P2P-SYNC.md) — handshake, IBD, `inv`/`getdata` protocol, fork resolution, and misbehavior scoring.
- [TRANSACTION-ANATOMY.md](./TRANSACTION-ANATOMY.md) — the structure being serialized, signed, and validated along this path.
- [BLOCK-VALIDATION.md](./BLOCK-VALIDATION.md) — the consensus checks `addBlock` enforces before any purge or relay.
