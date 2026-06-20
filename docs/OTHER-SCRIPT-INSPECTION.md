# Other Script Inspection

How an operator-local diagnostic pass grouped Bitcoin `dumptxoutset` outputs classified as `other`; read this when investigating excluded snapshot value, `rawScript`, `scriptPattern`, or questions like "which non-standard Bitcoin scripts were skipped and why?"

This page covers a diagnostic artifact, not a consensus path. The committed snapshot converter only emits claimable script templates, while an operator-local inspector can reuse the streaming UTXO parser to look at the excluded `other` bucket and group those raw scripts by structural pattern. Search terms that should land here include `Inspecting "other" scripts`, `OP_DUP OP_HASH160 OP_0 OP_EQUALVERIFY OP_CHECKSIG`, `OP_HASH256 <32B> OP_EQUAL`, and `scriptPattern`.

## Why It Exists

QubitCoin deliberately avoids a general Bitcoin Script VM. The supported claim paths are bounded templates: key-hash, P2SH/P2WPKH, P2TR, P2WSH, and bare multisig. Everything else must stay out of the merkle-committed snapshot unless the parser can reduce it to a stable address hash and the claim validator can verify a matching proof.

That leaves a practical audit question: after `parseDumptxoutset` classifies a coin as `other`, what is actually inside that bucket? It could be a malformed P2PKH-like script, a hash puzzle, a future witness form, a decorated script that would need full execution, or junk-like dust. The diagnostic pass answers that by scanning the original `utxos.dat`, keeping only `scriptType === 'other'` entries with `rawScript`, and grouping them by opcodes with pushdata contents replaced by sizes.

The output is useful for explaining coverage numbers and for deciding whether an excluded family is genuinely unsupported by design. It is not evidence that an output is claimable. A pattern appearing in an operator-local inspection report still has no consensus representation unless `parse-utxoset`, snapshot aggregation, and `verifyClaimProof` all support it.

## Durable References

The inspected script and its raw report were operator-local artifacts under the ignored `scripts/` directory, so they are not reliable repository anchors. Use the committed parser and coverage documents as the durable references:

| Anchor | Role |
|---|---|
| `src/tools/parse-utxoset.ts:29` | `ScriptType` includes `other` and `op_return` alongside claimable types. |
| `src/tools/parse-utxoset.ts:314` | Unrecognized raw scripts become `{ scriptType: 'other', rawScript }`. |
| `docs/BTC-SCRIPT-COVERAGE.md:145` | Existing coverage doc section that summarizes excluded outputs. |

## How It Works

### Input And Parser Boundary

The inspector reads the same binary `dumptxoutset` v2 file as the snapshot converter. It starts by calling `parseHeader(inputPath)` so it can print the total coin count, then streams every decoded `ParsedCoin` through `parseDumptxoutset(inputPath, onProgress)`.

The important boundary is that the script does not classify Bitcoin scripts itself. Classification has already happened inside `readCompressedScript` in `src/tools/parse-utxoset.ts`. The inspector only looks at parser outputs where:

```text
coin.scriptType === 'other'
coin.rawScript exists
```

That means the inspector inherits the parser's claimability decision. If `readCompressedScript` recognizes P2WPKH, P2WSH, P2TR, bare multisig, P2PKH, P2SH, or P2PK, the coin never reaches this report. If it recognizes `OP_RETURN`, it is skipped too because there is no `rawScript` on the `op_return` result.

### Pattern Grouping

`scriptPattern` walks the raw script byte by byte. Direct push opcodes from `0x01` through `0x4b` become `<nB>`, known opcodes become names from `OP_NAMES`, and unknown bytes become hex opcodes such as `0x73`.

That turns many distinct scripts into one structural bucket:

```text
OP_DUP OP_HASH160 <20B> OP_EQUALVERIFY OP_CHECKSIG 0x61
```

The grouped pattern is intentionally lossy. It is designed to answer "how much value has this shape?" rather than "what exact bytes did this one output contain?" Exact examples are preserved separately through `disassemble`, which prints up to three examples per pattern.

### Disassembled Examples

`disassemble` uses the same opcode walk but keeps a preview of each pushed value. For a direct data push it prints `PUSH<n>(<hex prefix>...)`, truncating after the first eight bytes. Each example records the txid, vout, height, BTC amount, and readable script.

That makes a local inspection report good enough for human review without turning it into a raw-script dump. A maintainer can see, for example, that the largest excluded value is not a standard key-hash output: it is `OP_DUP OP_HASH160 OP_0 OP_EQUALVERIFY OP_CHECKSIG`, where the hash push is missing.

### Sorting And Totals

The script tracks three totals:

| Value | Source |
|---|---|
| `otherCount` | Number of `other` coins with preserved `rawScript`. |
| `otherSats` | Sum of satoshis for those coins. |
| per-pattern `{ count, totalSats, examples }` | Map keyed by `scriptPattern(rawScript)`. |

At the end it sorts patterns by `totalSats` descending. The captured operator-local output shows why value sorting matters: a tiny number of malformed high-value outputs can dominate the excluded BTC total, while thousands of dust-like patterns contribute little value.

