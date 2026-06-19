# BTC Script Coverage

How Bitcoin UTXO script templates become claimable snapshot entries, and why some exotic outputs are intentionally excluded. Read this when working on `parseDumptxoutset`, snapshot coverage stats, `coins.jsonl` filtering, website claim-count content, or questions like "why is this BTC script type not claimable?"

This page connects three boundaries that are easy to confuse: Bitcoin Core's `dumptxoutset` binary format, QubitCoin's compact snapshot NDJSON, and the later BTC ownership proof in `verifyClaimProof`. The snapshot converter includes standard key- and script-ownership templates: P2PKH, P2PK, P2WPKH, P2SH, P2TR, P2WSH, and bare multisig. It skips `OP_RETURN` and `other` scripts because they either are provably unspendable data outputs or do not expose a standard signature-based ownership path the claim validator can verify.

The current website copy records the production snapshot coverage for Bitcoin block `935,941`: `164,352,533` raw UTXOs parsed, `164,274,035` claimable coins after filtering, `58,001,652` unique snapshot addresses, and `19,984,411.38` QBTC claimable. Those numbers are user-facing content in `website/src/explorer-docs-claims.ts`; the implementation below explains how the code arrives at that shape.

## Why It Exists

The claim mechanism is deliberately not a Bitcoin Script interpreter. QubitCoin does not replay arbitrary Bitcoin spending conditions inside consensus. Instead, the snapshot pipeline extracts address hashes for templates whose ownership can later be proven with bounded cryptographic checks:

- A single public key and ECDSA signature for key-hash style entries.
- A Schnorr internal public key and BIP340 signature for Taproot key-path entries.
- A witness or redeem script plus ordered ECDSA signatures for P2WSH, P2SH multisig, and bare multisig.

That design gives BTC holders broad coverage without importing Bitcoin's full script VM or every historical non-standard script. The parser can recognize many script shapes, but the snapshot only includes types that can be reduced to a stable `btcAddress` hash and verified by `verifyClaimProof`.

The distinction matters operationally. A coin being absent from the snapshot is not a mempool bug and not an RPC lookup bug. It means `convert-snapshot` never emitted that UTXO into `coins.jsonl`, so it cannot become a `BtcAddressBalance`, cannot enter the snapshot merkle root, and cannot be claimed later by submitting a handcrafted transaction.

## Key Files

| Anchor | Role |
|---|---|
| `src/tools/parse-utxoset.ts:29` | `ScriptType` union: supported parser classifications plus skipped categories. |
| `src/tools/parse-utxoset.ts:248` | `readCompressedScript`, the compressed-script classifier. |
| `src/tools/parse-utxoset.ts:251` | P2PKH compressed script path: 20-byte HASH160 key hash. |
| `src/tools/parse-utxoset.ts:256` | P2SH compressed script path: 20-byte script hash. |
| `src/tools/parse-utxoset.ts:261` | P2PK compressed public-key path, normalized to HASH160(compressed pubkey). |
| `src/tools/parse-utxoset.ts:286` | P2WPKH raw witness program detection. |
| `src/tools/parse-utxoset.ts:290` | P2WSH raw witness program detection. |
| `src/tools/parse-utxoset.ts:294` | P2TR raw witness program detection. |
| `src/tools/parse-utxoset.ts:299` | `OP_RETURN` detection, classified but not claimable. |
| `src/tools/parse-utxoset.ts:305` | Bare multisig detection using trailing `OP_CHECKMULTISIG`. |
| `src/tools/convert-snapshot.ts:353` | Extract-phase allowlist of claimable `ScriptType` values. |
| `src/tools/convert-snapshot.ts:407` | Skipped-type summary printed after extraction. |
| `src/tools/convert-snapshot.ts:514` | Aggregation emits final entry `t` only for non-default snapshot types. |
| `src/tools/convert-snapshot.ts:548` | Aggregation counters for per-type snapshot stats. |
| `src/claim.ts:339` | P2WSH and bare multisig verification branch. |
| `src/claim.ts:363` | P2TR Schnorr verification branch. |
| `src/claim.ts:391` | P2SH branch for P2SH-P2WPKH or P2SH multisig. |
| `src/snapshot-loader.ts:63` | Header-aware snapshot normalization before deterministic genesis. |
| `website/src/explorer-docs-claims.ts:107` | User-facing snapshot coverage section and current production counts. |

