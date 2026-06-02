# Block Storage & Serialization

How blocks reach disk and come back as typed objects. Read this when working on the `BlockStorage` interface, the `blocks.jsonl` / `metadata.json` files, the `sanitize` / `deserializeBlock` / `deserializeTransaction` round-trip, or when debugging "Skipping corrupted block entry", "hex string too large", or chain-replay-on-startup behavior.

QubitCoin persists the chain as newline-delimited JSON (NDJSON). Every block read or written goes through the `BlockStorage` interface in `src/storage.ts` — business logic never touches `blocks.jsonl` directly. The fragile part is the binary boundary: ML-DSA-65 public keys, signatures, and BTC claim proofs are `Uint8Array` in memory but must become hex strings in JSON and back again. `sanitize` (in `src/utils.ts`, re-exported as `sanitizeForStorage`) handles the outbound direction; `deserializeBlock` / `deserializeTransaction` handle the inbound direction with shape validation and DoS-bounded hex decoding.

## Why it exists

The chain is an append-only log. Using NDJSON instead of one giant JSON array means a new block is a single `fs.appendFileSync` of one line — O(1) per block, no read-modify-write of the whole file. It also means a corrupt or truncated tail line damages exactly one block, not the entire store: `loadBlocks` skips bad lines and continues.

JSON has no native binary type, so `Uint8Array` fields would serialize as `{"0":12,"1":255,...}` index-keyed objects — bloated and lossy. The serialization boundary converts every `Uint8Array` to a compact hex string on write and validates + decodes it on read. Because the data on disk (and the same shapes arriving over P2P/RPC) is untrusted, the inbound path enforces structural shape and caps hex-string lengths to protocol-defined field sizes, preventing a malicious record from triggering an unbounded `hexToBytes` allocation.

## Key files

| Anchor | Role |
|--------|------|
| `src/storage.ts:24` | `BlockStorage` interface — the five-method contract |
| `src/storage.ts:234` | `FileBlockStorage` — NDJSON implementation over `blocks.jsonl` + `metadata.json` |
| `src/storage.ts:244` | `appendBlock` — single-line O(1) append |
| `src/storage.ts:249` | `rewriteBlocks` — full-file rewrite (genesis replace, reorg) |
| `src/storage.ts:254` | `loadBlocks` — line-by-line parse, skips corrupt entries |
| `src/utils.ts:38` | `sanitize` — recursive `Uint8Array` → hex (outbound) |
| `src/storage.ts:214` | `deserializeBlock` — shape-validate + restore one block (inbound) |
| `src/storage.ts:139` | `deserializeTransaction` — restore tx inputs + claimData binaries |
| `src/storage.ts:179` | `validateBlockShape` — header/hash/height structural checks |
| `src/storage.ts:80` | `validateTransactionShape` — input/output/claimData structural checks |
| `src/storage.ts:72` | `safeHexToBytes` — length-capped hex decode |
| `src/storage.ts:45` | `BINARY_FIELD_MAX_HEX_LEN` — per-field hex caps |

## How it works

### The interface contract

`BlockStorage` (`src/storage.ts:24`) is five methods: `appendBlock`, `rewriteBlocks`, `loadBlocks`, `loadMetadata`, `saveMetadata`. `Blockchain` (`src/chain.ts`) holds a `BlockStorage | null` and is constructed as `new Blockchain(snapshot?, storage?)`. When `storage` is `null` the chain runs in memory only (used heavily in tests). Any alternative backend — an in-memory mock, a database — only has to implement these five methods.

### Outbound: write path

`appendBlock` and `rewriteBlocks` both run the block through `sanitize` before `JSON.stringify`. `sanitize` (`src/utils.ts:38`) recurses through arrays and plain objects; whenever it hits a `Uint8Array` it replaces it with `hexEncode(...)`. So an ML-DSA signature `Uint8Array(3309)` becomes a 6618-char hex string nested in the same JSON position. `appendBlock` writes `serialized + '\n'`; `rewriteBlocks` joins all lines and adds a trailing newline only when the list is non-empty.

```text
Block (in memory)            JSON line on disk
  header.target: string  ->  "target":"00ff…"
  hash: string           ->  "hash":"a1b2…"
  transactions[]              "transactions":[…]
    inputs[].publicKey       (Uint8Array → hex string)
    inputs[].signature       (Uint8Array → hex string)
    claimData.ecdsaSignature (Uint8Array → hex string)
```

### Inbound: read path

`loadBlocks` (`src/storage.ts:254`) reads the file, `trimEnd`s it, and splits on `\n`. Each line is `JSON.parse`d and handed to `deserializeBlock`. A line that throws is logged at `error` with its 1-based line number and skipped — the loop continues, so one bad line never aborts startup.

