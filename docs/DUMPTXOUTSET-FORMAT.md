# dumptxoutset v2 Binary Format

This doc is the byte-level reference for Bitcoin Core's `dumptxoutset` v2 UTXO-dump format as decoded by `src/tools/parse-utxoset.ts` — the binary that QubitCoin's snapshot generation reads to learn every claimable BTC balance. Read it when working on the streaming parser, when debugging "Invalid magic bytes", "Unsupported version", a wrong/zero satoshi amount, a missing address type in the snapshot, or a resume that lands mid-record. It explains the file header, the txid-grouped coin layout, the MSB-128 varint and CompactSize integer encodings, the base-9/base-10 amount decompression, and the compressed-script `nSize` scheme that maps raw scripts onto the seven claimable `ScriptType` values plus `op_return`/`other`.

This is a **format reference**, not a workflow guide. The operator-facing pipeline that *invokes* this parser (`convert-snapshot.ts` extract/aggregate, `generate-snapshot.sh`, checkpoints, external sort) is documented in [OPERATOR-TOOLS](./OPERATOR-TOOLS.md); the *consumer* side that loads the resulting NDJSON snapshot is [SNAPSHOT-PIPELINE](./SNAPSHOT-PIPELINE.md). This page covers the layer between them: how raw `utxos.dat` bytes become `ParsedCoin` objects.

## Why it exists

QubitCoin mints no BTC balances into genesis. Instead it commits to a Bitcoin UTXO snapshot and lets holders claim later by proving ownership (see [CLAIM-FLOW](./CLAIM-FLOW.md)). To build that snapshot, someone must read the full Bitcoin UTXO set — tens of gigabytes, ~180M+ coins — and reduce it to per-address claimable balances. Bitcoin Core exports that set with the `dumptxoutset` RPC, which writes a compact, purpose-built binary file (`utxos.dat`), *not* JSON. The format is dense: amounts are range-coded, scripts are stored in a compressed form that drops redundant opcodes, and coins are grouped by transaction to avoid repeating the 32-byte txid. A naive reader would also try to hold the whole file in memory and OOM.

`parse-utxoset.ts` answers all three problems: it streams the file in 64 MB chunks through a `BufferedReader`, decodes each compact field exactly as Bitcoin Core's `compressor.cpp` / serialization code encodes it, and yields one `ParsedCoin` at a time through an async generator so the caller never materializes more than a window. Getting any decoder wrong silently corrupts balances, which is why the format is worth writing down precisely.

## Key files

| Path | Symbol | Role |
|------|--------|------|
| `src/tools/parse-utxoset.ts:50` | `MAGIC` | Expected leading bytes `75 74 78 6f ff` ("utxo\xff") |
| `src/tools/parse-utxoset.ts:51` | `HEADER_SIZE` | Fixed 51-byte header length (resume offset baseline) |
| `src/tools/parse-utxoset.ts:52` | `READ_CHUNK` | 64 MB stream `highWaterMark` and compaction threshold |
| `src/tools/parse-utxoset.ts:56` | `class BufferedReader` | Chunked, seekable, self-compacting byte reader |
| `src/tools/parse-utxoset.ts:130` | `readBytes(n)` | Awaits until `n` bytes are buffered, returns a `Buffer` slice |
| `src/tools/parse-utxoset.ts:158` | `readByte()` | Single-byte convenience over `readBytes(1)` |
| `src/tools/parse-utxoset.ts:164` | `advance()` | Marks consumed bytes; compacts past `READ_CHUNK` |
| `src/tools/parse-utxoset.ts:183` | `readVarint()` | MSB-128 varint with subtract-1 continuation encoding |
| `src/tools/parse-utxoset.ts:198` | `readCompactSize()` | Bitcoin CompactSize (1/3/5/9-byte) integer |
| `src/tools/parse-utxoset.ts:220` | `decompressAmount()` | Inverse of Core `CompressAmount` (base-9/base-10) |
| `src/tools/parse-utxoset.ts:248` | `readCompressedScript()` | `nSize`-coded script → `ScriptType` + address hash |
| `src/tools/parse-utxoset.ts:315` | `parseHeader()` | Validates magic + version, returns `SnapshotHeader` |
| `src/tools/parse-utxoset.ts:351` | `parseDumptxoutset()` | Async generator yielding every `ParsedCoin` |
| `src/tools/parse-utxoset.ts:29` | `type ScriptType` | The nine classification buckets |
| `src/tools/parse-utxoset.ts:31` | `interface ParsedCoin` | One decoded UTXO with `isGroupEnd` flag |
| `src/tools/parse-utxoset.ts:43` | `interface ResumeState` | `{ bytesRead, coinsRead }` for mid-file resume |

## File header (51 bytes)

`parseHeader` reads a fixed-layout prefix and rejects anything that is not a v2 dump before any coin is parsed:

