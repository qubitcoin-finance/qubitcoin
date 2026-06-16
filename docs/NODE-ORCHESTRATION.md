# Node Orchestration

How the `Node` class coordinates chain state, mempool admission, mining, P2P broadcast hooks, RPC submission, reorg resets, and daemon startup. Read this when working on `src/node.ts`, `src/qbtcd.ts`, or debugging symptoms like accepted transactions not relaying, mined blocks leaving stale mempool entries, peer blocks not aborting mining, `miningStats` going stale, or a reorg that does not revalidate pending transactions.

This page is the coordinator map. It does not restate consensus validation, mempool policy, mining internals, P2P sync, RPC route behavior, or block storage serialization; those each have their own docs. The load-bearing idea here is that `Node` is the narrow join point: RPC and P2P submit transactions into one `receiveTransaction` path, local mining and peer blocks converge on `Blockchain.addBlock`, and P2P installs callbacks so local acceptances can become network announcements.

## Why it exists

QubitCoin has several subsystems that must stay consistent but should not own each other. `Blockchain` owns block acceptance, UTXO mutation, claimed BTC addresses, difficulty, storage replay, and cumulative work. `Mempool` owns unconfirmed transaction policy and conflict tracking. `miner.ts` owns candidate construction and proof-of-work loops. `P2PServer` owns peer connections, inventories, sync, fork resolution, and misbehavior scoring. `rpc.ts` owns HTTP validation and response shaping.

`Node` keeps those boundaries small. It exposes a single object that the daemon can pass to RPC and P2P, while still letting each subsystem do its own job. That avoids duplicate transaction admission logic in RPC and P2P, duplicate block cleanup logic in mining and peer handling, and duplicate reorg cleanup logic in the fork resolver.

The tricky part is not that `Node` has a lot of code; it is short. The tricky part is sequencing. A transaction should only be broadcast after the mempool accepts it. A block should only purge mempool entries after the chain accepts it. A peer block should abort active mining so the next candidate uses the new tip. A reorg should rewind chain state, then revalidate mempool entries against the new UTXO and claimed-address sets.

## Key files

| Symbol | Location | Role |
|---|---:|---|
| `Node` | `src/node.ts:19` | Coordinator object shared by daemon, RPC, P2P, mining, and simulations |
| `Node.constructor` | `src/node.ts:35` | Creates `Blockchain` with optional snapshot/storage and a fresh `Mempool` |
| `Node.receiveTransaction` | `src/node.ts:42` | Single transaction admission path for RPC, P2P, and local simulation |
| `Node.mine` | `src/node.ts:59` | Synchronous local mining path used by demos/simulation |
| `Node.receiveBlock` | `src/node.ts:89` | Single peer/orphan block acceptance path after P2P deserialization |
| `Node.startMining` | `src/node.ts:108` | Continuous async miner loop with abort-driven restart |
| `Node.resetToHeight` | `src/node.ts:145` | Reorg bridge: chain rollback, mempool revalidation, mining abort |
| `Node.stopMining` | `src/node.ts:153` | Daemon shutdown hook for miner cancellation |
| `Node.getState` | `src/node.ts:161` | Aggregated status surface used by RPC |
| `Blockchain.constructor` | `src/chain.ts:60` | Restores persisted blocks or initializes from snapshot/genesis |
| `Mempool.addTransaction` | `src/mempool.ts:62` | Admission policy invoked by `Node.receiveTransaction` |
| `Mempool.revalidate` | `src/mempool.ts:218` | Reorg cleanup invoked by `Node.resetToHeight` |
| `P2PServer.constructor` | `src/p2p/server.ts:99` | Installs `node.onNewBlock` and `node.onNewTransaction` broadcast hooks |
| `P2PServer.handleBlocks` | `src/p2p/server.ts:698` | Feeds validated/deserialized peer blocks into `Node.receiveBlock` |
| `P2PServer.handleTx` | `src/p2p/server.ts:788` | Feeds deserialized peer transactions into `Node.receiveTransaction` |
| `P2PServer.initiateForkResolution` path | `src/p2p/server.ts:1063` | Calls `Node.resetToHeight` before downloading the winning branch |
| `startRpcServer` | `src/rpc.ts:43` | Receives the shared `Node` instance for HTTP routes |
| `POST /api/v1/tx` | `src/rpc.ts:161` | HTTP transaction submission path into `Node.receiveTransaction` |
| `qbtcd main` | `src/qbtcd.ts:162` | Daemon startup sequence |
| `new Node('node', snapshot, storage)` | `src/qbtcd.ts:222` | Runtime node creation after snapshot/storage setup |
| `new P2PServer(node, ...)` | `src/qbtcd.ts:226` | Network layer construction around the same `Node` |
| `node.startMining` | `src/qbtcd.ts:303` | Mining starts only after optional seed sync succeeds |

