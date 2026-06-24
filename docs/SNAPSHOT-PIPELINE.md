# Snapshot Pipeline

How BTC snapshot NDJSON becomes a deterministic fork genesis and O(1) claim lookup table. Read this when working on `loadSnapshot`, `BtcSnapshot`, `computeSnapshotMerkleRoot`, `getSnapshotIndex`, `createForkGenesisBlock`, snapshot startup logs, or errors like "Snapshot missing btcTimestamp", "invalid address", and "BTC address ... not found in snapshot".

The snapshot pipeline is the bridge between an external Bitcoin UTXO-set export and the live QubitCoin claim system. It parses compact JSONL records, preserves enough Bitcoin block metadata to make every node derive the same fork genesis, builds a sharded in-memory index for claim verification, and tracks aggregate claim statistics without rescanning the full snapshot on every RPC request.

## Why It Exists

QubitCoin does not pre-mint BTC balances into genesis outputs. The genesis block commits to a Bitcoin snapshot, and later claim transactions mint individual QBTC outputs after the holder proves ownership of a snapshotted BTC address.

That design makes the snapshot a consensus input. If two nodes parse the same file into different `btcTimestamp`, `btcBlockHash`, `btcBlockHeight`, `merkleRoot`, or entry type values, they can derive different genesis hashes or reject different claim proofs. The loader therefore treats snapshot input as a strict boundary: malformed JSON, invalid addresses, unsafe amounts, and missing deterministic timestamp metadata fail before the node starts.

The other constraint is scale. A production snapshot can contain many Bitcoin addresses, so claim validation cannot scan `snapshot.entries` for every transaction. `getSnapshotIndex` converts entries into a cached `ShardedIndex` keyed by `btcAddress`, giving `verifyClaimProof` and `Blockchain.applyBlock` direct lookup by address.

## Key Files

| Anchor | Role |
|--------|------|
| `src/qbtcd.ts:99` | `SNAPSHOT_URL`, the default URL used by `--full` when no local snapshot path is provided |
| `src/qbtcd.ts:104` | `downloadFile`, redirect-limited downloader that writes to `<dest>.tmp` before rename |
| `src/qbtcd.ts:183` | `--full` snapshot bootstrap: create data dir, reuse existing file, or download default snapshot |
| `src/qbtcd.ts:198` | Runtime snapshot load path before `Node` and `Blockchain` construction |
| `src/snapshot-loader.ts:15` | `loadSnapshot`, the NDJSON parser and metadata normalizer |
| `src/snapshot-loader.ts:31` | First-line header detection using `merkleRoot` |
| `src/snapshot-loader.ts:58` | Entry address validation: lowercase 40- or 64-character hex only |
| `src/snapshot-loader.ts:59` | Entry amount validation: safe, non-negative integer only |
| `src/snapshot-loader.ts:71` | Header-vs-legacy distinction used for timestamp fallback behavior |
| `src/snapshot-loader.ts:87` | Header snapshots without timestamp fail deterministically |
| `src/snapshot.ts:24` | `BtcAddressBalance`, the normalized per-address claim record |
| `src/snapshot.ts:30` | `BtcSnapshot`, the in-memory snapshot object consumed by chain and claim code |
| `src/snapshot.ts:45` | `computeSnapshotMerkleRoot`, the deterministic commitment over entries |
| `src/snapshot.ts:61` | `ShardedIndex`, the 256-shard address lookup structure |
| `src/snapshot.ts:91` | `getSnapshotIndex`, the WeakMap-cached snapshot index builder |
| `src/block.ts:229` | `createForkGenesisBlock`, the deterministic genesis constructor for snapshot-backed nodes |
| `src/block.ts:242` | Fork-genesis commitment string embedded into the genesis coinbase input |
| `src/chain.ts:69` | `Blockchain` constructor stores snapshot totals and builds the lookup index |
| `src/claim.ts:312` | `verifyClaimProof`, the claim validator that uses the cached snapshot index |
| `src/chain.ts:574` | `getClaimableEntries`, the remaining-unclaimed listing path |
| `src/chain.ts:588` | `getClaimStats`, O(1) aggregate claim counters for RPC status |

## Snapshot File Shape

The loader accepts newline-delimited JSON. Empty lines are ignored.

There are two formats:

1. Header format: line 1 is a metadata object containing `merkleRoot`, optionally `hash`, `height`, and `timestamp`; later lines are entries.
2. Legacy format: every non-empty line is an entry; the loader computes the merkle root and fills deterministic test/default metadata.

An entry has compact fields:

```text
{"a":"<40-or-64-char-lowercase-hex-address>","b":<satoshis>,"t":"<optional-type>"}
```

