# BTC → QBTC Claim Flow

How a Bitcoin holder proves ECDSA ownership of a snapshotted BTC address and mints the matching post-quantum (ML-DSA-65) UTXO on the QubitCoin chain. Read this when working on claim construction, the `verifyClaimProof` validator, the BTC snapshot index, double-claim prevention, claim maturity, or any supported BTC claim path (P2PKH/P2PK/P2WPKH, P2SH-P2WPKH, P2TR, P2WSH, bare/P2SH multisig). Key symbols: `createClaimTransaction`, `verifyClaimProof`, `serializeClaimMessage`, `CLAIM_TXID`, `CLAIM_MATURITY`, `claimedBtcAddresses`, `getSnapshotIndex`.

## Why it exists

QubitCoin mints no coins at genesis. Instead, the genesis block commits to a Bitcoin UTXO-set snapshot (`BtcSnapshot`), and every pre-fork BTC balance becomes claimable. A holder claims by signing a structured message with the *original* Bitcoin key — ECDSA secp256k1 for legacy/SegWit-v0 addresses, Schnorr (BIP340) for Taproot — and receives a native QBTC output locked to a quantum-safe ML-DSA-65 address. The proof is one-shot: it transfers value from the immutable BTC snapshot into the live UTXO set without ever importing the BTC private key into QubitCoin's signing path.

Two problems shape the design:

1. **Replay and cross-fork safety.** A signature over a bare address could be lifted onto another fork or another destination. The signed message binds the BTC address, the destination QBTC address, the snapshot block hash, and the genesis hash together.
2. **Address-type sprawl.** Bitcoin balances live behind multiple script templates. Each needs its own ownership check, but all funnel through one `ClaimData` envelope and one validator.

## Key files

| Symbol | Location | Role |
|---|---|---|
| `serializeClaimMessage` | `src/claim.ts:38` | Builds + double-SHA256s the canonical signed message |
| `createClaimTransaction` | `src/claim.ts:53` | Single-key claim (P2PKH/P2PK/P2WPKH/P2SH-P2WPKH ECDSA, P2TR Schnorr) |
| `createP2wshClaimTransaction` | `src/claim.ts:122` | P2WSH script claim (m-of-n ECDSA) |
| `createP2shMultisigClaimTransaction` | `src/claim.ts:185` | P2SH multisig claim (redeem script) |
| `verifyClaimProof` | `src/claim.ts:312` | The consensus validator — dispatches on `entry.type` |
| `verifyMultisig` / `verifyParsedScript` | `src/claim.ts:248` / `:280` | Ordered CHECKMULTISIG-style signature checks |
| `BtcAddressBalance` / `BtcSnapshot` | `src/snapshot.ts:24` / `:30` | Snapshot entry + header (`btcBlockHash`) |
| `getSnapshotIndex` | `src/snapshot.ts:91` | WeakMap-cached `Map<btcAddress, entry>` for O(1) lookup |
| `CLAIM_TXID` | `src/transaction.ts:81` | 64×`'c'` sentinel input (mirrors `COINBASE_TXID`) |
| `CLAIM_MATURITY` | `src/transaction.ts:66` | Claim outputs locked for 10 blocks |
| `claimedBtcAddresses` | `src/chain.ts:50` | In-memory `Set` of spent BTC addresses |

## How it works

A claim transaction has no real inputs. Its sole input references the `CLAIM_TXID` sentinel (just as a coinbase references `COINBASE_TXID`), and it carries a `claimData` envelope instead of input signatures. The proof material lives entirely in `claimData`.

```text
holder's BTC key ──sign──> claimData ──┐
                                       ├─> Transaction { input: CLAIM_TXID, output: QBTC addr }
snapshot entry (amount, type) ─────────┘
                                       │
   block.ts  : structural checks (sentinel input, 1 output, dust, integer amount)
   chain.ts  : verifyClaimProof + double-claim check, then mint UTXO
```

### The signed message

`serializeClaimMessage` produces `doubleSha256("QBTC_CLAIM:<btcAddress>:<qbtcAddress>:<snapshotBlockHash>:<genesisHash>")`. All four fields are load-bearing: the BTC address and QBTC address bind source to destination, while the snapshot hash and genesis hash provide replay protection against other forks and other snapshots. The validator recomputes this exact hash from `snapshot.btcBlockHash` and `this.blocks[0].hash` (genesis) — the claimer cannot substitute their own values.

### Construction (creators in `claim.ts`)

