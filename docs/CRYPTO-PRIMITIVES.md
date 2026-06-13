# Crypto Primitives Map

This doc is the reference for `src/crypto.ts` — the single module that owns every cryptographic primitive in qbtc: the post-quantum ML-DSA-65 signature scheme used for native consensus, the legacy secp256k1 ECDSA/Schnorr scheme used only to prove ownership of pre-fork Bitcoin coins, the SHA-256/RIPEMD-160 hash helpers, the little-endian integer encoders, and the five Bitcoin address-derivation algorithms (`deriveP2shP2wpkhAddress`, `deriveP2trAddress`, `deriveP2wshAddress`, `deriveP2shMultisigAddress`, plus the native `deriveAddress`). Read this when you need to know which signing function to call, what byte sizes to expect, how `buildMultisigScript`/`parseWitnessScript` encode scripts, or why two completely separate signature systems coexist. For how these primitives are wired into validation, see the cross-references at the bottom — this page documents the primitives themselves, not the flows.

## Why it exists

qbtc is a post-quantum Bitcoin fork. It runs **two cryptographic worlds side by side**, and `crypto.ts` is the boundary between them:

1. **Native consensus crypto.** Every qbtc transaction, address, and block is secured by **ML-DSA-65** (Dilithium, FIPS 204) from `@noble/post-quantum`. This is the quantum-resistant scheme that replaces Bitcoin's ECDSA. A qbtc address is just `SHA-256(ML-DSA-65 public key)`.

2. **Claim crypto (legacy, read-only).** To migrate value, a holder of a pre-fork BTC UTXO proves ownership using the **original secp256k1 keys** — ECDSA for legacy/segwit scripts, Schnorr (BIP340) for Taproot. These keys never secure qbtc state; they exist only so `claim.ts` can verify "you controlled this BTC address in the snapshot." Once verified, the claimed coins live under an ML-DSA-65 address.

Keeping both schemes behind one module enforces project convention #4 ("all `ml-dsa` operations go through `src/crypto.ts`; do not call `@noble/post-quantum` directly from business logic") and means consumers like `transaction.ts`, `block.ts`, `claim.ts`, and `snapshot.ts` import named helpers instead of raw curve/lattice libraries.

## Key files

All symbols below live in `src/crypto.ts` unless noted.

| Symbol | Line | Purpose |
|---|---|---|
| `Wallet` interface | 12 | `{ publicKey (1,952 B), secretKey (4,032 B), address (64-hex) }` |
| `doubleSha256` / `doubleSha256Hex` | 19 / 24 | Bitcoin's `SHA256(SHA256(x))`, bytes or hex |
| `deriveAddress` | 29 | Native qbtc address = `SHA-256(pubkey)` as hex |
| `generateWallet` | 34 | New ML-DSA-65 keypair + derived address |
| `signData` / `verifySignature` | 44 / 49 | ML-DSA-65 sign / verify |
| `uint32LE` / `uint64LE` | 58 / 66 | Little-endian integer encoders |
| `hash160` | 75 | `RIPEMD160(SHA256(x))` — Bitcoin address hash |
| `deriveP2shP2wpkhAddress` | 80 | `HASH160(0x0014 ‖ HASH160(pubkey))` |
| `generateBtcKeypair` | 87 | secp256k1 keypair, 33-byte compressed pubkey |
| `ecdsaSign` / `verifyEcdsaSignature` | 94 / 99 | ECDSA secp256k1 over a 32-byte msg hash |
| `schnorrSign` / `verifySchnorrSignature` | 108 / 113 | BIP340 Schnorr; verify swallows malformed input → `false` |
| `getSchnorrPublicKey` | 126 | 32-byte x-only pubkey |
| `computeTaprootOutputKey` | 135 | BIP341 key-path tweak: `Q = P + H("TapTweak",P)·G` |
| `deriveP2trAddress` | 146 | Hex of tweaked output key `Q` |
| `buildMultisigScript` | 154 | `OP_m ‖ [PUSH33 pk]×n ‖ OP_n ‖ OP_CHECKMULTISIG` |
| `parseWitnessScript` | 175 | Parse multisig or single-key witness script |
| `deriveP2wshAddress` | 212 | Hex of `SHA256(witnessScript)` |
| `deriveP2shMultisigAddress` | 217 | Hex of `HASH160(redeemScript)` |