`a` becomes `BtcAddressBalance.btcAddress`. It is a 40-character HASH160 for key-hash and P2SH-style entries, or a 64-character hex value for P2TR, P2WSH, and multisig-style entries.

`b` becomes `amount` in satoshis. It must already be a JSON number, must be a safe integer, and must be non-negative. String amounts are rejected instead of coerced.

`t` maps to the optional `type` field. Recognized values are `p2sh`, `p2tr`, `p2wsh`, and `multisig`. P2PK entries are retained as HASH160(pubkey) addresses with no `type`, so the claim path treats them like the default single-key P2PKH/P2WPKH style. Unknown values are ignored, also leaving `type` absent.

## Loader Flow

`loadSnapshot(filePath)` opens the snapshot with `fs.createReadStream` and a `readline.Interface`. This keeps the I/O path streaming, while the normalized `entries` array is accumulated for later claim lookup and aggregate totals.

```text
qbtcd --full/--snapshot
  -> maybe download qbtc-snapshot.jsonl
  -> loadSnapshot(path)
       -> parse optional header
       -> validate entries
       -> compute or preserve merkleRoot
       -> require or derive btcTimestamp
       -> return BtcSnapshot
  -> new Node('node', snapshot, storage)
  -> new Blockchain(snapshot, storage)
       -> getSnapshotIndex(snapshot)
       -> createForkGenesisBlock(snapshot) when no persisted chain exists
```

The first non-empty line is special only while `isFirstLine` is true. If JSON parsing fails there, the loader reports "invalid JSON in header". If it parses and has a truthy `merkleRoot`, it is treated as the header and is not added to `entries`.

If the first parsed object does not have `merkleRoot`, the loader falls through and parses it as a normal entry. After that point, malformed JSON is reported as "invalid JSON in entry" with the current line number.

### Header Metadata

Header values are intentionally narrow:

| Header field | Destination | Behavior |
|--------------|-------------|----------|
| `merkleRoot` | `BtcSnapshot.merkleRoot` | Preserved exactly when present |
| `hash` | `BtcSnapshot.btcBlockHash` | Converted with `String(...)`; defaults later if absent |
| `height` | `BtcSnapshot.btcBlockHeight` | Converted with `Number(...) || 0` |
| `timestamp` | `BtcSnapshot.btcTimestamp` | Converted with `Number(...) || 0`; required for new header snapshots |

The loader does not currently verify that header `count` matches `entries.length`, and it does not recompute and compare a header `merkleRoot`. The runtime integrity check in `qbtcd` creates the fork genesis from the loaded snapshot, so corruption changes the derived genesis hash instead of being silently equivalent to the expected chain.

### Legacy Metadata

Legacy snapshots without a header get `merkleRoot = computeSnapshotMerkleRoot(entries)`.

If `btcBlockHash` is absent, the loader uses `doubleSha256Hex(new TextEncoder().encode('btc-snapshot'))`. That fallback is compatibility behavior for local and older tests; production snapshots should carry an explicit Bitcoin block hash.

Timestamp handling is stricter because `createForkGenesisBlock` uses `snapshot.btcTimestamp * 1000` as the genesis header timestamp. Header snapshots must have a timestamp unless their hash is the known block `3aafae11a317cdd4fa7802ad577e741501e1fa0e970101000000000000000000`, which maps to Unix time `1739482182`. Legacy/test snapshots also fall back to `1739482182`.

## Merkle Commitment

`computeSnapshotMerkleRoot` is a deterministic commitment over entry order, address, amount, and type. It is not a Bitcoin-style pairwise tree despite the name.

For each `BtcAddressBalance`, it appends this text to an inner SHA-256 stream:

```text
<optional-type-prefix><btcAddress>:<amount>;
```

The type prefix is `"<type>:"` when `entry.type` exists and empty otherwise. After all entries are fed into the inner hash, the function returns `sha256(inner.digest())` as hex. An empty entry list returns 64 zeroes.

This means entry order is part of the commitment. Sorting, de-duplicating, changing an unknown `t` value into a known `type`, or converting an amount through a lossy numeric path changes the root and therefore the fork genesis commitment.

## Fork Genesis Coupling

`createForkGenesisBlock(snapshot)` is where snapshot metadata becomes chain identity.

The fork genesis coinbase pays zero to the burn address. Its input `publicKey` field carries a text commitment:

```text
QBTC_FORK:<btcBlockHeight>:<btcBlockHash>:<snapshotMerkleRoot>
```

That commitment is included in the genesis coinbase transaction ID, which becomes the genesis merkle root. The block header also uses `snapshot.btcTimestamp * 1000` as its timestamp. The block is cached by `snapshot.merkleRoot`, and a `_genesisNonceHint` can skip mining in deterministic mock snapshots.

