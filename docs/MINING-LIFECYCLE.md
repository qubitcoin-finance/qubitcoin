# Mining Lifecycle

How QubitCoin mines blocks: candidate assembly from mempool, the non-blocking proof-of-work loop, automatic restart on a new chain tip, difficulty retargeting, and the coinbase subsidy schedule. Read this when working on `miner.ts`, the `startMining`/`stopMining` loop in `node.ts`, hashrate/`miningStats` reporting, difficulty adjustment in `chain.ts`, or any change that touches block production timing or responsiveness.

The mining path has two driving concerns the code is shaped around: PoW must not block the event loop (RPC and P2P stay responsive while a node mines), and an in-flight mining round must abandon itself the instant a competing block arrives so the miner never wastes work on a stale tip. The key symbols are `assembleCandidateBlock`, `mineBlockAsync`, `Node.startMining`, `Node.receiveBlock`, `Blockchain.adjustDifficulty`, and `blockSubsidy`.

## Why it exists

A naive miner runs a tight `while` loop incrementing a nonce until the block hash clears the target. That works for a one-shot CLI demo (`mineBlock`, used by `Node.mine`), but a long-running node also serves RPC requests and gossips with P2P peers on the same single Node.js thread. A synchronous PoW loop would starve both: the event loop never gets a turn, so `/api/v1/status` hangs and peer messages queue up until a block is found minutes later.

`mineBlockAsync` solves this by hashing in **batches** and yielding to the event loop (`setTimeout(batch, 0)`) between them. It also takes an `AbortSignal`, so the loop in `Node.startMining` can be torn down mid-round when `Node.receiveBlock` learns a peer already mined the next block — there is no point grinding nonces against a `previousHash` that is now one block behind the tip.

## Key files

| Symbol | Location | Role |
|---|---|---|
| `assembleCandidateBlock` | `src/miner.ts:28` | Build an unmined candidate from chain tip + mempool |
| `mineBlock` | `src/miner.ts:87` | Synchronous PoW loop (CLI/demo only) |
| `mineBlockAsync` | `src/miner.ts:142` | Non-blocking batched PoW with abort + progress |
| `MiningProgress` | `src/miner.ts:136` | `{ nonce, elapsed, hashrate }` progress shape |
| `Node.mine` | `src/node.ts:59` | One-shot synchronous mine + add + broadcast |
| `Node.startMining` | `src/node.ts:108` | Continuous async mining loop |
| `Node.receiveBlock` | `src/node.ts:89` | Aborts current round on a peer block |
| `Node.stopMining` | `src/node.ts:153` | Clears `mining`, aborts, drops stats |
| `Blockchain.adjustDifficulty` | `src/chain.ts:279` | Retarget every interval, clamped 4× |
| `computeBlockHash` / `hashMeetsTarget` | `src/block.ts:149` / `:154` | Double-SHA256 header hash, `hash < target` test |
| `blockSubsidy` | `src/transaction.ts:91` | Halving subsidy schedule |

## How it works

### Candidate assembly

`assembleCandidateBlock` (`src/miner.ts:28`) reads the current tip and computes the next `height` as `chain.getHeight() + 1`. It pulls pending transactions via `mempool.getTransactionsForBlock(chain.utxoSet)` and greedily packs them under `MAX_BLOCK_SIZE` (1 MB), reserving a fixed `HEADER_SIZE` of 112 bytes plus an 80-byte coinbase estimate. Each included transaction's fee (`calculateFee`) accumulates into `totalFees`.

The coinbase comes from `createCoinbaseTransaction(minerAddress, height, totalFees, message)`, placed first in the transaction list, and the Merkle root is `computeMerkleRoot` over all transaction IDs. The candidate timestamp is `Math.max(Date.now(), mtp + 1)` where `mtp` is the median-time-past of the prior 11 blocks (`medianTimestamp`) — this guarantees the block's timestamp strictly exceeds the MTP, a consensus rule the validator enforces.

The returned `Block` has `hash: ''` and `header.nonce: 0`; the hash is filled in only once mining succeeds.

### The batched PoW loop

`mineBlockAsync` (`src/miner.ts:142`) returns a `Promise<Block | null>`. Inside, `batch()` hashes up to `batchSize` nonces, calling `computeBlockHash(block.header)` and testing `hashMeetsTarget(hash, target)` (i.e. `BigInt(hash) < BigInt(target)`). On success it sets `block.hash`, logs, and resolves the block. Otherwise it schedules the next batch with `setTimeout(batch, 0)`, returning control to the event loop.

```text
startMining loop
  ├─ assembleCandidateBlock ─► candidate (nonce=0, hash='')
  ├─ new AbortController
  └─ mineBlockAsync(candidate, signal, onProgress)
        repeat:
          batch of N nonces ─ hashMeetsTarget?
            ├─ yes ─► resolve(block)
            ├─ signal.aborted ─► resolve(null)
            └─ no  ─► setTimeout(batch, 0)   # yield
        ▼
   block ? addBlock + removeTxs + onNewBlock : (restart with new tip)
```

### Adaptive batch sizing

Batch size auto-tunes toward `TARGET_BATCH_MS = 25` ms per batch using exponential smoothing (`ALPHA = 0.3`), clamped to `[MIN_BATCH_SIZE=256, MAX_BATCH_SIZE=100_000]`. It starts deliberately small (`batchSize = 2_048`) so abort timers stay responsive on slow hosts before the smoother converges. Within a batch the abort flag is also polled every `ABORT_CHECK_INTERVAL = 256` nonces, so a busy batch on a fast machine still bails promptly.