`createClaimTransaction` branches on `entry.type`. For `p2tr` it Schnorr-signs and populates `schnorrPublicKey` (32-byte x-only) + `schnorrSignature` (64-byte BIP340), leaving the ECDSA fields empty. For everything else it ECDSA-signs and populates `ecdsaPublicKey` + `ecdsaSignature`. The script-based creators (`createP2wshClaimTransaction`, `createP2shMultisigClaimTransaction`) take ordered signer keys, locally re-derive the address from the script (`deriveP2wshAddress` / `deriveP2shMultisigAddress`) and throw if it doesn't match `entry.btcAddress`, then concatenate each signer's 64-byte ECDSA signature into `witnessSignatures`.

### Validation (`verifyClaimProof`)

The validator is the single consensus authority for claim correctness. It:

1. Looks up `claim.btcAddress` via `getSnapshotIndex` (O(1)); absent → reject.
2. Recomputes the claim message hash from trusted snapshot/genesis values.
3. Dispatches on `entry.type`:
   - **`p2wsh` / `multisig`** — `deriveP2wshAddress(witnessScript)` must equal the address; `parseWitnessScript` yields single-key or m-of-n; `verifyParsedScript` runs ordered CHECKMULTISIG verification.
   - **`p2tr`** — `computeTaprootOutputKey(schnorrPublicKey)` must equal the address (tweaked output key), then `verifySchnorrSignature`.
   - **`p2sh`** — if `witnessScript` is present it's P2SH multisig (`deriveP2shMultisigAddress`); otherwise P2SH-P2WPKH (`deriveP2shP2wpkhAddress` over the ECDSA pubkey).
   - **default (P2PKH/P2PK/P2WPKH)** — `hash160(ecdsaPublicKey)` must equal the snapshot keyhash, then `verifyEcdsaSignature`.
4. Confirms exactly one output, `amount === entry.amount`, and the output address equals `claim.qbtcAddress`.

### Where validation runs

`verifyClaimProof` is invoked in three places, all passing `this.blocks[0].hash` as the genesis hash:

- `chain.ts:172` — when applying a block to the active tip.
- `chain.ts:398` — during fork/reorg re-application (using a local `tempClaimed` set so a fork can't double-claim within its own branch).
- `mempool.ts:99` — on admission, gated by `MAX_CLAIM_COUNT = 5000` pending claims.

`block.ts:411` performs only *structural* validation (sentinel input, single output, dust threshold, integer amount); it deliberately does **not** check the ECDSA/Schnorr proof — that is the chain's job, because only the chain holds the snapshot and the claimed-address set.

### Minting and unminting

On apply (`chain.ts:625`), the chain adds `claim.btcAddress` to `claimedBtcAddresses`, records it in the block's `undo.claimedAddresses`, bumps `claimedCount`/`claimedAmount`, and creates the new UTXO flagged `isClaim: true`. On disconnect (`chain.ts:715`) the undo record removes the address from the set and decrements the counters, so a reorg cleanly releases the claim for re-claiming on the winning branch.

## Invariants and edge cases

- **One claim per BTC address, ever (per branch).** `claimedBtcAddresses` (active chain) and `tempClaimed` (fork re-apply) both reject a second claim of the same address. The set is rebuilt from disk on replay; it is not persisted separately.
- **Amount is exact, not partial.** A claim must spend the entire snapshot balance for the address — `tx.outputs[0].amount !== entry.amount` is rejected. There is no partial-claim path.
- **Claim outputs are time-locked.** `CLAIM_MATURITY = 10`: a claim UTXO cannot be spent until 10 blocks deep (`transaction.ts:349`), protecting against reorg-driven double-spends of freshly minted coins.
- **Genesis/snapshot binding is mandatory at consensus time.** Although the creators default `genesisHash` to `''`, every consensus call site passes the real genesis hash; a signature made for a different genesis or snapshot will not verify.
- **Multisig signature order matters.** `verifyMultisig` walks pubkeys in script order matching signatures in order (Bitcoin OP_CHECKMULTISIG semantics). Signatures supplied out of order can fail even when m valid signatures exist. The byte length must be exactly `m * 64`.
- **Schnorr keys are x-only.** A P2TR claim requires a 32-byte `schnorrPublicKey` and 64-byte `schnorrSignature`; the validator checks the *tweaked* output key against the address, not the internal key directly.
- **`getSnapshotIndex` is WeakMap-cached.** Mutating a `BtcSnapshot` object in place after first index build will not refresh the cached index — treat snapshots as immutable.

## Cross-references

- [RPC.md](./RPC.md) — claim stats are surfaced through `/api/v1/claims/stats`; proxy-trust and rate-limit notes for the RPC layer.
- [BRIDGE.md](./BRIDGE.md) — the design-only ZK bridge that wraps native QBTC (claimed or mined) as an ERC-20 on Base; complements the inbound claim path with an outbound one.