```text
offset  size  field
0       5     magic            = 75 74 78 6f ff   ("utxo\xff")
5       2     version (LE)     = 2
7       4     network magic    (mainnet/testnet bytes, preserved as-is)
11      32    block hash       (little-endian as stored on disk)
43      8     coin count (LE)  uint64 — total UTXOs in the body
```

Total = `HEADER_SIZE` = 51. The magic check loops byte-by-byte and throws `Invalid magic bytes at position N` on the first mismatch — the usual cause is pointing the parser at a non-dump file or a truncated download. `version !== 2` throws `Unsupported version` — Core's older v1 layout is not supported. The 8-byte `coinCount` is the loop bound for the body; `version`, `networkMagic`, `blockHash`, and `coinCount` are returned as a `SnapshotHeader`.

The `blockHash` is stored little-endian and kept verbatim. `convert-snapshot.ts` later maps it to a height via `KNOWN_BLOCK_HEIGHTS` (`src/tools/convert-snapshot.ts:53`) when the dump height is not otherwise known, because the binary header carries the block *hash* but not its *height*.

## Coin body: txid groups

After the header, the body is `coinCount` UTXOs serialized as **txid groups** to avoid repeating the 32-byte transaction id once per output. `parseDumptxoutset` tracks `remainingInGroup`; when it hits zero it starts a new group:

```text
per group:
  32 bytes   txid (hex, as stored)
  CompactSize n   number of unspent outputs from this txid
  repeat n times:
    CompactSize  vout index
    varint       nCode      = (height << 1) | coinbaseFlag
    varint       compressed amount
    compressed script        (variable, see below)
```

Each decoded output becomes a `ParsedCoin`. `nCode >> 1` is the confirmation `height`; `nCode & 1` is the `coinbase` flag. The amount and script run through the decoders below. The last coin of a group sets `isGroupEnd: true` — this is the only safe place to checkpoint a resume offset, because `parseDumptxoutset(path, onProgress, resumeFrom)` seeks to a raw byte offset and assumes it lands on a group boundary (a `ResumeState` taken mid-group would desynchronize the reader).

### BufferedReader windowing

The body is far larger than memory, so `BufferedReader` streams it. It accumulates `createReadStream` chunks (`highWaterMark` = `READ_CHUNK` = 64 MB), serves `readBytes(n)` from the buffered window, and `advance()` is called after each coin to mark bytes consumed. Once consumed bytes exceed `READ_CHUNK` it compacts the retained buffers so memory stays bounded regardless of file size. `parseDumptxoutset` reports progress through the optional `onProgress(bytesRead, coinsRead)` callback every 100k coins, and `bytesRead` is exactly what a resume checkpoint records.

## Integer encodings

Two distinct variable-length integer encodings appear, and mixing them up shifts every subsequent byte.

### MSB-128 varint (`readVarint`)

Used for `vout`-adjacent fields like `nCode` and the compressed amount, and for the script `nSize`. Each byte carries 7 data bits in bits 0–6; bit 7 is a continuation flag. Crucially, Bitcoin's variant adds 1 after shifting in each *non-final* byte's payload (`n += 1n` in the loop) — this is the "subtract-1 during encode" trick that keeps the encoding canonical. The loop reads bytes until one has bit 7 clear, accumulating `n = (n << 7) | (byte & 0x7f)` and returns a `bigint` (amounts and heights can exceed 32 bits).

### CompactSize (`readCompactSize`)

Used for the per-group output count and each `vout` index. This is Bitcoin's classic length prefix:

```text
first byte < 0xfd        → value is the byte itself        (1 byte total)
first byte = 0xfd        → next 2 bytes, uint16 LE         (3 bytes total)
first byte = 0xfe        → next 4 bytes, uint32 LE         (5 bytes total)
first byte = 0xff        → next 8 bytes, uint64 LE         (9 bytes total)
```

It returns a `number` (output counts and vout indices fit comfortably in a JS number), unlike the varint decoder which returns `bigint`.

## Amount decompression (`decompressAmount`)

Bitcoin Core stores satoshi amounts range-coded so common round numbers (whole BTC, tenths) take few bytes. `decompressAmount` inverts Core's `CompressAmount` exactly:

1. `0` decompresses to `0` (special case).
2. Otherwise subtract 1, then split off `e = x % 10` (the decimal exponent) and `x /= 10`.
3. If `e < 9`: the least-significant non-zero digit `d = (x % 9) + 1`, `x /= 9`, and `n = x * 10 + d`. This reconstructs amounts with a single trailing significant digit cheaply.
4. If `e == 9`: `n = x + 1` (no extra digit packed).
5. Multiply `n` by `10^e` to restore trailing zeros.

All arithmetic is `bigint`. Getting this wrong does not throw — it silently yields a wrong balance — so any change here must be cross-checked against Core's `compressor.cpp DecompressAmount()`, which the implementation cites directly.

