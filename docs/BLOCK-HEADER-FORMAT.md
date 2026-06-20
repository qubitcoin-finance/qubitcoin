# Block Header Format

Byte-level reference for the QubitCoin block header: the fixed 112-byte binary layout produced by `serializeBlockHeader`, the `doubleSha256` block-hash and merkle-root construction, the `hashMeetsTarget` proof-of-work predicate, and the `blockWork` cumulative-work formula. Read this when working on `src/block.ts` serialization, debugging a "Block hash mismatch" or "Merkle root mismatch" error, computing a header hash by hand, or reconciling QubitCoin's header with Bitcoin's 80-byte header. For the consensus *checks* that run over a header see [BLOCK-VALIDATION](./BLOCK-VALIDATION.md); for how a hashed block lands on disk see [BLOCK-STORAGE](./BLOCK-STORAGE.md).

## Why it exists

A block hash must be reproducible bit-for-bit by every node and by the miner's inner PoW loop, otherwise two honest nodes would compute different hashes for the same block and the chain would fork on nothing. QubitCoin pins this down with a *fixed-size* binary header — no variable-length fields, no length prefixes — so serialization is a single `concatBytes` of six fields with no ambiguity about ordering or padding. The header is also the only thing the proof-of-work covers: the nonce lives inside it, and `computeBlockHash` re-serializes the whole header on every nonce bump, so the layout below is the hot path of mining.

QubitCoin keeps Bitcoin's hashing primitives (double-SHA-256, the same odd-leaf-duplicating merkle tree) but deliberately departs from Bitcoin's header in two ways: the header is 112 bytes rather than 80 (8-byte timestamp, full 32-byte target instead of a 4-byte `nBits` compact encoding), and hashes are **not byte-reversed** for display. Both differences are spelled out below because they are the usual source of "my hand-computed hash doesn't match" confusion.

## Key files

| Symbol | Location | Role |
|--------|----------|------|
| `BlockHeader` | `src/block.ts:31` | The six-field header interface |
| `Block` | `src/block.ts:40` | Header + `hash` + `transactions` + `height` |
| `BLOCK_HEADER_SIZE` | `src/block.ts:80` | The constant `112` |
| `serializeBlockHeader` | `src/block.ts:137` | Header → 112-byte `Uint8Array` |
| `computeBlockHash` | `src/block.ts:149` | `doubleSha256` of the serialized header |
| `computeMerkleRoot` | `src/block.ts:115` | Bitcoin-style merkle, duplicates last leaf if odd |
| `hashMeetsTarget` | `src/block.ts:154` | `BigInt(hash) < BigInt(target)` PoW predicate |
| `blockWork` | `src/block.ts:159` | `2^256 / (target + 1)` cumulative-work contribution |
| `uint32LE` / `uint64LE` | `src/crypto.ts:58` / `:66` | Little-endian integer encoders |
| `doubleSha256` | `src/crypto.ts:19` | `sha256(sha256(data))`, the hashing core |

## The 112-byte header layout

`serializeBlockHeader(header)` (`src/block.ts:137`) is a flat concatenation of six fields in this exact order:

```text
offset  size  field          encoding              source field
------  ----  -------------  --------------------  ----------------------
   0      4   version        uint32 little-endian  header.version
   4     32   previousHash   raw bytes (hexToBytes) header.previousHash
  36     32   merkleRoot     raw bytes (hexToBytes) header.merkleRoot
  68      8   timestamp      uint64 little-endian  header.timestamp (unix ms)
  76     32   target         raw bytes (hexToBytes) header.target
 108      4   nonce          uint32 little-endian  header.nonce
------  ----
 total: 112 bytes
```

### Integer fields are little-endian

`version`, `timestamp`, and `nonce` go through `uint32LE` / `uint64LE` (`src/crypto.ts:58`), which write via `DataView.setUint32(..., true)` — little-endian, matching Bitcoin's header integers. `timestamp` is **unix milliseconds** in a full 8 bytes, not Bitcoin's 4-byte unix-seconds field; this is why the header is 8 bytes wider than Bitcoin's there.

### Hash and target fields are raw, not reversed

`previousHash`, `merkleRoot`, and `target` are 64-character hex strings decoded straight through `hexToBytes` with **no byte reversal**. Bitcoin internally stores these little-endian and reverses them for RPC/display; QubitCoin stores and serializes them in the same big-endian order it shows to users. So the hex you see in the explorer is the hex that is fed verbatim into the header bytes — copy it directly when reproducing a hash, do not reverse it.

### target replaces nBits

Bitcoin compresses the difficulty target into a 4-byte `nBits` floating-point-like encoding. QubitCoin instead stores the **full 256-bit target** as a 32-byte field. There is no compact-encoding round-trip and therefore no `nBits` precision loss to reason about. See [CONSENSUS-PARAMETERS](./CONSENSUS-PARAMETERS.md) for the target constants (`INITIAL_TARGET`, `STARTING_DIFFICULTY`).

## Block hash

`computeBlockHash(header)` (`src/block.ts:149`) is simply:

```text
hash = bytesToHex( doubleSha256( serializeBlockHeader(header) ) )
```

`doubleSha256` (`src/crypto.ts:19`) is `sha256(sha256(data))` over the 32-byte intermediate. The result is converted to hex in natural SHA-256 output order — again, **not reversed**. The stored `Block.hash` (`src/block.ts:42`) is exactly this value. Because the header is fixed-size and the transactions are summarized only through `merkleRoot`, changing any transaction changes the merkle root, which changes the header bytes, which changes the hash — the block hash transitively commits to every transaction without the transactions appearing in the header.

## Merkle root

`computeMerkleRoot(txIds)` (`src/block.ts:115`) builds a Bitcoin-style merkle tree over the transaction IDs:

- Empty list → `'0'.repeat(64)` (64 zero hex chars). This is the genesis-style empty commitment.
- Single tx → that txid is returned unchanged (no hashing).
- Otherwise, each level pairs adjacent leaves and hashes `doubleSha256(concat(left, right))`. If a level has an odd count, the **last leaf is duplicated** before pairing.

The duplicate-last-leaf rule is inherited from Bitcoin and carries the same CVE-2012-2459 malleability concern, which is why `validateBlock` separately rejects blocks containing duplicate transaction IDs — see [BLOCK-VALIDATION](./BLOCK-VALIDATION.md). Leaves are decoded with `hexToBytes` and re-encoded with `bytesToHex`, so the merkle root is in the same non-reversed hex convention as every other hash here.

## Proof-of-work predicate and work accounting

`hashMeetsTarget(hash, target)` (`src/block.ts:154`) compares the two 64-char hex strings as big integers:

```text
BigInt('0x' + hash) < BigInt('0x' + target)
```

A block is valid PoW when its hash, interpreted as a 256-bit number, is strictly below the target. The miner increments `nonce`, re-serializes, re-hashes, and re-tests this predicate in its inner loop — see [MINING-LIFECYCLE](./MINING-LIFECYCLE.md).

`blockWork(target)` (`src/block.ts:159`) converts a target into the expected number of hashes to beat it:

```text
work = 2^256 / (target + 1)        (0 when target is 0)
```

Lower target → higher work. The chain sums `blockWork` across the active chain into its cumulative-work total, which is the tie-breaker for fork choice; see [REORG-UNDO](./REORG-UNDO.md) for how cumulative work drives reorg decisions.

## Size accounting

`blockSize(block)` (`src/block.ts:103`) starts from `BLOCK_HEADER_SIZE` (112) and adds `transactionSize(tx)` (`src/block.ts:83`) for each transaction. These are *estimates* used to gate `MAX_BLOCK_SIZE` (1 MB) cheaply before any expensive validation — `transactionSize` sums fixed widths for txid, inputs (incl. ML-DSA public key + signature byte lengths), outputs, and any `claimData` (BTC address, ECDSA key/signature, qbtc address). They are not a byte-exact wire serialization of the full block; only the header has a canonical fixed binary form. For the transaction-side detail see [TRANSACTION-ANATOMY](./TRANSACTION-ANATOMY.md).

## Invariants and edge cases

- **Fixed 112 bytes, always.** Every field is fixed-width; a header is never shorter or longer. A `previousHash`, `merkleRoot`, or `target` that is not exactly 64 hex chars will produce a wrong-length byte slice and a hash that no peer reproduces.
- **No byte reversal anywhere.** Hashes are serialized, hashed, and displayed in the same order. Do not apply Bitcoin's display-reversal when porting hashes in or out.
- **Genesis uses a fixed `timestamp = 0`.** `createGenesisBlock` (`src/block.ts:169`) pins the timestamp so the genesis hash is deterministic across nodes; `createForkGenesisBlock` (`src/block.ts:229`) commits the BTC snapshot into the genesis — see [SNAPSHOT-PIPELINE](./SNAPSHOT-PIPELINE.md).
- **Merkle root commits to order.** Reordering transactions changes the root and therefore the block hash, even though the set of transactions is identical.
- **Empty merkle root is all-zero hex,** not the hash of nothing; treat a `'0'.repeat(64)` root as "no transactions" rather than a real digest.

## Cross-references

- [BLOCK-VALIDATION](./BLOCK-VALIDATION.md) — the ordered consensus checks that run over a header and its block.
- [BLOCK-STORAGE](./BLOCK-STORAGE.md) — how a hashed block is serialized to and replayed from disk.
- [MINING-LIFECYCLE](./MINING-LIFECYCLE.md) — the nonce loop that re-hashes this header.
- [CONSENSUS-PARAMETERS](./CONSENSUS-PARAMETERS.md) — target, size, and timing constants referenced here.
- [REORG-UNDO](./REORG-UNDO.md) — cumulative-work fork choice built on `blockWork`.
- [CRYPTO-PRIMITIVES](./CRYPTO-PRIMITIVES.md) — `doubleSha256`, `uint32LE`/`uint64LE`, and the hashing helpers.
- [TRANSACTION-ANATOMY](./TRANSACTION-ANATOMY.md) — the transactions summarized by the merkle root.
