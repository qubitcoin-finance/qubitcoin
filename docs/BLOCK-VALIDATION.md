# Block Validation Lifecycle

How a block is accepted onto the chain: the ordered consensus checks in `validateBlock` (`src/block.ts`) plus the contextual gates in `Blockchain.addBlock` (`src/chain.ts`) — target match, claim ECDSA proofs, and difficulty retargeting. Read this when working on `validateBlock`, `addBlock`, `adjustDifficulty`, or `medianTimestamp`, or when debugging "Block hash mismatch", "Block hash does not meet difficulty target", "Block target mismatch", "Previous hash does not match", "Invalid block height", "must be greater than median time past", "Merkle root mismatch", "Duplicate transaction ID", "First transaction must be coinbase", "Double-spend in block", or "Coinbase amount … exceeds max reward".

## Why it exists

A block arriving from a peer, the miner, or chain replay on startup is untrusted. Before its UTXO mutations touch the in-memory set, it must be proven to satisfy every consensus rule — and proven *cheaply first*, so a malicious peer cannot force expensive work (merkle hashing, ML-DSA signature verification) with a trivially malformed block. Validation is therefore ordered from O(1) structural checks toward expensive cryptographic ones, and split across two layers so that the pure structural rules (`validateBlock`) stay free of chain state while the contextual rules (expected difficulty, claim double-spend, snapshot lookups) live next to the data they need in `Blockchain`.

## Key files

| Symbol | Location | Role |
|--------|----------|------|
| `validateBlock` | `src/block.ts:310` | Structural + per-tx consensus checks, ordered cheap→expensive |
| `Blockchain.addBlock` | `src/chain.ts:151` | Contextual gate: target match, calls `validateBlock`, claim proofs, apply, retarget |
| `hashMeetsTarget` | `src/block.ts:154` | `BigInt(hash) < BigInt(target)` PoW predicate |
| `computeBlockHash` | `src/block.ts:149` | `doubleSha256` of the 112-byte serialized header |
| `computeMerkleRoot` | `src/block.ts:115` | Bitcoin-style merkle, duplicates last leaf if odd |
| `medianTimestamp` | `src/block.ts:302` | Median of last 11 block timestamps (MTP) |
| `blockSize` / `transactionSize` | `src/block.ts:103` / `:83` | Byte-size estimate gating `MAX_BLOCK_SIZE` |
| `adjustDifficulty` | `src/chain.ts:270` | Retarget every `DIFFICULTY_ADJUSTMENT_INTERVAL` blocks |
| `blockWork` | `src/block.ts:159` | `2^256 / (target + 1)`, summed into `cumulativeWork` |

## The two layers

`validateBlock(block, previousBlock, utxoSet, chainBlocks?)` is a pure function. It returns `{ valid, error? }` and never mutates anything. It knows only the candidate block, its predecessor, the current UTXO map, and (optionally) the full block array for median-time-past. It is reused identically by `addBlock`, by reorg validation, and by tests.

`Blockchain.addBlock(block)` is the stateful wrapper. It performs the checks that require live chain state *before* and *after* the pure call, then applies the block. Crucially, the expected-difficulty check happens in `addBlock`, not `validateBlock`: a block can be internally consistent (its hash meets its own stated target) yet still be rejected because that target is not the difficulty the chain currently demands.

```text
addBlock(block)
  ├─ target == this.difficulty ?            (chain.ts:154)  ── "Block target mismatch"
  ├─ validateBlock(...)                      (chain.ts:163)  ── ordered checks below
  ├─ for each claim tx: verifyClaimProof     (chain.ts:168)  ── ECDSA + snapshot + double-claim
  ├─ applyBlock(block) → push undo journal   (chain.ts:188)
  ├─ cumulativeWork += blockWork(target)     (chain.ts:197)
  ├─ blocks.push / blocksByHash.set          (chain.ts:200)
  ├─ every Nth block: difficulty = adjust()  (chain.ts:204)
  └─ persist block + metadata                (chain.ts:209)
```

## Ordering inside validateBlock

The order is deliberate — each check is cheaper than the next, so the worst-case cost of rejecting a junk block is bounded by how far it gets.

### 1. Transaction count (O(1))

`block.transactions.length > MAX_BLOCK_TRANSACTIONS` (10,000) is rejected first, before any hashing. This caps the cost of every subsequent loop.

### 2. Block hash integrity

`computeBlockHash(block.header)` must equal `block.hash`. This stops a peer from claiming a low hash while shipping a different header.

### 3. Proof of work

`hashMeetsTarget(block.hash, block.header.target)` — the hash interpreted as a 256-bit integer must be strictly less than the target. Checked against the block's *own* stated target here; the chain's *expected* target was already enforced by `addBlock`.

### 4. Link to predecessor

With a `previousBlock`: `header.previousHash` must equal `previousBlock.hash`, and `block.height` must equal `previousBlock.height + 1` (sequential-height rule, defence against height-spoofing). With no predecessor (genesis): `previousHash` must be all-zero.

### 5. Timestamp (median time past + future bound)

Skipped for genesis and for chains shorter than 2 blocks. Otherwise the timestamp must be **strictly greater than** `medianTimestamp` of the last 11 blocks (`MEDIAN_TIME_SPAN`), preventing timestamp-rollback attacks that would skew difficulty. It must also not exceed `Date.now() + MAX_FUTURE_BLOCK_TIME_MS` (2 hours).

### 6. Block size

`blockSize(block) > MAX_BLOCK_SIZE` (1 MB) is rejected here — after count/hash/PoW but *before* the merkle hash and per-tx crypto, so size abuse is caught cheaply.

### 7. Merkle root