## How It Works

### Parser Classification

`parseDumptxoutset` streams Bitcoin Core's `dumptxoutset` v2 file one coin at a time. It does not keep the UTXO set in memory. For each coin, `readCompressedScript` decodes Bitcoin Core's compressed script representation and returns a `ScriptType` plus an `addressHash` when a stable ownership hash exists.

Compressed script IDs are direct:

| Compressed form | Parser type | Snapshot address hash |
|---|---|---|
| `0x00` + 20 bytes | `p2pkh` | 20-byte HASH160 key hash. |
| `0x01` + 20 bytes | `p2sh` | 20-byte HASH160 script hash. |
| `0x02` / `0x03` + x-coordinate | `p2pk` | HASH160(compressed pubkey). |
| `0x04` / `0x05` + x-coordinate | `p2pk` | HASH160(recovered compressed pubkey). |

For raw scripts, the parser recognizes exact standard witness templates:

| Raw script shape | Parser type | Snapshot address hash |
|---|---|---|
| `OP_0 PUSH20 <20B>` | `p2wpkh` | 20-byte witness key hash. |
| `OP_0 PUSH32 <32B>` | `p2wsh` | 32-byte witness script hash. |
| `OP_1 PUSH32 <32B>` | `p2tr` | 32-byte Taproot output key. |
| `<m> <pubkeys...> <n> OP_CHECKMULTISIG` | `multisig` | SHA256(raw script). |

Two non-claimable parser outputs are still useful:

- `op_return` marks provably unspendable nulldata outputs.
- `other` preserves `rawScript` for analysis tooling but has no claim path.

### Snapshot Filtering

`runExtract` is the first policy gate. It writes a compact JSON line only when the parser type is claimable:

```text
claimable =
  p2pkh | p2wpkh | p2sh | p2tr | p2pk | p2wsh | multisig
```

Every emitted line has an address hash `a`, satoshi balance `b`, and original parser type `t`. Skipped entries are counted by parser type and total satoshis so operators can see what value was excluded without making the excluded outputs part of consensus state.

### Aggregation

`aggregateCoins` sorts `coins.jsonl` lexicographically by address, streams consecutive records into one balance per address, and writes `balances*.jsonl`. This is where per-UTXO snapshot entries become per-address claim entries.

The final snapshot does not preserve every parser type as a `type` field. Default single-key entries omit `t` in the final NDJSON:

| Extract type | Final snapshot `type` | Claim interpretation |
|---|---|---|
| `p2pkh` | absent | HASH160(pubkey) plus ECDSA signature. |
| `p2wpkh` | absent | Same HASH160(pubkey) proof as P2PKH. |
| `p2pk` | absent | Same HASH160(compressed pubkey) proof as key-hash entries. |
| `p2sh` | `p2sh` | Either P2SH-P2WPKH or P2SH multisig, depending on submitted script. |
| `p2tr` | `p2tr` | Taproot key-path Schnorr proof. |
| `p2wsh` | `p2wsh` | Script hash plus ordered ECDSA signatures. |
| `multisig` | `multisig` | Bare script hash plus ordered ECDSA signatures. |

The snapshot header records per-type coin counts (`p2pkhCoins`, `p2pkCoins`, `p2wpkhCoins`, `p2shCoins`, `p2trCoins`, `p2wshCoins`, `multisigCoins`) and total claimable satoshis. `loadSnapshot` then normalizes the NDJSON into `BtcAddressBalance` entries and the deterministic genesis path commits to the resulting merkle root.

### Claim Verification

After the snapshot exists, script coverage is enforced by `verifyClaimProof`, not by the converter alone:

```text
snapshot entry
  absent type  -> HASH160(ecdsaPublicKey) == btcAddress, then ECDSA
  p2sh         -> P2SH-P2WPKH if no script; P2SH multisig if script present
  p2tr         -> Taproot output-key derivation, then Schnorr
  p2wsh        -> SHA256(witnessScript), parse script, ordered ECDSA
  multisig     -> SHA256(script), parse script, ordered ECDSA
```

This split lets the converter stay streaming and mechanical while consensus remains strict. A malformed claim for a supported type is still rejected if the submitted public key, script hash, signature count, signature order, amount, or destination output does not match the snapshot and transaction data.

## Current Production Coverage

The website documentation currently publishes the production snapshot coverage from Bitcoin block `935,941`:

