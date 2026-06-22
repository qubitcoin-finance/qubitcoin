# UTXO & Address Indexing

The in-memory index structures inside `Blockchain` (`src/chain.ts`) that turn raw block data into O(1) balance, UTXO-set, and transaction lookups — `utxoSet`, `utxosByAddress`, and `transactionIndex`. Read this when working on `getBalance`, `findUTXOs`, `findTransactionBlock`, the `/api/v1/address/*` and `/api/v1/tx/*` RPC endpoints, or when a balance is wrong, a UTXO is missing, or a transaction "exists but isn't found".

This doc is about the **query side**: how the three maps are shaped, kept consistent, and read. The **mutation side** — when entries are added and removed during apply/reorg — lives in [REORG-UNDO](./REORG-UNDO.md). The **per-transaction validation** that reads `utxoSet` lives in [TRANSACTION-ANATOMY](./TRANSACTION-ANATOMY.md).

## Why it exists

A naive node answers "what is address X's balance?" by scanning every UTXO, and "where is transaction T?" by scanning every block. Both are O(chain size) and get slower as the chain grows. The explorer and wallet flows hit these queries constantly: every address page load calls `getBalance` + `findUTXOs`, every transaction page calls `findTransactionBlock`, and `createTransaction` selects inputs via `findUTXOs`.

QubitCoin keeps three derived indexes in memory so all of these are O(1) (or O(UTXOs-for-one-address), which is small). The indexes are never persisted — they are rebuilt by replaying `blocks.jsonl` on startup (see [BLOCK-STORAGE](./BLOCK-STORAGE.md)). The single source of truth on disk is the block list; the maps are a cache that must stay perfectly in lock-step with it.

## Key files

| Symbol | Location | Role |
|---|---|---|
| `utxoSet` | `src/chain.ts:43` | `Map<utxoKey, UTXO>` — the live unspent-output set |
| `utxosByAddress` | `src/chain.ts:45` | `Map<address, Set<utxoKey>>` — reverse index for balance/coin-selection |
| `transactionIndex` | `src/chain.ts:47` | `Map<txId, Block>` — txid → containing block |
| `utxoKey(txId, i)` | `src/transaction.ts:99` | builds the `"${txId}:${i}"` map key |
| `getBalance(address)` | `src/chain.ts:214` | sums amounts of an address's UTXOs |
| `findUTXOs(address, amount?)` | `src/chain.ts:226` | returns UTXOs, optionally stopping once `amount` is covered |
| `findTransactionBlock(txId)` | `src/chain.ts:262` | O(1) txid → block |
| `indexUtxo` / `unindexUtxo` | `src/chain.ts:578` / `:588` | maintain `utxosByAddress` alongside `utxoSet` writes |
| `indexBlockTransactions(block)` | `src/chain.ts:597` | populate `transactionIndex` for a block |

## The three indexes

### utxoSet — the authoritative unspent set

`utxoSet` maps a `utxoKey` (the string `"<txId>:<outputIndex>"`) to a `UTXO` record holding `address`, `amount`, `height`, and the `isCoinbase` / `isClaim` flags. This is the structure block validation consults: `validateBlock` is handed `this.utxoSet` at `src/chain.ts:154`, and `validateTransaction` looks up each spent input via `utxoSet.get(utxoKey(...))` at `src/transaction.ts:333`. `Node` also surfaces `utxoSet.size` as `utxoCount` in `/api/v1/status` (`src/node.ts:191`).

A `UTXO` is added when an output is created and deleted when an input spends it. Both happen in `applyBlock` (`src/chain.ts:604`); both are reversed in `disconnectBlock` (`src/chain.ts:697`).

### utxosByAddress — the reverse index

`utxosByAddress` maps an address to the **set of `utxoKey` strings** it owns. It stores keys, not `UTXO` objects, so there is exactly one copy of each UTXO (in `utxoSet`) and the reverse index never goes stale on amount/height. `getBalance` and `findUTXOs` walk the key set and dereference each key back through `utxoSet`:

```text
getBalance(addr):
  keys = utxosByAddress.get(addr)        # O(1)
  for key in keys:                       # O(UTXOs for addr)
    utxo = utxoSet.get(key)              # O(1)
    if utxo: balance += utxo.amount
```

The defensive `if (utxo)` guard matters: it tolerates a key lingering in the set with no backing `utxoSet` entry rather than crashing. In a consistent index that branch is never taken, but it keeps a single dropped invariant from turning a balance query into an exception.

`findUTXOs(address, amount?)` does the same walk but can early-return: once `accumulated >= amount` it stops (`src/chain.ts:237`), so coin selection for a small payment does not enumerate a whale's entire UTXO set. With no `amount` it returns everything (the form the `/api/v1/address/:address/utxos` endpoint uses, `src/rpc.ts:262`).

### transactionIndex — txid → block

`transactionIndex` maps a transaction id to the `Block` that contains it, giving `findTransactionBlock` an O(1) answer. The `/api/v1/tx/:txid` handler checks the mempool first (`node.mempool.getTransaction`, `src/rpc.ts:168`) and falls back to `findTransactionBlock` for confirmed transactions (`src/rpc.ts:174`). It is populated by `indexBlockTransactions`, called from both the genesis/replay path and from `applyBlock`.