Re-exports at lines 221–222: `bytesToHex`, `concatBytes`, `hexToBytes` (all from `@noble/hashes/utils.js`). Memory and consumers should import these from `crypto.ts`, not the upstream package.

## The two signature systems

### ML-DSA-65 (native, consensus-critical)

`generateWallet` calls `ml_dsa65.keygen()`. The sizes are large and worth memorizing because they drive transaction size limits and DoS bounds elsewhere:

```text
public key : 1,952 bytes
secret key : 4,032 bytes
signature  : 3,309 bytes
address    : SHA-256(pubkey) → 32 bytes → 64 hex chars
```

`signData(data, secretKey)` and `verifySignature(signature, data, publicKey)` are thin wrappers over `ml_dsa65.sign`/`verify`. They sign **raw data**, not a pre-hash — the caller (`transaction.ts`) decides what bytes constitute the signing payload via `serializeForSigning`. Because each verify is expensive, `transaction.ts` caps inputs per transaction to bound the ML-DSA verification loop (see its `MAX_*_INPUTS` constant near line 74).

### secp256k1 ECDSA + Schnorr (claims only)

`generateBtcKeypair` produces a **compressed 33-byte** public key (`secp256k1.getPublicKey(sk, true)`). ECDSA functions sign/verify a **32-byte message hash** — the caller must hash first. `verifyEcdsaSignature` is used by `claim.ts` and `block.ts` to check the ECDSA ownership proof attached to a claim transaction.

Schnorr (`schnorrSign`/`verifySchnorrSignature`) follows BIP340 and operates on 32-byte x-only public keys via `getSchnorrPublicKey`. Crucially, `verifySchnorrSignature` wraps `schnorr.verify` in `try/catch` and returns `false` on any structural error, so consensus code can treat "malformed signature" and "invalid signature" identically without a thrown exception escaping into validation.

## Address derivation algorithms

qbtc must recognize the address an old BTC key would have produced so a claimant can prove ownership of the right snapshot entry. Each derivation below reproduces a specific Bitcoin output type as a **bare hex string** (no Base58/Bech32 — the snapshot stores raw hashes).

### Native qbtc

`deriveAddress(pubkey)` = `bytesToHex(SHA256(pubkey))`. Note this is a **single** SHA-256, not `hash160` and not double-SHA — qbtc addresses are pure post-quantum and don't reuse Bitcoin's RIPEMD step.

### P2SH-P2WPKH (nested segwit)

`deriveP2shP2wpkhAddress(compressedPubKey)` computes `HASH160(0x0014 ‖ HASH160(pubkey))`. The inner `HASH160(pubkey)` is the 20-byte witness program; prefixing `0x00 0x14` (`OP_0 PUSH20`) forms the 22-byte redeem script, whose `HASH160` is the P2SH address.

### P2TR (Taproot key-path)

`computeTaprootOutputKey(internalPubkey)` implements BIP341/BIP86: it lifts the x-only internal key `P` to a curve point, computes the tagged `TapTweak` hash `t`, and returns the x-only encoding of `Q = P + t·G`. `deriveP2trAddress` is just the hex of `Q`. Only the key-path (no script tree) is supported, which matches BIP86 wallet defaults.

### P2WSH and P2SH-multisig

`deriveP2wshAddress(script)` = hex of `SHA256(script)` (32-byte witness program). `deriveP2shMultisigAddress(script)` = hex of `HASH160(script)` (20-byte). The difference is exactly the Bitcoin distinction: native segwit v0 script-hash uses SHA-256, legacy P2SH uses HASH160.

## Witness script encoding

`buildMultisigScript(m, pubkeys)` emits a canonical `m`-of-`n` script: `OP_m` (`0x50 + m`), then each 33-byte compressed key prefixed with `0x21` (`PUSH33`), then `OP_n`, then `0xae` (`OP_CHECKMULTISIG`). It rejects `m < 1`, `m > n`, `n > 16`, and any pubkey not exactly 33 bytes — so callers can rely on a well-formed script or a thrown `Error`.

