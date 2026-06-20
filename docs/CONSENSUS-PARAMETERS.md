# Consensus Parameters

This doc is the single reference for every consensus and network constant in qbtc — the "magic numbers" that define the protocol: block target/difficulty, block-time and size caps, coinbase/claim maturity, the dust threshold, the money supply ceiling, the subsidy/halving schedule, per-transaction input/output limits, and the reorg depth bound. Read this when you need the exact value of a constant, where it is defined, what code enforces it, and what breaks if it changes. Each value here is consensus-critical: changing one without a coordinated fork splits the network. The per-constant flow details live in the cross-referenced docs; this page is the catalog and the index into them.

## Why a single catalog exists

These constants are deliberately spread across three modules by concern — `src/block.ts` owns block-level limits and difficulty, `src/transaction.ts` owns transaction-level limits and the emission schedule, `src/chain.ts` owns the in-memory reorg bound. That split is good for cohesion but bad for discovery: a maintainer asking "what is the maximum block size" or "how long until a claim output matures" has to know which file to open. Several flow docs (BLOCK-VALIDATION, MINING-LIFECYCLE, SUPPLY-AND-EMISSION, REORG-UNDO) each cite a subset of these numbers in passing, but none lists them all with their definitions and enforcement points. This page is that list.

Every constant below is exported (or, where noted, module-private) and referenced by name in validation, mining, or reorg code. The values are the live working-tree values; if you change a definition, update this catalog and the flow doc that owns the rule.

## Block-level parameters (`src/block.ts`)

These govern proof-of-work targeting, block timing, and block-size limits. All are enforced in `validateBlock` / `Blockchain.addBlock` / `adjustDifficulty`.

| Constant | Value | Defined | Meaning |
|---|---|---|---|
| `INITIAL_TARGET` | `00000fff…ff` | `src/block.ts:51` | Genesis / easy PoW target. Used by `createForkGenesisBlock` and the local-mode difficulty override. |
| `STARTING_DIFFICULTY` | `0000007f…ff` | `src/block.ts:58` | Live-chain initial difficulty and the maximum target (easiest allowed) the retarget will clamp to. |
| `DIFFICULTY_ADJUSTMENT_INTERVAL` | `10` | `src/block.ts:62` | Retarget every 10 blocks. |
| `TARGET_BLOCK_TIME_MS` | `600000` (10 min) | `src/block.ts:65` | Desired spacing per block; the retarget aims for `INTERVAL × TARGET_BLOCK_TIME_MS` per window. |
| `MAX_BLOCK_SIZE` | `1_000_000` (1 MB) | `src/block.ts:68` | Upper bound on serialized block size. |
| `MAX_BLOCK_TRANSACTIONS` | `10_000` | `src/block.ts:71` | First-line cheap cap checked before merkle/size work. |
| `MAX_FUTURE_BLOCK_TIME_MS` | `7200000` (2 h) | `src/block.ts:74` | A block timestamp may not exceed `now + 2h`. |
| `MEDIAN_TIME_SPAN` | `11` | `src/block.ts:77` (module-private) | Number of past blocks for median-time-past; a block must be `> medianTimestamp`. |
| `BLOCK_HEADER_SIZE` | `112` | `src/block.ts:80` (module-private) | version(4)+prevHash(32)+merkleRoot(32)+timestamp(8)+target(32)+nonce(4); the fixed base of size estimation. |

### INITIAL_TARGET vs STARTING_DIFFICULTY

These two are easy to confuse. `INITIAL_TARGET` is the **genesis** target — intentionally easy so the fork genesis block (which only commits the snapshot merkle root) mines fast. It is also assigned to `node.chain.difficulty` in the daemon's local/simulation path (`src/qbtcd.ts:315`). `STARTING_DIFFICULTY` is the **live chain's** opening difficulty and doubles as the retarget's `maxTarget` ceiling: `adjustDifficulty` (`src/chain.ts:270`) never lets the target get easier than `STARTING_DIFFICULTY` (`src/chain.ts:291`). On a fresh genesis-only chain the difficulty is reset to `STARTING_DIFFICULTY` (`src/chain.ts:517`).