## Keeping the indexes consistent

The cardinal rule: **every write to `utxoSet` is paired with the matching `indexUtxo`/`unindexUtxo` call**, so the two maps can never drift.

- Creating a UTXO → `utxoSet.set(key, …)` then `indexUtxo(output.address, key)` (`src/chain.ts:680`–`688`, and the claim path at `:643`–`651`).
- Spending a UTXO → capture it into the undo journal, `unindexUtxo(existing.address, key)`, then `utxoSet.delete(key)` (`src/chain.ts:661`–`666`).
- Overwriting an existing key (e.g. a duplicate coinbase txid) → the overwritten UTXO is pushed to `undo.spentUtxos` and un-indexed before the new value is written (`src/chain.ts:675`–`678`).

`unindexUtxo` deletes the address's whole `Set` entry when it empties (`src/chain.ts:592`). That keeps `utxosByAddress` from accumulating empty sets for addresses that have spent everything, so iterating the map stays proportional to addresses with a live balance.

`indexUtxo`/`unindexUtxo` are deliberately **not** called for `transactionIndex` — transactions are indexed per block by `indexBlockTransactions` on apply and removed per-txid in `disconnectBlock` (`src/chain.ts:699`–`701`). Outputs (UTXOs) and transactions have different lifetimes: an output can be spent while its transaction stays confirmed, so the two indexes are maintained independently.

## Rebuild paths

The indexes are state, not storage, so any time the chain is reconstructed they are rebuilt from blocks:

### Startup replay

The constructor (`src/chain.ts:60`) loads persisted blocks and replays them: genesis is indexed via `indexBlockTransactions`, then every subsequent block goes through `applyBlock`, which both mutates `utxoSet`/`utxosByAddress` and indexes its transactions. After replay the maps reflect the on-disk tip. Genesis coinbase intentionally does **not** enter `utxoSet` (it pays the burn address), so a fresh node starts with an empty UTXO set above genesis.

### resetToHeight fast vs slow path

`resetToHeight` (used by reorg) has two modes (`src/chain.ts:495`):

- **Fast path** — when undo data is available, it calls `disconnectBlock` per removed block, which incrementally un-applies UTXO and transaction-index changes. The indexes are never cleared.
- **Slow path** — when undo data is missing, it clears `utxoSet`, `utxosByAddress`, `transactionIndex`, and the claim counters (`src/chain.ts:511`–`516`), re-indexes genesis, and re-applies every block from height 1. This is the brute-force rebuild that guarantees a clean index even if the undo journal was lost.

Both paths converge on the same index contents for a given height; the fast path is just O(blocks removed) instead of O(chain).

## Invariants and edge cases

- **Key uniqueness.** `utxoKey` is `"<txId>:<outputIndex>"`. Two distinct outputs can never share a key unless two transactions share a txid (the duplicate-coinbase case), which the overwrite-and-journal logic handles explicitly so the earlier UTXO can be restored on disconnect.
- **`utxosByAddress` ⊆ `utxoSet`.** Every key in an address set should resolve in `utxoSet`. The `if (utxo)` guards in `getBalance`/`findUTXOs` mean a violated invariant degrades to a slightly-low balance rather than a thrown error — but a violated invariant is still a bug, fix the mutation path, not the reader.
- **No maturity or mempool filtering here.** `getBalance` and `findUTXOs` report the **confirmed** UTXO set with no awareness of coinbase maturity (`COINBASE_MATURITY`) or UTXOs already reserved by a pending mempool transaction. Spendability is enforced later: `validateTransaction` rejects immature coinbase spends, and `Mempool` tracks `claimedUTXOs` to prevent double-spending unconfirmed inputs (see [MEMPOOL-LIFECYCLE](./MEMPOOL-LIFECYCLE.md)). A balance can therefore include coins that cannot yet be spent.
- **Address normalization.** RPC handlers lower-case the address before querying (`src/rpc.ts:203`, `:214`), because index keys are stored as the lower-case hex addresses written by `applyBlock`. Querying with mixed case would miss.
- **In-memory only.** None of the three maps is serialized. Corruption or a code path that writes `utxoSet` without the paired index call cannot be detected on disk — it only surfaces as a wrong balance at query time. When in doubt, a slow-path `resetToHeight` rebuild restores a clean index from blocks.

## Cross-references

- [REORG-UNDO](./REORG-UNDO.md) — the apply/disconnect journal that drives every index mutation.
- [TRANSACTION-ANATOMY](./TRANSACTION-ANATOMY.md) — how `validateTransaction` reads `utxoSet` and enforces maturity/dust.
- [MEMPOOL-LIFECYCLE](./MEMPOOL-LIFECYCLE.md) — the `claimedUTXOs` reservation layer that sits above the confirmed UTXO set.
- [BLOCK-STORAGE](./BLOCK-STORAGE.md) — the persisted `blocks.jsonl` the indexes are rebuilt from on startup.
- [SNAPSHOT-PIPELINE](./SNAPSHOT-PIPELINE.md) — the separate `snapshotIndex` for BTC claim lookups, distinct from these chain indexes.