## How it works

### Startup wiring

`qbtcd` builds the runtime graph in one direction: parse config, optionally download/load the BTC snapshot, create `FileBlockStorage`, create `Node`, wrap it with `P2PServer`, then expose it through RPC.

```text
qbtcd main
  parseArgs()
  optional snapshot download/load
  FileBlockStorage(dataDir)
  Node('node', snapshot, storage)
    Blockchain(snapshot, storage)
    Mempool()
  P2PServer(node, p2pPort, dataDir)
    node.onNewBlock = broadcastBlock
    node.onNewTransaction = broadcastTx
  startRpcServer(node, rpcPort, p2p, ...)
  optional node.startMining(...)
```

The ordering matters. `Blockchain.constructor` restores persisted blocks from storage before RPC/P2P/mining start, so all external surfaces see the replayed chain rather than an empty in-memory chain. P2P is created before RPC listens, which means any transaction accepted through RPC after startup already has broadcast hooks installed.

When mining is enabled and seeds are configured, `qbtcd` waits for P2P sync before calling `node.startMining`. That startup guard lives in the daemon, not in `Node`, because it depends on seed configuration and `P2PServer.waitForSync`.

### Transaction ingress

All normal transaction ingress converges on `Node.receiveTransaction`.

RPC deserializes the JSON body in `POST /api/v1/tx`, then calls `node.receiveTransaction`. P2P deserializes a `tx` message in `P2PServer.handleTx`, checks local seen/rejected caches, then calls the same method. Simulation code also uses this method when generating local traffic.

`Node.receiveTransaction` passes the transaction plus live chain context into `Mempool.addTransaction`:

- `chain.utxoSet` for spend validation and fee calculation.
- `chain.claimedBtcAddresses` for claim duplicate prevention.
- `chain.getHeight() + 1` for maturity-sensitive checks.
- `chain.btcSnapshot` for claim proof validation.
- `chain.blocks[0]?.hash` for claim message binding to genesis.

Only after `Mempool.addTransaction` returns success does `Node` log acceptance and call `onNewTransaction`. In production, `P2PServer.constructor` installs that callback as `broadcastTx`, so a local acceptance becomes a network announcement. Failed transactions do not broadcast; the caller decides how to surface the rejection.

### Block ingress and local mining

There are three block-producing paths, but they all must leave chain and mempool state aligned.

The synchronous `Node.mine` path builds a candidate with `assembleCandidateBlock`, runs `mineBlock`, calls `chain.addBlock`, removes included transaction IDs from the mempool, then calls `onNewBlock`. It throws if its own freshly mined block fails `chain.addBlock`, because that indicates a local programmer or state error rather than a normal peer rejection.

The continuous `Node.startMining` path uses `mineBlockAsync` in a loop. Each round creates a fresh `AbortController`, records `miningStats` for RPC status, mines a candidate, clears `miningStats`, and, if a block was found, applies the same accept/remove/broadcast sequence. If the round was aborted, the loop simply starts another candidate from the current tip.

The peer path is `Node.receiveBlock`. P2P has already decoded and bounded the message before calling it, but `Node` still treats the block as untrusted and delegates acceptance to `chain.addBlock`. If the chain accepts the block, `Node` removes included mempool transactions, clears `miningStats`, and aborts the active mining controller. It does not broadcast in this method; P2P decides how to relay peer-originated blocks and inventories.

### Broadcast hooks

`Node` has no direct import of `P2PServer`. Instead it exposes two nullable callbacks:

- `onNewBlock`
- `onNewTransaction`

`P2PServer.constructor` assigns those callbacks to `broadcastBlock` and `broadcastTx`. This keeps dependency direction simple: P2P depends on `Node`, but `Node` does not depend on P2P. Tests, simulations, or local-only runs can leave the callbacks unset; the optional calls are no-ops.

