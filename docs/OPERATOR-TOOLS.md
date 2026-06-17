# Operator Tools

How QubitCoin's command-line tools move data around the node: Bitcoin UTXO dumps into snapshot NDJSON, snapshot activation on the production host, interactive BTC claim transaction generation, and production status/log inspection. Read this when working on `src/tools/convert-snapshot.ts`, `src/tools/parse-utxoset.ts`, `src/tools/claim-btc.ts`, `scripts/generate-snapshot.sh`, `scripts/activate-snapshot.sh`, `scripts/q.ts`, or package scripts such as `convert-snapshot`, `claim:generate`, `snapshot:activate`, and `q`.

These tools sit outside the long-running node. They are allowed to use terminal-oriented `console.log` / `console.error`, filesystem checkpoints, SSH, Docker logs, and Bitcoin Core RPC because their job is operator workflow, not consensus execution. The important boundary is that generated data still flows back through normal implementation gates: snapshots are later parsed by `loadSnapshot`, claim JSON is broadcast through `POST /api/v1/tx`, and monitoring reads public RPC/status endpoints instead of mutating node internals.

## Why It Exists

Most QubitCoin state transitions are automatic once `qbtcd` is running, but several workflows need explicit operator tooling:

1. A Bitcoin Core `dumptxoutset` binary is too large and specialized for the daemon to parse at startup, so `convert-snapshot.ts` turns it into compact QBTC snapshot NDJSON ahead of time.
2. Snapshot generation and activation are production operations against `qubitcoin@goro`; the shell wrappers encode the remote paths and sequencing so maintainers do not have to reconstruct them manually.
3. BTC claims require private-key handling and user choices, so `claim-btc.ts` keeps signing interactive and can split offline generation from online broadcast.
4. Production debugging needs one fast dashboard for RPC health plus Docker logs, so `scripts/q.ts` wraps the common SSH, curl, and `docker logs` checks.

The tools are intentionally not hidden behind daemon flags. Snapshot conversion can run for a long time, uses resumable work files, and may call Bitcoin Core's `dumptxoutset`. Snapshot activation wipes chain replay files on the remote host. Claim generation may touch BTC private keys. Keeping these as explicit commands makes their side effects visible.

## Key Files

| Anchor | Role |
|---|---|
| `package.json:17` | `claim`, `claim:generate`, and `claim:send` script entrypoints. |
| `package.json:26` | `convert-snapshot` entrypoint for local or remote snapshot conversion. |
| `package.json:36` | `generate-snapshot`, the production snapshot-generation wrapper. |
| `package.json:37` | `snapshot:activate`, the production snapshot-activation wrapper. |
| `package.json:38` | `q`, the production monitoring wrapper. |
| `src/tools/convert-snapshot.ts:191` | `parseArgs`, including `extract`, `aggregate`, `--dump`, `--gzip`, `--force`, and `--postfix`. |
| `src/tools/convert-snapshot.ts:271` | `runExtract`, the resumable binary-dump to `coins.jsonl` phase. |
| `src/tools/convert-snapshot.ts:441` | `aggregateCoins`, the external-sort and address aggregation phase. |
| `src/tools/convert-snapshot.ts:602` | `finalizeSnapshot`, the streaming merkle-root and final NDJSON writer. |
| `src/tools/parse-utxoset.ts:315` | `parseHeader`, validates the `dumptxoutset` v2 header. |
| `src/tools/parse-utxoset.ts:351` | `parseDumptxoutset`, streams parsed UTXOs with optional resume state. |
| `src/tools/claim-btc.ts:302` | `modeGenerate`, offline claim transaction construction. |
| `src/tools/claim-btc.ts:414` | `modeSend`, online broadcast of a saved claim JSON file. |
| `src/tools/claim-btc.ts:486` | `modeFull`, interactive generate-and-broadcast flow. |
| `scripts/generate-snapshot.sh:17` | Remote host/path constants for snapshot generation on `goro`. |
| `scripts/activate-snapshot.sh:13` | Version selection for snapshot activation. |
| `scripts/q.ts:17` | Production container and RPC endpoint constants for monitoring. |