## Compressed scripts and classification (`readCompressedScript`)

The script is prefixed by a varint `nSize` that doubles as a type tag. Small values encode well-known script shapes implicitly (the redundant opcodes are dropped and reconstructed); larger values mean "raw script of length `nSize - 6`".

| `nSize` | Meaning | `ScriptType` | Address hash recovered |
|---------|---------|--------------|------------------------|
| `0x00` | P2PKH | `p2pkh` | 20-byte keyhash read directly |
| `0x01` | P2SH | `p2sh` | 20-byte scripthash read directly |
| `0x02` / `0x03` | P2PK, compressed pubkey | `p2pk` | `HASH160(prefix‖x)` over the 32-byte x-coord |
| `0x04` / `0x05` | P2PK, uncompressed pubkey | `p2pk` | x-coord re-prefixed `0x04→0x02`, `0x05→0x03`, then `HASH160` |
| `≥ 0x06` | raw script, length `nSize − 6` | classified below | from raw bytes |

For P2PK, the dump stores only the 32-byte x-coordinate plus a parity-encoding prefix; the parser rebuilds the compressed pubkey and computes `RIPEMD160(SHA256(pubkey))` so claims can match against a HASH160, matching the convention in [CRYPTO-PRIMITIVES](./CRYPTO-PRIMITIVES.md).

### Raw script classification

When `nSize ≥ 6`, the actual script bytes are read (`scriptLen = nSize - 6`; a non-positive length yields `other`) and pattern-matched:

- **P2WPKH** — 22 bytes, `OP_0 PUSH20`: `00 14 <20>` → 20-byte witness program.
- **P2WSH** — 34 bytes, `OP_0 PUSH32`: `00 20 <32>` → 32-byte witness program.
- **P2TR** — 34 bytes, `OP_1 PUSH32`: `51 20 <32>` → 32-byte taproot output key.
- **OP_RETURN** — first byte `0x6a`: `op_return`, provably unspendable, no address.
- **Bare multisig** — last byte `0xae` (`OP_CHECKMULTISIG`): `multisig`, addressed by `SHA256(script)` (same hashing convention as P2WSH).
- **Anything else** — `other`, with the raw bytes preserved in `rawScript` for inspection.

The extract phase keeps only the seven claimable buckets (`p2pkh`, `p2wpkh`, `p2sh`, `p2tr`, `p2pk`, `p2wsh`, `multisig`); `op_return` and `other` are counted and discarded. The set of recovered address hashes is exactly what makes each [CLAIM-FLOW](./CLAIM-FLOW.md) script path possible, and the byte-size assumptions here mirror the address derivations in [BTC-SCRIPT-COVERAGE](./BTC-SCRIPT-COVERAGE.md).

## Invariants and edge cases

- **Header gate before body.** `parseHeader` validates magic and `version === 2` before any coin is read; a bad header aborts immediately rather than misparsing the body.
- **Group-boundary resume only.** `resumeFrom` seeks to a raw byte offset and trusts it sits *after* a complete txid group. Checkpoints must be taken only when `isGroupEnd` is true; an offset inside a group desynchronizes `remainingInGroup` and every following field.
- **Two integer encodings are not interchangeable.** Output counts and `vout` use CompactSize; `nCode`, amount, and script `nSize` use the MSB-128 varint. The varint's subtract-1 continuation step is essential — dropping it overcounts large values.
- **`bigint` for amount/height, `number` for counts/vout.** `readVarint` returns `bigint` because satoshi amounts and heights exceed 32 bits; `readCompactSize` returns `number`.
- **Silent corruption risk.** Amount and script decoders never throw on plausible-but-wrong input — a regression yields incorrect balances or misclassified scripts, not an error. Validate against Bitcoin Core's compressor and known-good snapshot stats after any change.
- **Bounded memory.** `BufferedReader` compaction keeps resident memory near `READ_CHUNK` regardless of the multi-GB file size; do not buffer the whole file.
- **Version lock.** Only `dumptxoutset` v2 is supported. A future Core format bump (v3) would require new decoders, not a tweak.

## Cross-references

- [OPERATOR-TOOLS](./OPERATOR-TOOLS.md) — the extract/aggregate workflow, checkpoints, external sort, and `generate-snapshot.sh` that drive this parser.
- [SNAPSHOT-PIPELINE](./SNAPSHOT-PIPELINE.md) — how the resulting NDJSON snapshot is loaded, indexed, and turned into fork genesis.
- [CLAIM-FLOW](./CLAIM-FLOW.md) — how the recovered address hashes are later proven and claimed.
- [BTC-SCRIPT-COVERAGE](./BTC-SCRIPT-COVERAGE.md) — the catalog of supported BTC script types and their address derivations.
- [CRYPTO-PRIMITIVES](./CRYPTO-PRIMITIVES.md) — `HASH160`/`SHA256` helpers and address derivation used during classification.