The hook placement encodes an invariant: callbacks represent local acceptance, not raw receipt. They sit after mempool admission for transactions and after chain acceptance for locally mined blocks. Peer-originated blocks follow P2P-specific relay rules, so `receiveBlock` intentionally does not call `onNewBlock`.

### Reorg handoff

P2P decides whether a fork is worth reorganizing to, but `Node.resetToHeight` is the bridge that makes the local runtime consistent after the decision.

When fork resolution picks a fork point, `P2PServer` calls `node.resetToHeight(forkPoint)`. `Node` then calls `chain.resetToHeight`, revalidates the mempool against the rewound UTXO set and claimed BTC address set, clears `miningStats`, and aborts active mining.

The order is important. Revalidating before chain rollback would evaluate pending transactions against the wrong tip. Continuing an active mining round after rollback would keep hashing a candidate whose `previousHash` may no longer be the current chain tip.

### Status aggregation

`Node.getState` is a status assembler, not a consensus API. It reads chain height, mempool size, UTXO count, current difficulty, last block timestamp, target block time, subsidy for the next height, total transaction count, cumulative work, and live `miningStats`.

RPC uses this shape for `/api/v1/status`. Some values are display-oriented: difficulty is truncated for the status response, and estimated hashrate is derived from recent block spacing and target rather than from live mining progress. Live miner telemetry is exposed separately through `miningStats` when mining is active.

## Invariants and edge cases

### Acceptance before broadcast

`onNewTransaction` is called only after `Mempool.addTransaction` succeeds. `onNewBlock` in local mining paths is called only after `Blockchain.addBlock` succeeds. Moving either hook earlier would let invalid or locally rejected objects propagate to peers.

### Chain state is the mempool's context

`Node` does not ask `Mempool` to remember chain state. Every admission or revalidation call passes the current `utxoSet`, `claimedBtcAddresses`, height, snapshot, or genesis hash it needs. This is why `resetToHeight` can make the mempool coherent again after a reorg without recreating the `Mempool` object.

### Peer blocks abort mining but do not relay through `Node`

`receiveBlock` aborts mining when a peer block is accepted, because any in-flight candidate points at the old tip. It does not invoke `onNewBlock`; peer relay is handled in `P2PServer` with seen caches, inventories, orphan handling, and fork-resolution state.

### Local mining has two modes

`mine` is synchronous and is used by demos/simulation-style code. `startMining` is the long-running daemon path and uses `mineBlockAsync` so RPC and P2P remain responsive. Both paths must keep the same post-acceptance cleanup sequence: add block, remove mined transactions, then announce if appropriate.

### Reorg reset must invalidate pending assumptions

`Node.resetToHeight` revalidates mempool entries after `chain.resetToHeight`. Regular transactions can lose inputs or maturity, claim transactions can conflict with newly claimed BTC addresses, and fee-density caches can become stale. `Mempool.revalidate` owns that cleanup, but `Node` owns calling it at the right time.

### Shutdown cancels mining before network teardown

`qbtcd` shutdown calls `node.stopMining`, then `p2p.stop`, then closes the RPC server. This prevents the miner loop from continuing to mutate chain/mempool state while the process is tearing down network surfaces.

## Cross-references

- [BLOCK-VALIDATION](./BLOCK-VALIDATION.md) for `Blockchain.addBlock`, contextual checks, and difficulty validation.
- [MEMPOOL-LIFECYCLE](./MEMPOOL-LIFECYCLE.md) for `Mempool.addTransaction`, eviction, claim reservations, and `revalidate`.
- [MINING-LIFECYCLE](./MINING-LIFECYCLE.md) for `assembleCandidateBlock`, `mineBlockAsync`, abort-on-new-tip behavior, and mining stats.
- [P2P-SYNC](./P2P-SYNC.md) for handshake, block download, fork resolution, orphan handling, and peer relay.
- [RPC-ENDPOINTS](./RPC-ENDPOINTS.md) for HTTP route validation and the `/api/v1/status` and `/api/v1/tx` surfaces.
- [BLOCK-STORAGE](./BLOCK-STORAGE.md) for storage-backed chain replay before `Node` is exposed to RPC/P2P.
- [REORG-UNDO](./REORG-UNDO.md) for the `Blockchain.resetToHeight` internals that `Node.resetToHeight` invokes.
- [SNAPSHOT-PIPELINE](./SNAPSHOT-PIPELINE.md) for snapshot loading and genesis construction before `new Node(...)`.