`computeMerkleRoot(txIds)` must equal `header.merkleRoot`. Bitcoin-style: pair-wise `doubleSha256`, duplicating the last leaf when a level has an odd count.

### 8. Duplicate txid scan (CVE-2012-2459)

A `Set` of txids rejects any block containing two transactions with the same id. This is defence-in-depth against the merkle malleability where a duplicated subtree yields the same root.

### 9. Coinbase position

The block must be non-empty, `transactions[0]` must satisfy `isCoinbase`, and no transaction at index ≥ 1 may be a coinbase.

### 10. Per-transaction validation + fee accounting

Looping over the non-coinbase transactions:

- **Claim transactions** (`isClaimTransaction`) get *structural* validation only here — `claimData` present, exactly one input bearing the `CLAIM_TXID` sentinel, exactly one output, amount ≥ `DUST_THRESHOLD` and integer. The actual ECDSA/Schnorr ownership proof is deferred to `addBlock`'s `verifyClaimProof` call, because it needs the BTC snapshot and the genesis hash. The sentinel-input rule blocks hybrid txs that smuggle real UTXOs alongside a claim.
- **Regular transactions** are checked for **double-spend within the block** via a `spentInBlock` set of `utxoKey(txId, outputIndex)`, then validated by `validateTransaction(tx, utxoSet, block.height)` (signatures, UTXO existence, amounts, maturity — see [TRANSACTION-ANATOMY](./TRANSACTION-ANATOMY.md)). Their fees accumulate into `totalFees`.

### 11. Coinbase reward bound

`coinbaseAmount` (sum of coinbase outputs) must not exceed `blockSubsidy(block.height) + totalFees`. Paying *less* is allowed (miner forfeits); paying more is rejected.

## Difficulty retargeting

After a block is appended, `addBlock` calls `adjustDifficulty` whenever `blocks.length % DIFFICULTY_ADJUSTMENT_INTERVAL === 0` (every 10 blocks). The retarget compares actual elapsed time across the interval against the expected time:

```text
actualTime   = latest.timestamp − intervalStart.timestamp
expectedTime = (DIFFICULTY_ADJUSTMENT_INTERVAL − 1) × TARGET_BLOCK_TIME_MS
ratio        = clamp(actualTime / expectedTime, 0.25, 4.0)
newTarget    = currentTarget × ratio        (clamped to ≤ STARTING_DIFFICULTY, ≥ 1)
```

The `N − 1` gap count matters: 10 blocks span 9 inter-block intervals, so dividing by `N` instead of `N−1` would bias difficulty permanently. A larger ratio means blocks came slowly, so the target grows (easier); a smaller ratio shrinks it (harder). The 0.25–4.0 clamp mirrors Bitcoin and bounds how fast difficulty can swing in one retarget. `STARTING_DIFFICULTY` is the easiest the live chain will ever go.

The same retarget is re-derived during chain replay on startup and after a `resetToHeight` rebuild (`chain.ts:85`, `:197`, `:525`), so persisted chains converge to the identical `difficulty` value without storing every historical target.

## Invariants and edge cases

- **Pure vs contextual split.** `validateBlock` must stay free of `Blockchain` state. Anything needing the snapshot, the claimed-address set, or the expected difficulty belongs in `addBlock`. Moving the target-match check into `validateBlock` would break reorg validation, which legitimately re-validates historical blocks at their *own* era's target.
- **Cheap-before-expensive is load-bearing, not cosmetic.** Reordering so that merkle hashing or signature checks run before the count/size guards reopens the DoS surface the ordering was built to close.
- **Median-time-past is strict-greater.** Equal timestamps are rejected. A miner copying the previous timestamp will fail check 5 once the chain is ≥ 2 blocks.
- **Future-time uses wall clock.** Check 5's future bound reads `Date.now()`, so block acceptance is mildly clock-dependent; the 2-hour slack absorbs normal skew.
- **Claim proof is two-phase.** Structural shape in `validateBlock`, cryptographic ownership in `addBlock`. A claim that passes structure can still be rejected for a bad signature, an unknown BTC address, or a prior claim of the same address — see [CLAIM-FLOW](./CLAIM-FLOW.md).
- **Work, not length, is authority.** `addBlock` adds `blockWork(target)` to `cumulativeWork`; fork choice compares cumulative work, never block height — see [REORG-UNDO](./REORG-UNDO.md) and [P2P-SYNC](./P2P-SYNC.md).
- **Genesis bypasses contextual rules.** Both `createGenesisBlock` and `createForkGenesisBlock` produce blocks that skip the predecessor, height, and timestamp checks; the fork genesis additionally embeds the snapshot commitment validated separately — see [SNAPSHOT-PIPELINE](./SNAPSHOT-PIPELINE.md).

## Cross-references

- [MINING-LIFECYCLE](./MINING-LIFECYCLE.md) — the production side: how the miner assembles a candidate that will pass these checks.
- [TRANSACTION-ANATOMY](./TRANSACTION-ANATOMY.md) — `validateTransaction` internals invoked at step 10.
- [REORG-UNDO](./REORG-UNDO.md) — `applyBlock`/`disconnectBlock`, the undo journal, and cumulative-work fork choice.
- [UTXO-INDEXING](./UTXO-INDEXING.md) — the `utxoSet`/address indexes the validation reads and `applyBlock` mutates.
- [CLAIM-FLOW](./CLAIM-FLOW.md) — `verifyClaimProof`, the deferred ECDSA/Schnorr ownership check.
- [BLOCK-STORAGE](./BLOCK-STORAGE.md) — persistence of accepted blocks and chain replay on startup.
- [P2P-SYNC](./P2P-SYNC.md) — where peer-supplied blocks enter and how rejection feeds misbehavior scoring.