## Current Output Snapshot

An operator-local report captured from `/home/qubitcoin/utxos.dat`, the same broad production-scale dump referenced by the website coverage copy, reported:

| Metric | Value |
|---|---:|
| Total coins scanned | `164,352,533` |
| `other` coins with raw scripts | `78,498` |
| Excluded `other` value | `2,617.91 BTC` |

The highest-value pattern in that capture is:

```text
OP_DUP OP_HASH160 OP_0 OP_EQUALVERIFY OP_CHECKSIG
```

That pattern accounts for 23 coins and 2,609.36 BTC in the saved output. It resembles P2PKH, but the expected 20-byte key-hash push has been replaced by `OP_0`, so the parser cannot produce the key hash required by the default claim verifier.

Other visible families include `OP_HASH256 <32B> OP_EQUAL` hash puzzles, padded or decorated P2PKH-like scripts, short/long `OP_12 <nB>` dust patterns, and long arbitrary scripts. These are examples of why the exclusion rule is implementation-based, not name-based: if no bounded ownership verifier exists, the output does not enter the snapshot.

## Relationship To Snapshot Coverage

The active snapshot coverage numbers come from the converter, not from this inspector. `convert-snapshot.ts` decides which `ScriptType` values are claimable, writes the claimable `coins.jsonl`, aggregates those into address balances, and records per-type counters in the final snapshot metadata.

The inspector sits beside that workflow as an explanation aid:

```text
parseDumptxoutset
  -> claimable types       -> convert-snapshot -> qbtc-snapshot.jsonl
  -> op_return             -> skipped counters
  -> other + rawScript     -> local inspection report
```

That split prevents diagnostic curiosity from becoming consensus policy. A pattern can be interesting, high value, or common and still remain excluded if the node has no deterministic ownership proof for it.

### Why `other` Is Not One Category

`other` is the parser's fallback bucket. It means "not one of the recognized templates," not "one specific script family." In the saved output it contains malformed P2PKH-like scripts, hash-preimage scripts, odd witness-like programs, arbitrary pushed data, and thousands of tiny non-standard patterns.

That is why `scriptPattern` groups by structure before sorting. A raw list of 78,498 scripts would hide the important shape of the excluded set, while a grouped value report shows which families account for most skipped BTC.

### Why `rawScript` Is Preserved

`ParsedCoin.rawScript` exists only for `other` outputs. Claimable templates store an `addressHash` instead, because the snapshot needs the address hash and not the full script. `other` outputs do not have a supported address hash, so preserving the raw bytes is the only way to inspect them after classification.

The inspector uses that raw script for two separate views: `scriptPattern` for grouping and `disassemble` for examples. Neither output is fed back into the snapshot pipeline.

## Artifact Status

The diagnostic inspector and captured report are not committed repository files. In the working copy where this note was written, both lived under the ignored `scripts/` directory:

- The inspector was an operator-local TypeScript script, not a package script.
- The captured output was an operator-local text report, not generated during normal builds or deployment.
- The only committed code path that matters for claimability remains `src/tools/parse-utxoset.ts` plus the snapshot conversion and claim verification flow.

Those facts matter when restoring or re-running the analysis. They do not affect the active snapshot pipeline because production conversion uses `src/tools/convert-snapshot.ts`, not this inspector.

## Invariants And Edge Cases

- **Diagnostic only.** The inspector does not write snapshot entries, chain data, metadata, or claim files.
- **Parser-owned classification.** A coin appears here only because `parseDumptxoutset` returned `scriptType: 'other'` with `rawScript`.
- **`OP_RETURN` is separate.** Nulldata outputs are excluded from claims, but they are classified as `op_return`, not `other`, and are not grouped by this script.
- **Patterns are structural.** Pushdata values are replaced by sizes in the grouping key, so the same pattern can contain many unrelated exact scripts.
- **Examples are currently capped at three per pattern.** `sampleLimit` is parsed and printed, but the current implementation stores examples with `entry.examples.length < 3`.
- **Totals depend on the dump.** The numbers above describe the captured `/home/qubitcoin/utxos.dat` run, not a consensus constant.
- **Claimability requires three layers.** Adding a pattern to the parser is not enough; snapshot aggregation and `verifyClaimProof` also need a deterministic proof path.

## Cross-References

- [BTC-SCRIPT-COVERAGE](./BTC-SCRIPT-COVERAGE.md) for the claimable script templates and why `other` outputs are excluded from the snapshot.
- [DUMPTXOUTSET-FORMAT](./DUMPTXOUTSET-FORMAT.md) for the binary parser, compressed script tags, and `ParsedCoin.rawScript`.
- [OPERATOR-TOOLS](./OPERATOR-TOOLS.md) for the active snapshot conversion workflow that produces claimable snapshot NDJSON.
- [CLAIM-FLOW](./CLAIM-FLOW.md) for the verifier branches that would have to exist before any script family can be claimed.
- [SNAPSHOT-PIPELINE](./SNAPSHOT-PIPELINE.md) for how emitted snapshot entries become fork genesis and O(1) claim lookup state.