The timestamp requirement exists because the same `btcBlockHeight`, `btcBlockHash`, and `merkleRoot` are not enough to force one genesis hash if different nodes choose different genesis header timestamps. `loadSnapshot` rejects header snapshots without timestamp metadata before this constructor can throw.

## Runtime Indexing

`ShardedIndex` splits snapshot lookups across 256 `Map<string, BtcAddressBalance>` instances. The shard is chosen from the first byte of the lowercase hex address (`parseInt(key.slice(0, 2), 16)`).

`getSnapshotIndex(snapshot)` stores the index in a `WeakMap` keyed by the `snapshot.entries` array. Repeated calls with the same snapshot object return the same index reference. This is important because both chain state and claim validation call the helper:

`Blockchain` builds the index once in its constructor and stores it as `snapshotIndex`. `verifyClaimProof` independently calls `getSnapshotIndex(snapshot)` and receives the cached index for the same entries array.

The cache key is the entries array identity, not the merkle root. Treat `snapshot.entries` as immutable after load. Mutating the array or entry objects after indexing can make claim behavior diverge from the commitment that created the genesis block.

## Chain Handoff

When `new Blockchain(snapshot, storage)` receives a snapshot, it stores:

| Field | Purpose |
|-------|---------|
| `btcSnapshot` | Makes claim verification available to `addBlock` |
| `snapshotTotalEntries` | Fixed denominator for claim stats |
| `snapshotTotalAmount` | Fixed total value for unclaimed/claimed counters |
| `snapshotIndex` | O(1) address lookup during block application |

If storage already has persisted blocks, the constructor replays those blocks and returns without creating a fresh genesis. The replay path still has the snapshot totals and index because they are initialized before storage replay. That lets claimed-address counters rebuild as persisted claim transactions are applied.

If storage is empty, the constructor creates `createForkGenesisBlock(snapshot)` instead of the default no-snapshot genesis. That genesis is appended to storage when a `BlockStorage` implementation is present.

## Claim Consumption

A claim transaction carries a BTC address in `tx.claimData.btcAddress`. `verifyClaimProof` looks up that address in `getSnapshotIndex(snapshot)`.

If the address is absent, verification returns `BTC address <address> not found in snapshot`. If present, the entry type selects the ownership proof path: default single-key ECDSA, P2SH-wrapped single-key, Taproot Schnorr, P2WSH multisig, or bare multisig.

`Blockchain.addBlock` also protects the one-shot nature of claims. Before a claim is applied, it checks `claimedBtcAddresses`; during `applyBlock`, it records the claimed address and increments `claimedCount` and `claimedAmount`. Reorg undo reverses those counters from the same snapshot index.

`getClaimableEntries` still filters the full `btcSnapshot.entries` array, so it is proportional to snapshot size. `getClaimStats` is O(1) because totals and claimed counters are maintained incrementally.

## Invariants and Edge Cases

Snapshot addresses are lowercase hex. Uppercase strings and non-hex characters are rejected at load time.

Snapshot address length is either 40 or 64 characters. The loader does not infer address type from length; it only preserves recognized `t` values.

Snapshot amounts are JavaScript safe integers. Values outside `Number.isSafeInteger`, negative amounts, fractional amounts, or string amounts are invalid.

Header snapshots need deterministic timestamp data. Missing `timestamp` on a new header snapshot fails with "Snapshot missing btcTimestamp — cannot create deterministic genesis. Add \"timestamp\" to the snapshot header."

Legacy snapshots remain supported for tests and old local files. They get computed merkle roots and fixed timestamp fallback behavior, but production-like runs should use explicit metadata.

The snapshot index assumes entries are already valid. `ShardedIndex.shard` has a defensive fallback to shard 0, but normal input reaches it only after `loadSnapshot` has enforced lowercase hex addresses.

The `WeakMap` cache avoids global lifetime leaks for discarded snapshots, but it also means index reuse depends on keeping the same entries array identity.

Fork genesis caching is keyed only by `snapshot.merkleRoot`. Two snapshots with the same merkle root but different metadata would share a cached genesis in-process. The intended invariant is that a merkle root names a single snapshot file and header set for a running node.

## Cross-References

- [CLAIM-FLOW](./CLAIM-FLOW.md) explains the ownership proof formats that consume snapshot entries.
- [BLOCK-STORAGE](./BLOCK-STORAGE.md) explains how blocks created from a snapshot-backed chain are persisted and replayed.
- [REORG-UNDO](./REORG-UNDO.md) explains how claimed-address counters and UTXO state are reversed during a chain rollback.
- [MEMPOOL-LIFECYCLE](./MEMPOOL-LIFECYCLE.md) explains pending BTC claim reservations before a claim reaches a block.