## Command Surface

The root `package.json` exposes three classes of tools:

```text
Claim tools:
  pnpm run claim
  pnpm run claim:generate
  pnpm run claim:send <claim-file.json>

Snapshot tools:
  pnpm run convert-snapshot -- [extract|aggregate] [flags]
  pnpm run dump-and-convert
  pnpm run generate-snapshot
  pnpm run snapshot:activate [version]

Production inspection:
  pnpm run q -- [status|logs|node|q|devtx] [--tail N] [-f]
```

`convert-snapshot` and `claim-btc` run under `node --loader ts-node/esm`, matching the rest of the TypeScript CLI entrypoints. `generate-snapshot`, `snapshot:activate`, and `q` are deployment-oriented helpers that assume access to `qubitcoin@goro` and to remote services or containers.

## Snapshot Conversion Flow

`src/tools/convert-snapshot.ts` converts a Bitcoin Core UTXO dump into the snapshot format consumed by the daemon. It has three logical phases:

```text
optional --dump
  Bitcoin Core RPC dumptxoutset -> utxos.dat

extract
  utxos.dat -> workdir/header.json + workdir/coins.jsonl + workdir/checkpoint.json

aggregate
  coins.jsonl -> sorted-coins*.jsonl -> balances*.jsonl -> qbtc-snapshot*.jsonl
```

The `--dump` path calls Bitcoin Core RPC on `127.0.0.1:8332` using the local `.cookie`, refuses to proceed if Bitcoin Core is still in initial block download, removes an existing output dump because `dumptxoutset` will not overwrite it, and records the dump height/hash/timestamp for later snapshot metadata.

### Extract

`runExtract` reads the binary header through `parseHeader`, writes `header.json`, and appends claimable coins to `coins.jsonl`. Each line is compact JSON with address hash `a`, satoshi balance `b`, and script type `t`.

The phase accepts P2PKH, P2WPKH, P2SH, P2TR, P2PK, P2WSH, and bare multisig coins. Other script types are skipped and summarized by count/value at the end. This is a tooling filter only; claim validity is still enforced later by snapshot loading, `verifyClaimProof`, mempool policy, and chain acceptance.

Extraction is resumable. `CHECKPOINT_INTERVAL` is 5,000,000 coins, and checkpoints are written only at transaction-group boundaries so `parseDumptxoutset` can resume from a valid byte offset. On restart, the tool truncates `coins.jsonl` back to the checkpointed byte length before continuing.

### Aggregate

`runAggregate` requires `coins.jsonl`; if it is missing, it exits with an instruction to run extract first. The aggregation has two sub-phases:

1. `aggregateCoins` uses the system `sort` command with a temp directory inside `workdir`, then streams sorted lines into `balances*.jsonl` and `balances-meta*.json`.
2. `finalizeSnapshot` streams balances twice: once to compute the snapshot merkle root and once to write final NDJSON, optionally through gzip.

The final snapshot starts with a header line containing height, hash, optional timestamp, address count, merkle root, script-type coin counts, and `totalClaimableSats`. The remaining lines contain compact address entries.

The converter preserves `workdir` after completion. That is deliberate: it allows rerunning aggregate/finalize without reparsing the binary dump, and it lets maintainers inspect intermediate files before removing them manually.

## UTXO Dump Parser

`src/tools/parse-utxoset.ts` is the low-level reader for Bitcoin Core's `dumptxoutset` v2 binary format. It is not a general Bitcoin script engine; it extracts enough information for snapshot construction.

`parseHeader` enforces the magic bytes and version, then returns the stored block hash and coin count. `parseDumptxoutset` streams transaction-output groups, decodes Bitcoin's MSB-128 varint, decompresses the amount with Bitcoin Core's amount-compression algorithm, and classifies compressed or raw scripts.

Script classification maps standard templates to snapshot address hashes:

| Script shape | Snapshot type |
|---|---|
| compressed P2PKH | `p2pkh` |
| compressed P2SH | `p2sh` |
| compressed/uncompressed P2PK | `p2pk` |
| raw `OP_0 PUSH20` | `p2wpkh` |
| raw `OP_0 PUSH32` | `p2wsh` |
| raw `OP_1 PUSH32` | `p2tr` |
| raw script ending in `OP_CHECKMULTISIG` | `multisig` |
| `OP_RETURN` | `op_return` |
| anything else | `other` |

The parser's resume contract matters: the caller must only resume at a transaction-group boundary. `runExtract` enforces that by checkpointing only when `coin.isGroupEnd` is true.

## Production Snapshot Wrappers

`scripts/generate-snapshot.sh` is a remote production wrapper. It syncs the current working tree to `/home/qubitcoin/qubitcoin` on `qubitcoin@goro`, installs dependencies, optionally runs Bitcoin Core `dumptxoutset`, then runs `convert-snapshot.ts extract` and `convert-snapshot.ts aggregate` on the remote host with an 8 GB Node heap.

Its default paths are:

| Variable | Path |
|---|---|
| `REMOTE_DIR` | `/home/qubitcoin/qubitcoin` |
| `DUMP_PATH` | `/home/qubitcoin/utxos.dat` |
| `SNAPSHOT_PATH` | `/home/qubitcoin/qbtc-snapshot.jsonl` |
| `WORKDIR` | `/home/qubitcoin/qbtc-work` |

`--skip-dump` reuses an existing remote `utxos.dat`, but the script checks that the file exists before conversion. Without `--skip-dump`, it checks Bitcoin Core status and removes the stale remote dump before asking Bitcoin Core for a fresh one.

`scripts/activate-snapshot.sh` is more destructive. It selects a version from its argument or by auto-detecting the latest remote `~/qtc-snapshot-v*.jsonl`, verifies the remote snapshot header can be read, updates `~/qbtc-snapshot.jsonl`, removes `blocks.jsonl` and `metadata.json` from two remote data directories, restarts PM2 processes, waits 30 seconds, then probes `127.0.0.1:3010/api/v1/status`.

Because activation wipes chain data files on the remote host, it is a deployment operation, not a read-only validation command. Do not use it as a local smoke test or as a shortcut for snapshot inspection.

## Claim CLI Flow

`src/tools/claim-btc.ts` has three modes:

| Mode | Command | Network use | Output |
|---|---|---|---|
| Full | `pnpm run claim` | Reads node RPC and broadcasts | Mined-or-pending claim transaction plus generated QBTC wallet details |
| Generate | `pnpm run claim:generate` | Offline, except user-supplied metadata | Saved `claim-*.json` transaction file |
| Send | `pnpm run claim:send <file>` | Reads node RPC and broadcasts | RPC txid or rejection error |

`QBTC_RPC` overrides the default RPC base URL. Without it, the tool uses `http://127.0.0.1:3001`, then appends `/api/v1`.

### Credential Handling

Single-key claims accept BIP39 seed phrases, WIF keys, or raw 32-byte hex private keys. Seed phrases are expanded over common BIP44, BIP84, BIP49, and BIP86 paths, and the user selects the derived address. WIF and hex inputs present P2PKH/P2WPKH, P2SH-P2WPKH, and P2TR choices.

P2WSH claims ask for a witness script and signer keys. The tool parses the script, derives the script-hash address, verifies that each signer key appears in the script, and sorts signer keys to match script public-key order for multisig signing.

### Offline Generate

`modeGenerate` asks for BTC credentials, snapshot block hash, genesis hash, exact snapshot balance, and then generates a fresh ML-DSA-65 QBTC wallet. It builds a signed claim transaction with either `createClaimTransaction` or `createP2wshClaimTransaction`, sanitizes it for JSON, and writes a local `claim-<prefix>-<timestamp>.json` file.

The saved transaction is intended for `claim:send`. The tool prints the generated QBTC address and key lengths, but it does not persist the QBTC secret key anywhere except terminal output. Losing that key means losing spend authority over the claimed output.

### Full And Send

