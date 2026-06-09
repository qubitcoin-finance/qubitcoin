# Transaction Anatomy & Validation

How a qbtc transaction is built, hashed, signed, and validated — the `Transaction`/`UTXO`/`TransactionInput` types in `src/transaction.ts`, the sighash produced by `serializeForSigning`, the txid from `computeTxId`, ML-DSA-65 signing via `createTransaction`, and the rule-by-rule checks in `validateTransaction`/`calculateFee`. Read this when working on transaction construction, debugging "Invalid signature at input", "Transaction ID mismatch", "UTXO not found", "below dust threshold", "Coinbase UTXO not mature", or fee/subsidy math. This covers the single-transaction layer; mempool admission, claim proofs, and block-level checks are documented separately (see cross-references).

## Why it exists

qbtc has no Bitcoin Script. Ownership is purely address-based: an address is `SHA-256(ML-DSA-65 public key)` (`deriveAddress`, `src/crypto.ts:29`), and spending authority is proven by an ML-DSA-65 signature over the transaction's structural data rather than by satisfying a scriptPubKey. That design choice — post-quantum signatures instead of ECDSA + Script — drives every detail in `transaction.ts`: the signature and public-key fields are large (3,309 and 1,952 bytes), so input/output counts are capped to bound per-transaction verification cost, and the sighash deliberately excludes those big fields so the txid stays stable while signatures are attached.

The module is the canonical definition of "what a valid spend looks like." Mempool, miner, block validator, and chain replay all import the same `validateTransaction`/`calculateFee`/`blockSubsidy` helpers rather than re-implementing the rules, so consensus stays consistent across the admission path and the block-acceptance path.

## Key files

| Symbol | Location | Role |
|--------|----------|------|
| `Transaction` / `TransactionInput` / `TransactionOutput` | `src/transaction.ts:44`, `:21`, `:28` | On-the-wire and in-memory tx shape |
| `UTXO` | `src/transaction.ts:52` | Unspent output, with `height`/`isCoinbase`/`isClaim` provenance flags |
| `utxoKey` | `src/transaction.ts:99` | `"${txId}:${outputIndex}"` map key used everywhere |
| `serializeForSigning` | `src/transaction.ts:107` | Sighash: structural bytes only, no sigs/pubkeys |
| `computeTxId` | `src/transaction.ts:149` | `doubleSha256Hex` of the sighash |
| `createTransaction` | `src/transaction.ts:205` | Build + ML-DSA-sign a spend, fold dust change into fee |
| `createCoinbaseTransaction` | `src/transaction.ts:173` | Mining reward tx, height mixed into txid |
| `validateTransaction` | `src/transaction.ts:257` | Full stateless+UTXO rule check |
| `calculateFee` | `src/transaction.ts:398` | `inputs − outputs`; 0 for coinbase/claim |
| `blockSubsidy` | `src/transaction.ts:91` | Halving schedule, 3.125 QBTC start |

Consensus constants (`COINBASE_MATURITY=100`, `CLAIM_MATURITY=10`, `DUST_THRESHOLD=546`, `MAX_MONEY`, `MAX_TX_INPUTS`/`MAX_TX_OUTPUTS=1000`, `HALVING_INTERVAL=210_000`) are exported from `src/transaction.ts:63-82`.

## How it works

### The sighash and the txid

`serializeForSigning` walks the inputs as bare outpoints (`txId` + `outputIndex`), then the outputs (`address` + `amount` via `uint64LE`), then the `timestamp`, optionally the claim `btcAddress`/`qbtcAddress`, and optionally a `blockHeight`. It concatenates these with little-endian length prefixes into one `Uint8Array`. Critically it omits `publicKey` and `signature` — that is what lets a signature commit to the transaction without being part of it.

`computeTxId` is just `doubleSha256Hex(serializeForSigning(...))`. Because the sighash excludes witness-like data, the txid is fixed the moment inputs/outputs/timestamp are chosen, before any signing happens. `createTransaction` exploits this: it computes one sighash, signs it once per input, and computes the id from the same outpoints.

```text
inputs(outpoints) + outputs + timestamp [+ claim] [+ height]
        │
        ▼  concatBytes
   serializeForSigning  ──► sighash (Uint8Array)
        │                        │
        ▼ doubleSha256Hex        ▼ ml_dsa65.sign(sighash, secretKey)
   tx.id (64-hex)          per-input signature
```

### Building a spend

`createTransaction(wallet, utxos, recipients, fee)` sums inputs and outputs, derives `change = totalIn − totalOut − fee`, and throws "Insufficient funds" if negative. It builds output objects for each recipient, then appends a change output back to `wallet.address` **only if** `change >= DUST_THRESHOLD`; sub-dust change is silently absorbed into the fee rather than creating an invalid output. Every input is signed with the same sighash via `signData` (`ml_dsa65.sign`), so all inputs of a multi-input spend carry independent signatures over identical structural bytes.

