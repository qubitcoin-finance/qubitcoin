# Mempool Lifecycle

How unconfirmed transactions enter, compete inside, leave, and get rechecked in the QubitCoin mempool. Read this when working on `Mempool.addTransaction`, `getTransactionsForBlock`, `removeTransactions`, `revalidate`, `/api/v1/tx`, `/api/v1/mempool/txs`, or when debugging "Transaction already in mempool", "BTC address already pending claim", "Fee rate ... below minimum", "Mempool full: transaction fee density too low", and rollback-related mempool evictions.

The mempool is the node's short-lived staging area between network/RPC transaction submission and block inclusion. It is not a second chain state: every admission decision is made against the current `Blockchain.utxoSet`, `claimedBtcAddresses`, current height, and optional BTC snapshot. Once the chain tip changes, mined transactions are removed and reorg-sensitive entries are revalidated from scratch.

## Why it exists

ML-DSA-65 transactions are large and expensive to verify. A public node therefore needs a bounded queue that rejects invalid spends early, prevents duplicate input reservations, charges regular transactions a minimum relay fee, and still allows fee-free BTC claim transactions without letting them crowd out the pool indefinitely.

The design splits transactions into two classes. Regular QBTC spends must pass `validateTransaction`, meet `MIN_RELAY_FEE_PER_KB`, and reserve their input outpoints in `claimedUTXOs`. BTC claim transactions use the `CLAIM_TXID` sentinel path, skip normal UTXO validation, and instead reserve a BTC address in `pendingBtcClaims` after duplicate and optional `verifyClaimProof` checks.

Mining reads the same pool through `getTransactionsForBlock`, where claim transactions are ordered first and regular transactions are ordered by fee density. Chain changes are handled in two ways: blocks call `removeTransactions` for transactions they included, while rollback and reorg paths call `revalidate` to evict entries whose inputs or BTC claim status no longer match the new tip.

## Key Files

| Anchor | Role |
|--------|------|
| `src/mempool.ts:16` | `MAX_MEMPOOL_BYTES`, the 50 MB byte cap for pending transactions |
| `src/mempool.ts:20` | `MAX_CLAIM_COUNT`, the count cap for fee-free pending BTC claims |
| `src/mempool.ts:27` | `MIN_RELAY_FEE_PER_KB`, the regular transaction relay-fee floor |
| `src/mempool.ts:29` | `Mempool`, the in-memory transaction pool and reservation indexes |
| `src/mempool.ts:61` | `addTransaction`, the admission path for claims and regular spends |
| `src/mempool.ts:167` | `getTransactionsForBlock`, block/RPC ordering by claim priority and fee density |
| `src/mempool.ts:186` | `removeTransactions`, cleanup after mined or received blocks |
| `src/mempool.ts:209` | `revalidate`, chain-tip-change cleanup after rollback or reorg |
| `src/mempool.ts:340` | `evictLowest`, low-fee regular transaction eviction when the pool is full |
| `src/node.ts:41` | `Node.receiveTransaction`, the shared RPC/P2P ingress into `Mempool.addTransaction` |
| `src/node.ts:78` | `Node.mine` removes included transactions from the local mempool |
| `src/node.ts:88` | `Node.receiveBlock` removes peer-mined transactions and aborts stale mining |
| `src/node.ts:144` | `Node.resetToHeight` revalidates the mempool after a rollback |
| `src/miner.ts:27` | `assembleCandidateBlock`, the miner's mempool-to-block selection path |
| `src/rpc.ts:190` | `POST /api/v1/tx`, RPC submission into `Node.receiveTransaction` |
| `src/rpc.ts:207` | `GET /api/v1/mempool/txs`, lightweight sorted mempool summaries |
| `src/p2p/server.ts:793` | `P2PServer.handleTx`, peer transaction admission and relay behavior |
| `src/__tests__/mempool.test.ts:32` | Core mempool admission tests |
| `src/__tests__/mempool.test.ts:166` | Claim-specific mempool tests |
| `src/__tests__/mempool.test.ts:823` | Sorting tests for `getTransactionsForBlock` |
| `src/__tests__/mempool.test.ts:893` | Revalidation edge-case tests |

## How It Works

### Ingress

There is one main ingress into the pool: `Node.receiveTransaction`. RPC submission deserializes JSON through `deserializeTransaction`, then calls `node.receiveTransaction`; the P2P server does the same after decoding a peer `tx` payload. The node passes current chain state into `Mempool.addTransaction`: `utxoSet`, `claimedBtcAddresses`, `getHeight() + 1`, `btcSnapshot`, and the genesis hash.