### Difficulty retarget mechanics

`adjustDifficulty` runs whenever `height % DIFFICULTY_ADJUSTMENT_INTERVAL === 0` (`src/chain.ts:85`, `src/chain.ts:197`, `src/chain.ts:525`). It compares the actual time spanned by the last `DIFFICULTY_ADJUSTMENT_INTERVAL` blocks against the expected `INTERVAL × TARGET_BLOCK_TIME_MS` and scales the target accordingly, clamped to `STARTING_DIFFICULTY` as the easiest target. See [MINING-LIFECYCLE](./MINING-LIFECYCLE.md) and [BLOCK-VALIDATION](./BLOCK-VALIDATION.md) for the full retarget and MTP rules.

## Transaction-level parameters (`src/transaction.ts`)

These govern spendability, dust, supply, and per-transaction structural limits. Enforced in `validateTransaction` and coinbase/claim checks.

| Constant | Value | Defined | Meaning |
|---|---|---|---|
| `COINBASE_MATURITY` | `100` | `src/transaction.ts:63` | A coinbase UTXO cannot be spent until 100 blocks are mined on top. |
| `CLAIM_MATURITY` | `10` | `src/transaction.ts:66` | A claim UTXO cannot be spent until 10 blocks are mined on top. |
| `DUST_THRESHOLD` | `546` | `src/transaction.ts:69` | Minimum non-coinbase output amount in satoshis. |
| `MAX_MONEY` | `2_100_000_000_000_000` | `src/transaction.ts:72` | 21M QBTC ceiling (1 QBTC = 100,000,000 sat). |
| `MAX_TX_INPUTS` | `1000` | `src/transaction.ts:75` | Caps ML-DSA-65 verification loops per tx (DoS bound). |
| `MAX_TX_OUTPUTS` | `1000` | `src/transaction.ts:78` | Caps output loops per tx (DoS bound). |
| `HALVING_INTERVAL` | `210_000` | `src/transaction.ts:82` | Blocks between subsidy halvings. |
| `INITIAL_SUBSIDY` | `312_500_000` | `src/transaction.ts:89` (module-private) | 3.125 QBTC, matching BTC's post-4th-halving subsidy. |

### Maturity semantics

`COINBASE_MATURITY` (100) and `CLAIM_MATURITY` (10) are separate on purpose. Coinbase outputs follow Bitcoin's 100-block rule to protect against reorg-induced double-spends of freshly minted coins. Claim outputs — coins migrated from a pre-fork BTC address — use a shorter 10-block lock because they represent already-existing value being re-anchored, not new issuance, and the shorter window improves migration UX. Both are checked at spend time using the UTXO's `height` field against the current tip height.

### Emission schedule

`blockSubsidy(height)` (`src/transaction.ts:91`) computes the reward as `INITIAL_SUBSIDY >> halvings`, where `halvings = floor(height / HALVING_INTERVAL)`. It throws `RangeError` for negative heights and returns `0` once `halvings >= 26` (`src/transaction.ts:94`), after which mining yields fee-only blocks. The full issuance picture — including that the genesis block carries no premine and snapshot claims are a separate, capped issuance path — is in [SUPPLY-AND-EMISSION](./SUPPLY-AND-EMISSION.md).

## Reorg parameter (`src/chain.ts`)

| Constant | Value | Defined | Meaning |
|---|---|---|---|
| `MAX_REORG_DEPTH` | `100` | `src/chain.ts:28` | Bound on the in-memory undo journal; older undo entries are pruned. |

`MAX_REORG_DEPTH` is not a consensus rule about what reorgs are *legal* — it is a memory bound on the `BlockUndo` journal. When `undoData.length > MAX_REORG_DEPTH`, the oldest entries are spliced off (`src/chain.ts:182`–`src/chain.ts:185`). A reorg deeper than the retained journal falls back to a full `resetToHeight` replay instead of a fast incremental undo. See [REORG-UNDO](./REORG-UNDO.md) for the fast-vs-slow path and journal mechanics.

## Invariants