### Coinbase specifics

`createCoinbaseTransaction` builds a single synthetic input with `txId = COINBASE_TXID` (64 zeros) and `outputIndex = 0xffffffff`; the input's `publicKey` field is repurposed to carry an optional miner message, and the signature is empty. The reward is `blockSubsidy(height) + fees`. Uniqueness across blocks is guaranteed by passing `blockHeight` into `computeTxId` — two empty coinbases at different heights hash differently because the height is folded into the sighash. `isCoinbase` recognizes the magic outpoint; `blockSubsidy` halves `INITIAL_SUBSIDY` (312,500,000 sat) every 210,000 blocks and returns 0 after 26 halvings.

### Validation rule order

`validateTransaction(tx, utxoSet, currentHeight?)` short-circuits for coinbase and claim transactions (`isCoinbase`/`isClaimTransaction` return `{valid:true}` — those are checked at block/chain level). For a normal tx it enforces, in order:

1. **Structure** — non-empty inputs/outputs, counts within `MAX_TX_INPUTS`/`MAX_TX_OUTPUTS`, finite positive `timestamp`.
2. **Outputs** — each address passes `isValidHash`, amount is a positive integer, at or above `DUST_THRESHOLD`, and not over `MAX_MONEY`.
3. **No duplicate inputs** — a `Set` of `utxoKey`s rejects spending the same outpoint twice within one tx.
4. **Per-input** — the referenced UTXO must exist in `utxoSet`; coinbase UTXOs need `currentHeight − utxo.height >= COINBASE_MATURITY`, claim UTXOs need `>= CLAIM_MATURITY`; `deriveAddress(input.publicKey)` must equal `utxo.address`; and `verifySignature(signature, sighash, publicKey)` must pass.
5. **Value conservation** — `totalIn` and `totalOut` each within `MAX_MONEY`, and `totalIn >= totalOut` (the difference is the fee).
6. **Txid integrity** — recomputed `computeTxId` must equal `tx.id`.

`calculateFee` re-derives `inputs − outputs` against the UTXO set and returns 0 for coinbase and claims (claims are fee-free). Inputs whose UTXO is missing contribute 0, so a fee is only meaningful for an already-validated tx.

## Invariants and edge cases

- **Maturity needs height context.** Coinbase/claim maturity is only enforced when `currentHeight` is supplied. The mempool passes `currentHeight` (`src/mempool.ts:119`), but `chain.ts:408` calls `validateTransaction(tx, tempUtxoSet)` without it during block connection because maturity for those paths is governed elsewhere — do not assume an undefined `currentHeight` means "mature."
- **Signature covers outputs, not the public key.** Since the pubkey is excluded from the sighash, the address-match check (`deriveAddress(input.publicKey) === utxo.address`) is what binds the signing key to the spent coin; without it a valid signature from any key would pass step 4. Both checks are required.
- **Dust folding changes the fee.** Because `createTransaction` drops sub-dust change into the fee, the actual fee paid can exceed the `fee` argument. Fee-density ordering in the mempool reflects the real on-chain difference, not the requested value.
- **`uint64LE` tops out at `Number.MAX_SAFE_INTEGER`.** Amounts are plain JS numbers; `MAX_MONEY` (2.1e15) stays well inside safe-integer range, which is why every output amount is range-checked against it.
- **Block-level checks are stricter.** `validateBlock` (`src/block.ts:437`) re-runs `validateTransaction` per tx, forbids intra-block double-spends, sums `calculateFee`, and rejects a coinbase whose total exceeds `blockSubsidy(height) + totalFees` (`src/block.ts:448`). A tx that passes `validateTransaction` can still be rejected in a block context.

## Cross-references

- [MEMPOOL-LIFECYCLE](./MEMPOOL-LIFECYCLE.md) — where `validateTransaction`/`calculateFee` gate admission and drive fee-density eviction.
- [MINING-LIFECYCLE](./MINING-LIFECYCLE.md) — how `createCoinbaseTransaction`/`blockSubsidy` feed candidate assembly and reward math.
- [CLAIM-FLOW](./CLAIM-FLOW.md) — the claim transactions that `validateTransaction` skips, including ECDSA/Schnorr ownership proofs.
- [BLOCK-STORAGE](./BLOCK-STORAGE.md) — the separate persistence serialization (`sanitize`/`deserializeTransaction`) distinct from the sighash here.
- [REORG-UNDO](./REORG-UNDO.md) — how applying/disconnecting blocks mutates the `utxoSet` these checks read.