The `currentHeight` is the height at which the transaction would be mined if accepted into the next block. This matters for maturity checks inside `validateTransaction`, including claim-output maturity and coinbase maturity. The mempool does not keep an independent height; it always relies on the caller to provide chain context.

```text
RPC POST /api/v1/tx or P2P tx message
  -> deserializeTransaction
  -> Node.receiveTransaction
  -> Mempool.addTransaction(chain.utxoSet, claimedBtcAddresses, nextHeight, snapshot, genesisHash)
  -> node.onNewTransaction broadcast hook on success
```

### Claim Admission

`addTransaction` first rejects duplicate transaction IDs. If `isClaimTransaction(tx)` is true, it takes the claim path instead of the regular UTXO-spend path.

The claim path uses `tx.claimData.btcAddress` as the reservation key. A claim is rejected when that BTC address is already present in `claimedBtcAddresses`, already present in `pendingBtcClaims`, or when `pendingBtcClaims.size` has reached `MAX_CLAIM_COUNT`.

If the node has a `BtcSnapshot`, the mempool verifies the BTC proof with `verifyClaimProof(tx, btcSnapshot, genesisHash)`. This is the same ownership boundary described in [CLAIM-FLOW](./CLAIM-FLOW.md): the claim is fee-free, but not trust-free.

Claims can displace low-fee regular transactions when the byte cap would be exceeded. If there are no regular transactions to evict, the claim can still enter, because `MAX_CLAIM_COUNT` bounds the fee-free claim class separately from `MAX_MEMPOOL_BYTES`.

### Regular Transaction Admission

Regular transactions must pass `validateTransaction(tx, utxoSet, currentHeight)`. That covers signature checks, input ownership, output rules, and maturity constraints in the transaction validator.

After structural and consensus-style validation, the mempool enforces relay economics:

- `transactionSize(tx)` must be positive.
- `calculateFee(tx, utxoSet)` must produce a finite fee rate.
- `(fee / txSize) * 1000` must be at least `MIN_RELAY_FEE_PER_KB`.

The mempool then checks every input against `claimedUTXOs`. This set is a pending-input reservation table: once one mempool transaction spends `txId:outputIndex`, another unconfirmed transaction cannot spend the same outpoint until the first one is removed or revalidation rebuilds the table.

If adding the transaction would exceed `MAX_MEMPOOL_BYTES`, `evictLowest` removes non-claim transactions in ascending fee density until enough space is freed. If the pool cannot free enough space, the incoming regular transaction is rejected with "Mempool full: transaction fee density too low".

### Size And Fee-Density Caches

`Mempool` maintains two caches. `sizeCache` stores immutable `transactionSize(tx)` results keyed by transaction ID. `feeDensityCache` stores `calculateFee(tx, utxoSet) / size` for regular transactions.

The size cache is safe across chain-tip changes because transaction serialization size does not depend on the UTXO set. Fee density does depend on referenced input amounts, so it is cleared after `removeTransactions` and during `revalidate`.

This is why block selection can repeatedly sort a large pool without recomputing sizes every time, while still avoiding stale fee calculations after a block or rollback changes available inputs.

### Block Selection

`getTransactionsForBlock(utxoSet)` returns a copy of the current transaction values. When a UTXO set is supplied, it sorts claims before regular transactions, then sorts regular transactions by fee density descending.

`assembleCandidateBlock` calls `mempool.getTransactionsForBlock(chain.utxoSet)`, walks the sorted list, and includes each transaction that fits under the remaining `MAX_BLOCK_SIZE` budget. It accumulates fees with `calculateFee(tx, chain.utxoSet)` and passes that total into `createCoinbaseTransaction`.

This means mempool admission decides whether a transaction is eligible at all, while mining still enforces block byte limits and fee accounting at candidate assembly time.

### Removal After Blocks

When the local node mines a block, `Node.mine` and `Node.startMining` add it to the chain and call `mempool.removeTransactions` with every transaction ID in the block. `Node.receiveBlock` does the same for blocks accepted from peers.

`removeTransactions` ignores IDs that are not present in the pool, which makes it safe to pass the whole block's transaction list including coinbase. For present regular transactions it frees every reserved input from `claimedUTXOs`; for claims it deletes the BTC address from `pendingBtcClaims`. It subtracts the cached transaction size, removes the transaction, and clears fee-density cache state for the remaining pool.

The removal path is intentionally narrow. It does not recheck surviving transactions; it only deletes known included transactions and cleans their reservation state. Full rechecking is reserved for explicit rollback/reorg handling.

### Revalidation After Rollback Or Reorg