`modeFull` first checks `/status`, then checks `/claims/stats` to ensure the node has a snapshot. It fetches genesis via `/block-by-height/0` to derive the snapshot hash and genesis hash, then probes `POST /tx` with a zero-amount claim to discover the expected amount from the node's validation error. If the error indicates the address is absent or already claimed, the tool reports that directly.

`modeSend` reads a saved JSON transaction file, validates that it parses, prints the claim summary from the payload, checks `/status`, and posts it to `/tx`. Any consensus, duplicate-claim, amount-mismatch, or mempool-policy rejection comes from the node RPC path, not from the CLI.

## Production Monitor

`scripts/q.ts` is a read-mostly production helper for `qubitcoin@goro`. It knows three container names (`qbtc-node`, `qbtc-q`, `qbtc-devtx`) and two local RPC endpoints on the remote host (`3010` and `3011`).

The default run prints a status dashboard and short Docker logs. `status` suppresses logs, `logs` suppresses the dashboard, container aliases select one container's logs, `--tail` changes log length, and `-f` follows logs.

The dashboard makes one SSH call that curls `/api/v1/status`, `/api/v1/blocks?count=20`, and the second miner's `/api/v1/status`. It then formats height, difficulty, hashrate, peer count, mempool size, UTXO count, timing, miner comparison, Docker container status, and recent blocks. It does not submit transactions, change mining state, or edit remote files.

## Invariants And Edge Cases

- Snapshot conversion output is not trusted just because the tool produced it. `qbtcd` still loads snapshots through `loadSnapshot`, derives fork genesis deterministically, and rejects malformed metadata.
- `convert-snapshot` refuses to overwrite an existing final snapshot unless `--force` is passed. The extract phase may truncate `coins.jsonl` only to a previously written checkpoint.
- `aggregateCoins` depends on the external `sort` executable and on enough disk space in `workdir` for sorted intermediate files.
- `finalizeSnapshot` represents balances as JSON numbers in the final entry lines. Snapshot amounts must remain within JavaScript's safe integer range, matching the rest of the snapshot loader assumptions.
- `generate-snapshot.sh` and `activate-snapshot.sh` assume SSH access to `qubitcoin@goro`; they are not generic deployment scripts.
- `activate-snapshot.sh` mutates remote state by replacing the snapshot symlink, deleting chain replay files, and restarting processes.
- `claim-btc.ts` is a terminal UX tool. Private-key prompts, saved claim JSON files, and printed QBTC wallet details should be handled as sensitive operator material.
- `claim:generate` requires the user to provide exact snapshot and genesis metadata. A wrong hash or amount creates a transaction the node will reject.
- `claim` and `claim:send` rely on the configured RPC node having the intended snapshot loaded. A node without snapshot data fails before a useful claim can be built or accepted.
- `scripts/q.ts` returns blank SSH output as a failed status fetch and keeps log errors on stderr; it is for operator diagnosis, not machine-readable health checks.

## Cross-References

- [SNAPSHOT-PIPELINE](./SNAPSHOT-PIPELINE.md) for how generated snapshot NDJSON becomes fork genesis and an O(1) claim lookup table.
- [CLAIM-FLOW](./CLAIM-FLOW.md) for the consensus-level BTC ownership proof that claim transactions must satisfy.
- [RPC-ENDPOINTS](./RPC-ENDPOINTS.md) for the `/api/v1/status`, `/api/v1/claims/stats`, `/api/v1/block-by-height/:height`, and `POST /api/v1/tx` routes used by these tools.
- [QBTCD-RUNTIME](./QBTCD-RUNTIME.md) for daemon startup, snapshot loading, storage replay, and mining gatekeeping after a snapshot is selected.
- [BLOCK-STORAGE](./BLOCK-STORAGE.md) for the `blocks.jsonl` / `metadata.json` files that snapshot activation removes on the remote host.
- [CRYPTO-PRIMITIVES](./CRYPTO-PRIMITIVES.md) for ML-DSA-65 wallet generation and secp256k1 ECDSA/Schnorr helpers used by the claim CLI.