`deserializeBlock` (`src/storage.ts:214`) calls `validateBlockShape`, which asserts the header has numeric `version`/`timestamp`/`nonce`, that `previousHash`/`merkleRoot`/`target`/`hash` are all 64-char lowercase hex (via `isValidHash`), and that `height` is a non-negative integer. It enforces `MAX_BLOCK_TRANSACTIONS`, then maps each transaction through `deserializeTransaction`.

`deserializeTransaction` (`src/storage.ts:139`) calls `validateTransactionShape` (string `id`, array `inputs`/`outputs` within `MAX_TX_INPUTS`/`MAX_TX_OUTPUTS`, finite `timestamp`, per-input `txId`/`outputIndex`, per-output `address`/`amount`, optional `claimData` with string `btcAddress`/`qbtcAddress`). It then strips the server-only metadata fields (`blockHash`, `blockHeight`, `confirmations` — those are RPC-response decorations, never persisted state), restores the `TX_INPUT_BINARY_FIELDS` (`publicKey`, `signature`) on each input, and restores the `CLAIM_DATA_BINARY_FIELDS` on `claimData`.

### Bounded hex decoding

Every hex→bytes conversion on the inbound path goes through `safeHexToBytes` (`src/storage.ts:72`), which looks the field up in `BINARY_FIELD_MAX_HEX_LEN` (`src/storage.ts:45`) and throws `Field '<name>' hex string too large` if the string exceeds the cap. The caps are protocol-derived: `publicKey` 3904 (ML-DSA-65 pubkey 1952 bytes), `signature` 6618 (3309-byte sig), `ecdsaPublicKey` 66, `ecdsaSignature` 128, `schnorrPublicKey` 64, `schnorrSignature` 128, `witnessScript` 10240, `witnessSignatures` 3840. This is the storage-layer mirror of the broader DoS hardening in the rest of the node.

### Metadata vs. authoritative state

`metadata.json` holds `{ height, difficulty, genesisHash }` and is written via `saveMetadata` whenever the tip changes. It is a convenience header, **not** authoritative. On startup `Blockchain` replays every block from `blocks.jsonl`, recomputing cumulative work and re-deriving difficulty from block timestamps (`src/chain.ts:79-92`) rather than trusting the stored `difficulty`. The comment at `src/chain.ts:90` is explicit: difficulty is always recomputed so all nodes converge deterministically. A corrupt or stale `metadata.json` therefore cannot fork the chain; `loadMetadata` returns `null` on parse failure and the node proceeds.

## Invariants and edge cases

- **`sanitize` is the only sanctioned binary serializer.** Never hand-roll `Uint8Array`→hex elsewhere (see CLAUDE.md "Serialization boundary"). New binary fields must be added to `TX_INPUT_BINARY_FIELDS` or `CLAIM_DATA_BINARY_FIELDS` *and* given a cap in `BINARY_FIELD_MAX_HEX_LEN`, or they will round-trip as raw strings (outbound) or be left undecoded (inbound).
- **Skip-don't-abort on corruption.** `loadBlocks` tolerates a damaged tail line (e.g. a process killed mid-`appendBlock`). But skipping a *middle* line silently drops a block and leaves a height gap; the replay in `chain.ts` then applies blocks out of contiguity. Corruption is logged, so check storage logs when replay height looks wrong.
- **Replay is the source of truth.** Genesis is always `persisted[0]`. Cumulative work and difficulty come from replaying blocks, not from `metadata.json`.
- **`rewriteBlocks` is the only full-rewrite path** — used by `replaceGenesis` (`src/chain.ts:135`) and reorg persistence (`src/chain.ts:531`). Everything else appends. A trailing newline is written only for a non-empty list, so an empty rewrite produces an empty file (not `"\n"`).
- **Server metadata never persists.** `blockHash` / `blockHeight` / `confirmations` are deleted in `deserializeTransaction`; if they ever appear in `blocks.jsonl` they are stripped on read, so they cannot leak into consensus state.
- **`height` must be a non-negative integer and all four hash fields must be 64-char lowercase hex** or the whole block line is rejected. Uppercase hex fails `isValidHash`.

## Cross-references

- [P2P-SYNC](./P2P-SYNC.md) — the network side that delivers the blocks this layer persists, plus IBD and fork resolution.
- [MINING-LIFECYCLE](./MINING-LIFECYCLE.md) — where freshly mined blocks originate before `appendBlock` writes them.
- [CLAIM-FLOW](./CLAIM-FLOW.md) — the BTC-claim proof fields (`ecdsaSignature`, `schnorrSignature`, `witnessScript`, …) that the `CLAIM_DATA_BINARY_FIELDS` round-trip handles.
- [RPC](./RPC.md) — the RPC layer that decorates transactions with the `blockHash`/`blockHeight`/`confirmations` metadata stripped here on read.