`Node.resetToHeight` rolls the chain back, calls `mempool.revalidate(this.chain.utxoSet, this.chain.claimedBtcAddresses, this.chain.getHeight() + 1)`, and aborts active mining. P2P fork resolution calls `node.resetToHeight(forkPoint)` before requesting blocks from the winning branch.

`revalidate` performs three passes:

1. It scans current entries and marks invalid ones for removal. Claims are removed if their BTC address is now on-chain or duplicated in the pool. Regular transactions are removed if `validateTransaction` fails or if any referenced input is no longer in the current UTXO set.
2. It sorts still-valid regular transactions by fee density descending and keeps only the first transaction for each input outpoint. If two injected or previously-valid transactions conflict after a chain change, the higher-fee-density one wins.
3. It deletes marked transactions, clears fee-density and reservation state, then rebuilds `claimedUTXOs` and `pendingBtcClaims` from surviving transactions.

This rebuild is the important invariant. Reorgs can invalidate assumptions that were true at admission time, so the mempool does not try to patch reservations incrementally after rollback. It derives reservation state from the surviving transaction set.

## Invariants And Edge Cases

### Reservation Invariants

Every regular transaction present in `transactions` must have all of its inputs represented in `claimedUTXOs`. Every claim transaction present in `transactions` must have its BTC address represented in `pendingBtcClaims`.

The inverse must also hold after cleanup: if a transaction is removed, its regular inputs or claim address must stop reserving space. Otherwise the node would reject unrelated future transactions with stale "already claimed" or "pending claim" errors.

### Claim-Specific Invariants

Fee-free claims are bounded by count, not by fee density. `MAX_CLAIM_COUNT` protects memory and keeps regular transactions possible even when the claim queue is full. Regular transactions are still allowed after the claim limit is reached.

A BTC address can be in only one of three states from the mempool's perspective: unclaimed and not pending, pending in `pendingBtcClaims`, or already on-chain in `claimedBtcAddresses`. `addTransaction` rejects the latter two, and `revalidate` removes entries that become on-chain after a block or rollback sequence.

### Fee And Eviction Invariants

Regular transactions need a positive size and at least `MIN_RELAY_FEE_PER_KB`. `evictLowest` only evicts non-claim transactions, sorted by lowest fee density first. If it cannot free enough space, a regular incoming transaction is rejected instead of overfilling the pool.

Claims use `evictLowest` opportunistically when the byte cap is exceeded, but they can still be accepted when no regular eviction candidate exists. That exception relies on the claim count cap; removing it would let fee-free claim traffic be governed only by byte accounting.

### Ordering Invariants

Supplying a UTXO set to `getTransactionsForBlock` is what enables deterministic fee-density ordering. Without a UTXO set, it returns the current map values without sorting by fee density.

The miner and `/api/v1/mempool/txs` both pass `node.chain.utxoSet`, so user-facing summaries and block assembly share the same priority order: claims first, then higher fee density.

### Reorg Edge Cases

Rollback can remove the UTXO a pending transaction spends, mature or immature a previously accepted spend, or make a pending claim already claimed on-chain on the branch being adopted. `revalidate` is the place that handles those transitions.

Duplicate claims and duplicate regular spends should not normally appear through `addTransaction`, but tests use `injectTransaction` to simulate corrupted or stale internal state. `revalidate` still removes duplicate pending claims and chooses the highest-fee-density transaction among conflicting regular spends.

### RPC And P2P Boundaries

RPC and P2P both feed the same node method, so a transaction accepted through either path triggers the same mempool checks and the same `onNewTransaction` broadcast hook. P2P adds peer-specific hardening before admission: malformed payloads, invalid transaction hashes, rapid submissions, and rejected transactions increase peer misbehavior.

`GET /api/v1/tx/:txid` checks the mempool before the chain. A transaction that has just been mined disappears from the mempool and is then found through `chain.findTransactionBlock`, where the response gains block metadata and confirmations.

## Cross-References

- [CLAIM-FLOW](./CLAIM-FLOW.md) for BTC snapshot ownership proofs, `CLAIM_TXID`, and claim maturity.
- [MINING-LIFECYCLE](./MINING-LIFECYCLE.md) for candidate assembly, coinbase fee collection, and mining aborts on new tips.
- [REORG-UNDO](./REORG-UNDO.md) for the chain rollback machinery that calls mempool revalidation.
- [P2P-SYNC](./P2P-SYNC.md) for peer transaction relay, fork resolution, and when `resetToHeight` is triggered.
- [BLOCK-STORAGE](./BLOCK-STORAGE.md) for `deserializeTransaction` and the JSON/binary boundary used by RPC and P2P transaction input.
- [RPC](./RPC.md) for rate-limit and proxy behavior around public RPC endpoints.
