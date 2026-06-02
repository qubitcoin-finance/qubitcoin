# Reorg & Undo Internals

This doc covers the in-memory UTXO/undo machinery inside `src/chain.ts` that makes chain reorganizations cheap: the `BlockUndo` journal, `applyBlock`/`disconnectBlock`, and the fast-vs-slow `resetToHeight` paths. Read it when working on `Blockchain` state mutation, debugging a wrong balance or `cumulativeWork` after a reorg, tuning `MAX_REORG_DEPTH`, or understanding why a `resetToHeight` fell back to full replay. The network side — deciding *whether* to reorg from peer headers — lives in [P2P-SYNC](./P2P-SYNC.md); this doc is the apply/undo side that the decision drives.

## Why it exists

A blockchain tip is not final. When a peer presents a branch with more cumulative work, the node must rewind its own UTXO set, claimed-address set, difficulty, transaction index, and work counter back to the fork point, then replay the winning branch. Recomputing all of that from genesis on every reorg would be O(chain length) — unacceptable for a node that has applied thousands of blocks.

The fix is an **undo journal**: each time `applyBlock` mutates the in-memory state, it records exactly what it changed into a `BlockUndo` record. Disconnecting a block is then the inverse replay of one record — O(transactions in block), not O(chain). `resetToHeight` pops records backward to unwind to any recent height in time proportional to blocks removed, not to total chain height.

The journal is bounded: only the last `MAX_REORG_DEPTH` (100) records are retained. A reorg deeper than that cannot use the fast path and falls back to a full replay from genesis. That same cap is enforced on the network side, so deep reorgs are refused before they reach the chain at all — the slow path exists mainly for the startup-replay edge case where the journal length doesn't match the chain height.

## Key files

| Anchor | Symbol | Role |
|--------|--------|------|
| `src/chain.ts:30` | `BlockUndo` interface | One record per applied block — the inverse-mutation journal |
| `src/chain.ts:28` | `MAX_REORG_DEPTH = 100` | Bound on retained undo records / fast-path depth |
| `src/chain.ts:42` | `Blockchain.undoData` | `BlockUndo[]`; `undoData[i]` corresponds to the block at height `i+1` |
| `src/chain.ts:58` | `Blockchain.cumulativeWork` | `bigint` total work; the reorg tiebreaker |
| `src/chain.ts:142` | `addBlock` | Validates, calls `applyBlock`, pushes undo, prunes, tracks work |
| `src/chain.ts:603` | `applyBlock` | Mutates UTXO/claim/index state, returns the `BlockUndo` |
| `src/chain.ts:696` | `disconnectBlock` | Inverse-replays one `BlockUndo` — O(1) per block |
| `src/chain.ts:487` | `resetToHeight` | Fast undo path vs slow full-replay path; rewrites storage |
| `src/chain.ts:305` | `validateChain` | Whole-chain re-check using a `tempClaimed` shadow set |
| `src/node.ts:145` | `Node.resetToHeight` | Wraps chain reset + mempool revalidate + mining abort |
| `src/p2p/server.ts:1100` | reorg call site | Work comparison, then `node.resetToHeight(forkPoint)` |

## What a BlockUndo records

`applyBlock` builds one `BlockUndo` (`src/chain.ts:604`) capturing every reversible effect of the block:

- `spentUtxos: Array<{ key; utxo }>` — UTXOs removed from `utxoSet` (consumed by inputs, *or* overwritten by a colliding output key). Restored verbatim on disconnect.
- `createdUtxoKeys: string[]` — keys added to `utxoSet` by this block's outputs. Deleted on disconnect.
- `claimedAddresses: string[]` — BTC addresses added to `claimedBtcAddresses` by claim transactions. Un-claimed on disconnect, with `claimedCount`/`claimedAmount` decremented.
- `previousDifficulty: string` — the `difficulty` value *before* this block. Restored on disconnect.
- `blockWork: bigint` — work this block contributed. Subtracted from `cumulativeWork` on disconnect.
- `transactionIds: string[]` — every tx id added to the `transactionIndex`. Removed on disconnect.

The symmetry is the whole point: anything `applyBlock` writes, `disconnectBlock` must be able to revert from this record alone, without re-reading the block.

## How applyBlock mutates state

`applyBlock` (`src/chain.ts:603`) walks the block's transactions and updates four structures in lockstep with the undo record:

### Claim transactions

A claim tx (`isClaimTransaction`) marks `claim.btcAddress` in `claimedBtcAddresses`, bumps the O(1) `claimedCount`/`claimedAmount` counters via the `snapshotIndex` lookup, and creates a fresh post-quantum UTXO per output flagged `isClaim: true`. Each created key is pushed to `createdUtxoKeys`; the claimed address to `claimedAddresses`. Claim txs have no spendable inputs, so no UTXOs are consumed.

### Regular and coinbase transactions

Non-coinbase inputs delete their referenced UTXO from `utxoSet` (saving the prior value into `spentUtxos`) and unindex it from `utxosByAddress`. Coinbase inputs are skipped. Every output then creates a UTXO keyed by `utxoKey(tx.id, i)`, indexed by address, and pushed to `createdUtxoKeys`. Coinbase outputs carry `isCoinbase: true` so maturity rules can see them.

### The overwrite case

If an output key already exists in `utxoSet` (e.g. a duplicate coinbase txid — the historical CVE-2012-2459 shape, otherwise rejected by `validateBlock`), the overwritten UTXO is saved into `spentUtxos` before being replaced. This lets `disconnectBlock` restore the original rather than leaving a hole.

## How disconnectBlock reverses it