After each batch, if an `onProgress` callback was supplied, it fires once with `{ nonce, elapsed (whole seconds), hashrate (nonce/elapsedSec) }`. Reporting is gated on batch completion, not on finding a block, so a UI sees a steady hashrate even when blocks are minutes apart. A coarser `log.debug` fires roughly every 500k nonces.

### Nonce overflow

A 32-bit nonce wraps at `0xffffffff`. Both `mineBlock` and `mineBlockAsync` handle exhaustion the same way: reset `nonce = 0` and increment `block.header.timestamp += 1`, which changes the serialized header and reopens the full nonce space — the standard Bitcoin trick for searching beyond 2³² hashes per timestamp.

### The continuous loop and tip restart

`Node.startMining` (`src/node.ts:108`) sets `this.mining = true` and loops while it stays true. Each iteration: create a fresh `AbortController`, assemble a candidate, record `targetHeight` and `miningStats`, then `await mineBlockAsync`. The `onProgress` callback writes `this.miningStats = { ...progress, blockHeight: targetHeight, startedAt }`, which `Node.getState` surfaces (and RPC `/api/v1/status` exposes) for live hashrate display.

When `mineBlockAsync` resolves a real block, the node calls `chain.addBlock`; on success it strips the mined txids from the mempool and broadcasts via `onNewBlock`. When it resolves `null` (aborted), the loop simply re-runs `assembleCandidateBlock` against the now-updated tip.

Three sites abort the current round:

- `Node.receiveBlock` (`src/node.ts:89`) — a peer's block was accepted; null the stats and `miningAbort?.abort()` so the next iteration mines on the new tip.
- `Node.resetToHeight` (`src/node.ts:145`) — a reorg/rollback; revalidate the mempool then abort.
- `Node.stopMining` (`src/node.ts:153`) — set `mining = false`, abort, and drop the `AbortController` and stats.

### Difficulty retargeting

The candidate's `header.target` is `chain.getDifficulty()`, which returns the current `Blockchain.difficulty` (seeded from `STARTING_DIFFICULTY`). Every `DIFFICULTY_ADJUSTMENT_INTERVAL = 10` blocks, `addBlock` calls `adjustDifficulty` (`src/chain.ts:270`). It measures `actualTime` across the interval and compares to `expectedTime = (INTERVAL - 1) * TARGET_BLOCK_TIME_MS` — note the `INTERVAL - 1`, because N blocks span only N−1 inter-block gaps. The ratio is clamped to `[0.25, 4.0]` (Bitcoin's 4× limit), the target scales by `ratio` (fixed-point via `* 10000 / 10000n`), and is clamped so it never exceeds `STARTING_DIFFICULTY` (the easiest allowed target) nor drops below `1`. A larger target means an easier block.

### Coinbase subsidy

`createCoinbaseTransaction` pays the miner `blockSubsidy(height) + totalFees`. `blockSubsidy` (`src/transaction.ts:91`) starts at `INITIAL_SUBSIDY = 312_500_000` sat (3.125 QBTC, matching BTC's post-4th-halving subsidy) and halves every `HALVING_INTERVAL = 210_000` blocks, returning `0` once `halvings >= 26`. The coinbase output is spendable only after `COINBASE_MATURITY = 100` blocks.

## Invariants and edge cases

- **Single in-flight round.** `startMining` holds exactly one `AbortController` at a time in `this.miningAbort`. Calling `startMining` while already mining would spawn a second loop — callers must `stopMining` first. The `finished` guard inside `mineBlockAsync` ensures `resolve` runs at most once even if abort and a found block race.
- **Abort resolves `null`, never rejects.** Distinguish "no block this round" from "block found" by the truthiness of the resolved value, not by catching.
- **Stale candidate after abort.** A null result means the candidate's `previousHash` is now stale; never re-submit it — always re-assemble. The loop does this automatically.
- **Timestamp monotonicity.** The candidate timestamp must exceed median-time-past; under nonce overflow the timestamp only ever increases, so it cannot fall back below MTP mid-mine.
- **Difficulty floor/ceiling.** The retarget can never make blocks easier than `STARTING_DIFFICULTY` or set a sub-1 target; a malicious-looking timestamp gap is bounded by the 4× ratio clamp.
- **Event-loop yielding uses `setTimeout`, not `setImmediate`.** This is intentional — `setTimeout(…, 0)` avoids starving timers under GC pressure on the shared thread.
- **`mineBlock` (sync) is demo-only.** It blocks the thread to completion. Long-running nodes must use the async path via `startMining`; reserve `Node.mine` for tools and tests.

## Cross-references

- [P2P-SYNC](./P2P-SYNC.md) — how a freshly mined block is broadcast, and how an incoming peer block triggers the abort/restart in `receiveBlock`.
- [CLAIM-FLOW](./CLAIM-FLOW.md) — claim transactions that enter the mempool and get packed into candidate blocks, including claim maturity.
- [RPC](./RPC.md) — the RPC surface that exposes `miningStats`/hashrate from `Node.getState`.
- [BRIDGE](./BRIDGE.md) — downstream design for wrapping mined QBTC as an ERC-20 on Base.