`parseWitnessScript(script)` is the inverse and tolerant of two shapes:

- **single-key**: exactly 35 bytes, `0x21 ‖ <33-byte pk> ‖ 0xac` (`PUSH33 … OP_CHECKSIG`) → `{ type: 'single-key', pubkey }`.
- **multisig**: `OP_m`, a run of `PUSH33`-prefixed keys, `OP_n`, `OP_CHECKMULTISIG` → `{ type: 'multisig', m, n, pubkeys }`.

It throws on truncated pubkeys, trailing data, missing `OP_CHECKMULTISIG`, a pubkey-count/`OP_n` mismatch, or `m > n`. This strictness is intentional: `claim.ts` feeds attacker-supplied witness scripts here during P2WSH/P2SH-multisig claim validation, so a loose parser would be a consensus hole.

## Hash and encoding helpers

`doubleSha256` is the workhorse: block hashing and Merkle-tree construction in `block.ts` (`computeMerkleRoot`, line 115) both call it, mirroring Bitcoin's `SHA256(SHA256(x))` and odd-leaf duplication. `doubleSha256Hex` returns the hex form for IDs.

`hash160` (`RIPEMD160(SHA256(x))`) backs the P2SH/P2WPKH derivations above.

`uint32LE` and `uint64LE` produce little-endian byte encodings used when serializing header/transaction fields for hashing and signing. `uint64LE` splits the value across two 32-bit writes to stay correct up to `Number.MAX_SAFE_INTEGER` (JavaScript `DataView` has no native 64-bit unsigned setter). Use these instead of hand-rolled `Buffer` math so serialization stays byte-identical across the signing, hashing, and storage boundaries.

## Invariants and edge cases

- **One module, one source of randomness.** All keypairs come from `generateWallet` / `generateBtcKeypair`. Do not call `ml_dsa65.keygen()` or `secp256k1.utils.randomSecretKey()` elsewhere.
- **ECDSA expects a pre-hashed 32-byte message; ML-DSA does not.** Passing raw data to `ecdsaSign` (or a pre-hash to `signData`) silently produces signatures that won't verify against the intended payload.
- **`verifySchnorrSignature` never throws.** Callers must treat its `false` as covering both "wrong signature" and "garbage bytes." The ECDSA verifier does *not* have this guard — `verifyEcdsaSignature` can throw on malformed input, so claim code wraps it where needed.
- **Address strings are bare hashes, not encoded addresses.** Every `derive*` function returns hex of a raw hash. Matching against the snapshot relies on the snapshot storing the same raw-hash form (see SNAPSHOT-PIPELINE).
- **`buildMultisigScript` and `parseWitnessScript` must round-trip.** Any change to opcode encoding (the `0x50 + m`, `0x21`, `0xae` bytes) breaks every previously derived P2WSH/P2SH-multisig address and silently invalidates claims. Treat the byte layout as frozen.
- **Compressed keys only for Bitcoin scripts.** Multisig and witness-script helpers assume 33-byte compressed pubkeys; uncompressed (65-byte) keys are rejected by `buildMultisigScript` and won't parse.

Tests for all of the above live in `src/__tests__/crypto.test.ts`.

## Cross-references

- [CLAIM-FLOW](./CLAIM-FLOW.md) — how `ecdsaSign`/`schnorrSign`/`parseWitnessScript` are assembled into ownership proofs and verified.
- [TRANSACTION-ANATOMY](./TRANSACTION-ANATOMY.md) — where `signData`/`verifySignature` and the ML-DSA byte sizes feed transaction construction and validation.
- [SNAPSHOT-PIPELINE](./SNAPSHOT-PIPELINE.md) — how derived address hashes are matched against BTC snapshot entries.
- [BLOCK-VALIDATION](./BLOCK-VALIDATION.md) — `doubleSha256` block hashing and the claim ECDSA gate inside `addBlock`.
- [BLOCK-STORAGE](./BLOCK-STORAGE.md) — the `sanitize`/serialization boundary that consumes `bytesToHex`/`hexToBytes`.