| Metric | Value |
|---|---:|
| Raw UTXOs parsed | `164,352,533` |
| Claimable UTXOs after filtering | `164,274,035` |
| Unique snapshot addresses | `58,001,652` |
| Total claimable | `19,984,411.38 QBTC` |
| Snapshot size | `~3.6 GB` NDJSON |
| Snapshot merkle root | `bb0b8c553aa5457e7680baebb35e00ab26d978e05a52c6840ec0b475f5bbdd08` |

Per-type UTXO counts in that content are:

| Type | Coins |
|---|---:|
| P2PKH | `45,115,135` |
| P2PK | `44,617` |
| P2WPKH | `46,947,641` |
| P2SH | `12,451,522` |
| P2TR | `54,668,563` |
| P2WSH | `2,489,881` |
| Bare multisig | `2,556,676` |

These values are not hard-coded into consensus. They document the current snapshot produced by the tooling and rendered in the explorer docs. A future snapshot created from a different Bitcoin block would have different counts and merkle root, but it would pass through the same parser, filtering, aggregation, and claim-verification rules.

## Excluded Outputs

The excluded set is whatever `parseDumptxoutset` returns as `op_return` or `other`. The current user-facing docs describe the excluded value as about `2,618 BTC` across `78,498` coins, with the largest bucket being burned P2PKH-like scripts that cannot be satisfied by any public key.

The important implementation rule is simpler than the category names: excluded scripts do not produce a supported `addressHash` plus verification path. Examples include:

- `OP_RETURN` data outputs, which are intentionally unspendable.
- malformed P2PKH-like scripts with an empty or wrong-size hash push.
- hash puzzles such as `OP_HASH256 <hash> OP_EQUAL`, where ownership is a preimage, not a key signature.
- future SegWit versions that the claim validator does not implement.
- padded or decorated non-standard scripts that would require general script execution to distinguish spendable from unspendable.

The converter prints skipped counts and value for transparency, but it does not put those outputs into the merkle-committed snapshot. That prevents a later claim from inventing a script-specific proof the node never committed to validating.

## Invariants And Edge Cases

- **No full Bitcoin Script VM.** If claimability would require executing arbitrary script, the output belongs outside the snapshot unless a bounded verifier is added in both converter and `verifyClaimProof`.
- **Bare multisig is claimable in current code.** The parser maps trailing-`OP_CHECKMULTISIG` raw scripts to `multisig`, the converter includes them, and the claim validator treats them like P2WSH with `SHA256(script)`.
- **P2SH is ambiguous by design.** The same snapshot `type: 'p2sh'` covers P2SH-P2WPKH and P2SH multisig. The claim payload disambiguates by including or omitting `witnessScript`.
- **P2PK becomes default single-key.** The parser hashes the compressed public key and the final snapshot omits `type`, so the claim path is the same ECDSA key-hash proof as P2PKH/P2WPKH.
- **Aggregation is by address hash, not by Bitcoin UTXO.** Multiple coins with the same `a` collapse into one balance. Claiming is one-shot per address for the full aggregated amount.
- **Website coverage numbers are documentation, not consensus constants.** Consensus sees the snapshot file and its merkle root; the numbers in explorer docs should be updated only when the production snapshot changes.
- **Skipped-output totals are diagnostic.** They help explain coverage, but absent outputs have no consensus representation and cannot be recovered through RPC or mempool policy.

## Cross-References

- [SNAPSHOT-PIPELINE](./SNAPSHOT-PIPELINE.md) for snapshot NDJSON loading, merkle commitment, deterministic fork genesis, and O(1) claim lookup.
- [CLAIM-FLOW](./CLAIM-FLOW.md) for the ownership proof branches inside `verifyClaimProof`.
- [OPERATOR-TOOLS](./OPERATOR-TOOLS.md) for `convert-snapshot`, `parse-utxoset`, snapshot activation, and claim CLI operation.
- [CRYPTO-PRIMITIVES](./CRYPTO-PRIMITIVES.md) for `deriveP2shP2wpkhAddress`, `deriveP2trAddress`, `deriveP2wshAddress`, `deriveP2shMultisigAddress`, and `parseWitnessScript`.
- [EXPLORER-CONTENT](./EXPLORER-CONTENT.md) for how the website's embedded claim documentation is rendered from TypeScript modules.
