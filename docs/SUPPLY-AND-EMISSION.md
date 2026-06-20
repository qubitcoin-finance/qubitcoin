# Supply and Emission

This doc explains where QBTC coins come from and the rules that cap the money supply; read it when reasoning about total supply, the snapshot "premine", mining rewards, the halving schedule, or the `Coinbase amount … exceeds max reward` / `exceeds maximum money supply` validation errors.

QBTC has exactly two issuance paths and no genesis premine. The fork genesis block mints **zero** coins — it only commits to a Bitcoin UTXO snapshot. From there, supply enters circulation two ways: **claims**, where a Bitcoin holder mints QBTC 1:1 against their snapshot balance, and **mining subsidy**, where each block's coinbase pays `blockSubsidy(height) + fees`. Both paths are bounded by the same `MAX_MONEY` ceiling enforced per transaction. The relevant constants live in `src/transaction.ts`; the issuance logic is split across `src/block.ts` (genesis + coinbase validation), `src/claim.ts` (claim minting), `src/miner.ts` (coinbase assembly), and `src/chain.ts` (double-claim ledger).

## Why It Exists

A post-quantum fork of Bitcoin needs an initial distribution that mirrors Bitcoin's existing ownership without literally copying the UTXO set into a quantum-vulnerable chain at genesis. Pre-creating ~58M snapshot balances as spendable UTXOs in the genesis block would (a) make every Bitcoin holder's coins immediately movable by whoever first forges an ML-DSA key for that address, and (b) bloat genesis to an unusable size.

The design instead makes supply **lazy**: the snapshot is a commitment (a merkle root embedded in the genesis coinbase), and coins are only minted when their rightful owner proves control of the BTC key and submits a claim. Until claimed, those coins do not exist in the UTXO set, are not counted in any balance, and cannot be double-spent. Mining issuance is layered on top with Bitcoin-style halving so the long-run inflation schedule is predictable.

## Key Files

| Path | Role |
| --- | --- |
| `src/transaction.ts:72` | `MAX_MONEY = 2_100_000_000_000_000` — 21M QBTC hard cap in satoshis. |
| `src/transaction.ts:82` | `HALVING_INTERVAL = 210_000` blocks between subsidy halvings. |
| `src/transaction.ts:89` | `INITIAL_SUBSIDY = 312_500_000` sat (3.125 QBTC) starting block reward. |
| `src/transaction.ts:91` | `blockSubsidy(height)` — halving curve, returns 0 after 26 halvings. |
| `src/transaction.ts:173` | `createCoinbaseTransaction` — output amount is `blockSubsidy(height) + fees`. |
| `src/block.ts:229` | `createForkGenesisBlock` — genesis coinbase pays a burn address `amount: 0`. |
| `src/block.ts:448` | Coinbase reward ceiling check: `coinbaseAmount > blockSubsidy(height) + totalFees`. |
| `src/claim.ts:441` | `verifyClaimProof` — claim output must equal `entry.amount` exactly. |
| `src/chain.ts:50` | `claimedBtcAddresses` set — the spent-claim ledger. |
| `src/chain.ts:168` | Per-block double-claim rejection against `claimedBtcAddresses`. |

## Path 1 — Snapshot Claims (the lazy premine)

The snapshot is a list of `{ btcAddress, amount, type? }` entries (`BtcAddressBalance` in `src/snapshot.ts`), where `amount` is the total satoshis controlled by that Bitcoin address at the fork height. `computeSnapshotMerkleRoot` reduces the whole list to one root, and `createForkGenesisBlock` (`src/block.ts:229`) embeds it in the genesis coinbase as the commitment string `QBTC_FORK:<btcHeight>:<btcBlockHash>:<merkleRoot>`.

Crucially, the genesis coinbase output is `{ address: burnAddress, amount: 0 }` — **no coins are created at genesis**. The snapshot is a reservation table, not a balance table.

A claim mints supply on demand. The claim builders in `src/claim.ts` (`createClaimTransaction`, `createP2wshClaimTransaction`, `createP2shMultisigClaimTransaction`) each produce a transaction with a single output `{ address: qbtcWallet.address, amount: entry.amount }` and a sentinel `CLAIM_TXID` input. `verifyClaimProof` (`src/claim.ts:312`) enforces that the BTC ownership proof is valid **and** that `tx.outputs.length === 1 && tx.outputs[0].amount === entry.amount` (`src/claim.ts:441`). You cannot claim more — or fewer — coins than the snapshot recorded for that address.

### One claim per address