These must hold for the protocol to stay self-consistent. Breaking any of them is a hard fork.

- **Difficulty is bounded by `STARTING_DIFFICULTY`.** The retarget may make blocks harder (smaller target) without limit but never easier than `STARTING_DIFFICULTY`. A target value easier than this ceiling is invalid on the live chain.
- **Timestamps are sandwiched.** A block must be strictly greater than the median of the last `MEDIAN_TIME_SPAN` blocks and no greater than `now + MAX_FUTURE_BLOCK_TIME_MS`. The lower bound prevents timestamp-stalling the retarget; the upper bound prevents future-dating to inflate the time window.
- **Size is checked twice, cheap first.** `MAX_BLOCK_TRANSACTIONS` is a count gate evaluated before the byte-accurate `MAX_BLOCK_SIZE` check so a transaction-flood block is rejected without paying for merkle/serialization work.
- **Maturity gates spendability, not validity.** A transaction spending an immature coinbase/claim UTXO is rejected at validation time, but the UTXO still exists; it simply isn't spendable until `tip.height - utxo.height >= MATURITY`.
- **No output below dust except coinbase.** Every non-coinbase output must be `>= DUST_THRESHOLD`; the coinbase is exempt so zero/odd subsidy edge cases (e.g. post-final-halving fee-only blocks) remain valid.
- **Supply never exceeds `MAX_MONEY`.** The coinbase amount is capped at `blockSubsidy(height) + fees`, and `blockSubsidy` decays to `0`, so cumulative issuance asymptotically approaches but never crosses 21M QBTC.
- **Per-tx structural limits are DoS bounds, not economic ones.** `MAX_TX_INPUTS` / `MAX_TX_OUTPUTS` exist to cap the cost of ML-DSA-65 verification and output iteration on untrusted transactions, independent of any fee or value rule.

## Edge cases

- **Final halving.** At `halvings >= 26` the subsidy is exactly `0`; coinbase value then equals collected fees only. A block with no fees produces a coinbase output of `0`, which is valid because coinbase outputs are dust-exempt.
- **Genesis target override.** In local/simulation mode the daemon assigns `INITIAL_TARGET` directly (`src/qbtcd.ts:315`), bypassing `STARTING_DIFFICULTY`. This is intentional for fast local mining and must never be used on the production chain.
- **Reorg deeper than the journal.** When a competing chain forks below the retained `MAX_REORG_DEPTH` window, the incremental undo path is unavailable and the node replays from a checkpoint via `resetToHeight`. Correctness is preserved; only performance differs.
- **Negative height.** `blockSubsidy(-1)` throws `RangeError` rather than returning a value, guarding against off-by-one callers.

## Cross-references

- [BLOCK-VALIDATION](./BLOCK-VALIDATION.md) — where `MAX_BLOCK_SIZE`, `MAX_BLOCK_TRANSACTIONS`, `MAX_FUTURE_BLOCK_TIME_MS`, `MEDIAN_TIME_SPAN`, and the target checks are enforced in `validateBlock` / `addBlock`.
- [MINING-LIFECYCLE](./MINING-LIFECYCLE.md) — how `DIFFICULTY_ADJUSTMENT_INTERVAL`, `TARGET_BLOCK_TIME_MS`, and `STARTING_DIFFICULTY` drive candidate assembly and retargeting.
- [SUPPLY-AND-EMISSION](./SUPPLY-AND-EMISSION.md) — the full `blockSubsidy` / `HALVING_INTERVAL` / `MAX_MONEY` emission model and the no-premine genesis.
- [TRANSACTION-ANATOMY](./TRANSACTION-ANATOMY.md) — how `COINBASE_MATURITY`, `CLAIM_MATURITY`, `DUST_THRESHOLD`, and the per-tx input/output caps are applied in `validateTransaction`.
- [REORG-UNDO](./REORG-UNDO.md) — `MAX_REORG_DEPTH`, the undo journal, and fast-vs-slow reorg handling.
- [DOS-HARDENING](./DOS-HARDENING.md) — the protective request/message/storage limits that complement these consensus constants.