`disconnectBlock` (`src/chain.ts:696`) replays the record in reverse-effect order: drop `transactionIds` from the index, delete `createdUtxoKeys` (unindexing each), re-insert every `spentUtxos` entry (re-indexing), delete each `claimedAddresses` entry (decrementing the claim counters), restore `previousDifficulty`, and subtract `blockWork` from `cumulativeWork`. After one call the in-memory state is byte-identical to what it was before the corresponding `applyBlock` — that exact-restoration invariant is what makes the fast path safe.

## resetToHeight: fast path vs slow path

`resetToHeight(targetHeight)` (`src/chain.ts:487`) is the single rewind entry point. It picks a path based on whether the undo journal covers the full unwind:

```text
hasUndoData = (undoData.length === currentHeight)

FAST  (hasUndoData && targetHeight > 0):
  for h from currentHeight down to targetHeight+1:
      blocksByHash.delete(blocks[h].hash)
      disconnectBlock(undoData[h-1])   # O(txs in block)
      undoData.pop(); blocks.pop()
  → cost O(blocks removed)

SLOW  (journal incomplete, e.g. after startup replay, or target == genesis):
  truncate blocks to targetHeight+1
  clear utxoSet, utxosByAddress, claimedBtcAddresses, transactionIndex,
        claim counters; reset difficulty to STARTING_DIFFICULTY
  re-apply blocks[1..targetHeight] via applyBlock, recomputing
        cumulativeWork and difficulty adjustments
  → cost O(targetHeight)
```

Both paths finish by calling `storage.rewriteBlocks(this.blocks)` and `saveMetadata(...)` so the on-disk NDJSON matches the truncated chain, then set `replayHeight = targetHeight`. (Storage persistence details are in [BLOCK-STORAGE](./BLOCK-STORAGE.md).)

The `hasUndoData = undoData.length === currentHeight` check is the trigger: in steady state the journal is pruned to `MAX_REORG_DEPTH`, so after the chain grows past 100 blocks the lengths diverge and `resetToHeight` would take the slow path for any target — but the network layer never asks for a reorg deeper than `MAX_REORG_DEPTH`, and shallow reorgs at a low tip keep `undoData.length === currentHeight` true. The slow path's main real-world caller is logic that resets all the way to genesis or runs before the journal is full.

## Cumulative work is the reorg tiebreaker

`cumulativeWork` (`src/chain.ts:58`) is summed via `blockWork(target)` in the constructor's replay loop, in `addBlock`, and in both `resetToHeight` paths; `disconnectBlock` subtracts it. The P2P layer compares `peer.remoteCumulativeWork` against `chain.cumulativeWork` (`src/p2p/server.ts:1084`) and only reorgs when the peer strictly exceeds it. A peer claiming more work than its headers can justify (over the `1.5×` sanity bound at `server.ts:1076`) is banned. When a peer omits work, the node falls back to height comparison. Because work is restored exactly on disconnect and re-summed on replay, the counter stays consistent across any number of reorgs — a drift here is a sign the undo record missed a `blockWork` entry.

## validateChain and the tempClaimed shadow set

`validateChain` (`src/chain.ts:305`) re-validates the entire chain from genesis without touching live state. Because claim transactions must be unique chain-wide, it tracks claimed BTC addresses in a local `tempClaimed = new Set<string>()` (`src/chain.ts:307`) rather than consulting `claimedBtcAddresses` — a double-claim within the validated range is caught by `tempClaimed.has(claimKey)` (`src/chain.ts:391`) and recorded with `tempClaimed.add(...)` (`src/chain.ts:440`). This keeps validation a pure function of the block array, independent of whatever the live UTXO/claim state currently holds.

## Invariants and edge cases

- **Exact restoration.** `disconnectBlock(applyBlock(b))` must return every structure — `utxoSet`, `utxosByAddress`, `claimedBtcAddresses`, `claimedCount`/`claimedAmount`, `transactionIndex`, `difficulty`, `cumulativeWork` — to its pre-apply value. Any field `applyBlock` writes but the `BlockUndo` omits is a latent reorg corruption.
- **Journal/height alignment.** `undoData[i]` is the undo for height `i+1`. The fast path relies on `undoData.length === currentHeight`; pruning to `MAX_REORG_DEPTH` deliberately breaks that for deep targets, forcing the slow path.
- **Depth cap is enforced twice.** `src/p2p/server.ts:1053` refuses reorgs deeper than `MAX_REORG_DEPTH` before calling `resetToHeight`, and `addBlock` prunes `undoData` to the same bound (`src/chain.ts:184`). Raising one without the other leaves the fast path unable to honor what the network accepts.
- **Storage is rewritten, not appended.** Unlike `addBlock` (which appends), `resetToHeight` calls `rewriteBlocks` — a reorg truncates the on-disk log. `replayHeight` is updated so subsequent `addBlock` calls persist new tip blocks correctly.
- **Reorg is more than the chain.** `Node.resetToHeight` (`src/node.ts:145`) also calls `mempool.revalidate(...)` against the rewound UTXO/claim state and aborts in-progress mining (`miningAbort?.abort()`), so transactions that became invalid or double-spent are dropped and the miner restarts on the new tip.

## Cross-references

- [P2P-SYNC](./P2P-SYNC.md) — how peer headers and cumulative work decide *whether* to reorg, and the `handleHeaders` fork-point scan that calls `resetToHeight`.
- [BLOCK-STORAGE](./BLOCK-STORAGE.md) — `rewriteBlocks`/`saveMetadata`, NDJSON persistence, and chain replay on startup that seeds `undoData`.
- [MINING-LIFECYCLE](./MINING-LIFECYCLE.md) — `mineBlockAsync`, abort-on-new-tip, and difficulty retargeting that the reorg path resets.
- [CLAIM-FLOW](./CLAIM-FLOW.md) — claim transaction structure and `claimedBtcAddresses` semantics that `applyBlock`/`disconnectBlock` mutate.