The chain keeps a `claimedBtcAddresses` set (`src/chain.ts:50`). `addBlock` rejects any block containing a claim for an address already in that set, and rejects duplicate claims **within** a single block, raising `double-claim of <claimKey>` (`src/chain.ts:168`, `src/chain.ts:394`). Successfully connected claims add their address to the set (`src/chain.ts:625`); a reorg that disconnects past the claim clears and rebuilds the set (`src/chain.ts:514`). This guarantees each snapshot entry can mint its balance at most once across the whole chain history.

Claimed coins are not immediately spendable: claim outputs carry `isClaim` and are locked for `CLAIM_MATURITY = 10` blocks (`src/transaction.ts:66`), mirroring coinbase maturity. See [CLAIM-FLOW.md](./CLAIM-FLOW.md) and [SNAPSHOT-PIPELINE.md](./SNAPSHOT-PIPELINE.md) for proof construction and snapshot indexing.

## Path 2 — Mining Subsidy

Every block's coinbase is the second issuance path. `createCoinbaseTransaction` (`src/transaction.ts:173`) sets the single output to `blockSubsidy(blockHeight) + fees`, where `fees` is the sum of `calculateFee` over the block's non-coinbase transactions (`src/miner.ts` assembles `totalFees` during candidate building).

`blockSubsidy(height)` (`src/transaction.ts:91`) implements the halving curve:

```text
halvings   = floor(height / 210_000)
subsidy    = floor(312_500_000 / 2^halvings)   // satoshis
if halvings >= 26: subsidy = 0
```

The starting reward is 3.125 QBTC (312,500,000 sat), deliberately matching Bitcoin's post-4th-halving subsidy rather than its original 50 BTC — QBTC begins emission as if continuing Bitcoin's schedule. After 26 halvings the subsidy floors to zero and miners earn only transaction fees.

Note that mining issuance is a **ceiling, not a fixed payout**: block validation (`src/block.ts:448`) rejects a coinbase whose total output exceeds `blockSubsidy(height) + totalFees`, but a miner is free to claim less. Fees are recycled rather than burned, so they do not add to net new supply.

## The MAX_MONEY ceiling

`MAX_MONEY = 2_100_000_000_000_000` sat (21M QBTC) is the absolute supply bound, identical to Bitcoin. It is enforced structurally inside `validateTransaction` (`src/transaction.ts`): any single output greater than `MAX_MONEY` is rejected (`src/transaction.ts:306`), and both total input and total output sums are bounded (`src/transaction.ts:369`, `src/transaction.ts:375`). Because claim amounts come verbatim from the snapshot and subsidy is capped by the halving curve, the two issuance paths together cannot push circulating supply past this ceiling.

## Invariants and edge cases

- **No genesis premine.** `createForkGenesisBlock` always outputs `amount: 0` to the burn address. Any code or test that assumes spendable balances exist at height 0 is wrong; balances appear only after claims confirm.
- **Claim amount is exact.** `verifyClaimProof` requires `outputs.length === 1` and `outputs[0].amount === entry.amount`. Splitting a claim into multiple outputs, or adjusting the amount for a fee, is invalid — claims carry no fee and use the `CLAIM_TXID` sentinel input.
- **One mint per BTC address, chain-wide.** The `claimedBtcAddresses` ledger is authoritative and reorg-aware. Disconnecting blocks below a claim un-reserves the address.
- **Subsidy is a maximum.** Over-paying coinbase fails validation; under-paying is permitted and silently reduces supply.
- **Halving is integer-floored.** `floor(INITIAL_SUBSIDY / 2^halvings)` means the subsidy reaches sub-satoshi values and is treated as 0 well before the explicit `halvings >= 26` cutoff; the cutoff is a defensive guard, not the first zero.
- **Fees never inflate supply.** Coinbase pays `subsidy + fees`; the fees were already in circulation, so only `subsidy` is net new issuance.

## Cross-references

- [TRANSACTION-ANATOMY.md](./TRANSACTION-ANATOMY.md) — coinbase/claim transaction structure, `calculateFee`, dust and amount validation.
- [CLAIM-FLOW.md](./CLAIM-FLOW.md) — BTC ownership proofs and the end-to-end claim path.
- [SNAPSHOT-PIPELINE.md](./SNAPSHOT-PIPELINE.md) — how the snapshot NDJSON becomes the merkle commitment and the O(1) claim index.
- [MINING-LIFECYCLE.md](./MINING-LIFECYCLE.md) — coinbase assembly, difficulty retargeting, and block production timing.
- [BLOCK-VALIDATION.md](./BLOCK-VALIDATION.md) — where the coinbase reward ceiling and claim checks run during `addBlock`.
- [REORG-UNDO.md](./REORG-UNDO.md) — how the claim ledger is rebuilt when blocks disconnect.
