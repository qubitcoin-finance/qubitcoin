# qbtcd Runtime Lifecycle

How the `qbtcd` daemon turns CLI flags into a running node: argument parsing, snapshot bootstrap, storage replay, P2P/RPC startup, mining gatekeeping, simulation mode, and signal shutdown. Read this when working on `src/qbtcd.ts`, package scripts that launch the daemon, `--full`, `--mine`, `--local`, `--rpc-bind`, `--rpc-trust-proxy`, startup logs like "Restoring from disk" or "Could not sync with seed nodes — refusing to mine on a fork", or process-exit behavior.

This page is about the process boundary. It deliberately does not restate consensus validation, mempool policy, mining internals, P2P sync, RPC route behavior, snapshot parsing, or storage serialization. Those subsystem rules live in the cross-referenced docs at the bottom; `qbtcd` wires them together in a deterministic startup and shutdown order.

## Why It Exists

The daemon is the only place where operator intent, local disk state, external snapshot input, networking, HTTP serving, and optional mining all meet. A bad ordering here can split a node from the network even if every subsystem is correct: mining before initial block download can build on a stale tip, constructing the chain before loading a snapshot can derive the wrong genesis, and starting RPC without the same `Node` object used by P2P would expose a different view than peers are mutating.

`qbtcd.ts` keeps this boundary explicit. It parses flags first, resolves defaults such as public seed selection, downloads and loads a snapshot before chain construction, opens `FileBlockStorage` before `Node` creation, starts P2P before RPC, installs signal handlers before long-running mining/simulation loops, and refuses to mine with configured seeds unless `P2PServer.waitForSync` completes.

The runtime also owns a small amount of local operator state. `dataDir` contains `blocks.jsonl` / `metadata.json` through `FileBlockStorage`, `wallet.json` for the generated miner key, `anchors.json` for recently seen peers, and `banned.json` for P2P bans. These files are intentionally owned by different modules, but the daemon passes the same directory to each so one process has a coherent local identity.

## Key Files

| Anchor | Role |
|---|---|
| `src/qbtcd.ts:37` | `parseArgs`, the CLI parser for flags and key/value options |
| `src/qbtcd.ts:83` | Parsed runtime config shape: ports, snapshot path, data dir, seeds, mining, local mode, RPC trust |
| `src/qbtcd.ts:99` | `SNAPSHOT_URL`, the default `--full` snapshot source |
| `src/qbtcd.ts:104` | `downloadFile`, redirect-limited snapshot downloader writing through `<dest>.tmp` |
| `src/qbtcd.ts:162` | `main`, the daemon lifecycle entrypoint |
| `src/qbtcd.ts:178` | Default public seed injection for `--mine` / `--full` unless `--local` is set |
| `src/qbtcd.ts:183` | `--full` snapshot auto-download and default path resolution |
| `src/qbtcd.ts:197` | Snapshot loading before storage and chain construction |
| `src/qbtcd.ts:212` | `FileBlockStorage` creation using `dataDir` |
| `src/qbtcd.ts:221` | `Node` creation with optional `BtcSnapshot` and storage |
| `src/qbtcd.ts:225` | P2P server startup, local mode, anchors, and seed connection |
| `src/qbtcd.ts:238` | RPC app creation and bind/listen |
| `src/qbtcd.ts:244` | Shutdown state and simulation timer registry |
| `src/qbtcd.ts:246` | `shutdown`, the SIGTERM/SIGINT cleanup sequence |
| `src/qbtcd.ts:261` | Mining wallet load/generate and continuous mining startup |
| `src/qbtcd.ts:291` | IBD wait before mining with seeds |
| `src/qbtcd.ts:306` | Development-only simulation mode |
| `src/qbtcd.ts:359` | Fatal top-level error handler |
| `src/node.ts:35` | `Node.constructor`, where `Blockchain` and `Mempool` are created |
| `src/chain.ts:60` | `Blockchain.constructor`, snapshot index setup and storage replay/genesis creation |
| `src/storage.ts:234` | `FileBlockStorage`, the runtime block/metadata persistence backend |
| `src/p2p/server.ts:99` | `P2PServer.constructor`, P2P state plus `banned.json` / `anchors.json` paths |
| `src/p2p/server.ts:173` | `P2PServer.start`, TCP listener startup |
| `src/p2p/server.ts:200` | `P2PServer.stop`, timers, anchors, peers, and listener shutdown |
| `src/p2p/server.ts:224` | `connectToSeeds`, outbound seed dialing, discovery, and reconnect loop |
| `src/p2p/server.ts:254` | `waitForSync`, the mining preflight barrier |
| `src/p2p/server.ts:1261` | `setLocalMode`, private-address behavior for isolated local runs |
| `src/p2p/server.ts:1316` | `connectToAnchors`, restart-time peer dialing from known addresses |
| `src/rpc.ts:43` | `startRpcServer`, the Express app boundary around the live node |
| `src/rpc-trust-proxy.ts:5` | `parseRpcTrustProxy`, conversion of CLI trust-proxy values into Express config |
| `package.json:21` | `qbtcd` package script |

## Runtime Configuration

### CLI Parser Behavior

`parseArgs` consumes `process.argv.slice(2)` directly. Boolean modes are recognized only by exact flag names: `--simulate`, `--mine`, `--full`, and `--local`. Other `--name value` and `--name=value` pairs are stored in `opts`; unknown option names are not rejected, they are simply ignored unless later read by the returned config.

The returned config applies daemon defaults immediately:

```text
port: 3001
p2pPort: 6001
snapshotPath: null
dataDir: data/node
seeds: []
mine/full/local/simulate: false
message: null
rpcBind: 127.0.0.1
rpcTrustProxy: parseRpcTrustProxy(...)
```

Numeric fields use `parseInt`. The parser does not perform range checks for ports; invalid port values fail later when the TCP or HTTP listener tries to bind. `--seeds` has a special empty-value path: an explicit empty string becomes `[]`, while omitting the option also starts as `[]` and may later receive the default public seed.

### Seed Defaults

After the startup log, `main` adds `qubitcoin.finance:6001` when either `--mine` or `--full` is set, no seeds were supplied, and `--local` is not set. This means `pnpm run qbtcd -- --mine` is networked by default, while `pnpm run qbtcd -- --mine --local` remains isolated.

Plain relay-only startup without `--full`, `--mine`, or explicit `--seeds` starts a P2P listener but does not dial a public seed by default. It can still accept inbound peers and connect to persisted anchors if `anchors.json` exists in the data directory.

### RPC Binding and Proxy Trust

The daemon passes `rpcBind` and `rpcTrustProxy` into `startRpcServer`. `--rpc-bind` controls the address passed to `app.listen`; default loopback binding keeps RPC local. `parseRpcTrustProxy` accepts the default proxy list, `false` / `0` / `off` / `none`, `true` / `on`, positive integer hop counts, or comma-separated proxy labels/networks.

Invalid numeric-looking trust-proxy values such as `-1` or `1.5` throw during config parsing. That error reaches the top-level `main().catch`, logs "Fatal error", and exits with status 1 before any snapshot, storage, P2P, or RPC work begins.

## Startup Order

The daemon startup is intentionally linear:

```text
parse CLI
log config
maybe inject default seed
maybe download snapshot for --full
maybe load snapshot
open FileBlockStorage
log existing metadata if present
construct Node
start P2P listener
enable local mode / connect anchors / connect seeds
start RPC listener
install shutdown handlers
maybe load/generate miner wallet
maybe wait for P2P sync
maybe start continuous mining
maybe start simulation timers
```

This order is the runtime invariant. Anything that needs to influence genesis must happen before `new Node(...)`. Anything that should observe and mutate live chain state must receive that exact `Node` instance. Anything that can run forever must be installed after shutdown hooks and must be stoppable by those hooks.

### Snapshot Bootstrap

`--snapshot <path>` directly loads the provided NDJSON file. `--full` without `--snapshot` creates `dataDir`, checks for `qbtc-snapshot.jsonl`, and downloads the default snapshot only if that file is missing. Downloads write to `qbtc-snapshot.jsonl.tmp` and rename to the final path on stream finish, avoiding a final-path partial file when the process dies mid-download.

`downloadFile` follows up to five HTTP 301/302 redirects. After the first request, redirects must stay HTTPS, preventing a snapshot source from silently downgrading to cleartext. A request timeout destroys the request after 30 seconds. Any rejected download aborts startup through the fatal top-level handler.

Once `snapshotPath` is resolved, `loadSnapshot` runs before storage and chain creation. With `--full`, `qbtcd` also derives `createForkGenesisBlock(snapshot)` for an integrity log that includes the snapshot merkle root prefix and genesis hash prefix. The consensus-bearing snapshot parsing and deterministic genesis rules live in [SNAPSHOT-PIPELINE](./SNAPSHOT-PIPELINE.md).

### Storage and Chain Construction

`FileBlockStorage` is created before `Node`, and its constructor creates `dataDir` if needed. `qbtcd` calls `loadMetadata` only for an operator-facing "Restoring from disk" log; `Blockchain.constructor` owns the actual replay by calling `storage.loadBlocks`.

When persisted blocks exist, the chain uses the first persisted block as genesis, replays the remaining blocks into in-memory indexes, recomputes cumulative work, and recomputes difficulty at retarget intervals. Metadata is not trusted for consensus difficulty. When no persisted blocks exist, the chain creates a snapshot-derived fork genesis if a snapshot was loaded, otherwise the built-in genesis.

The important runtime consequence is that `--snapshot` affects only fresh storage unless the persisted chain is absent or replaced through the normal chain logic. A node with existing `blocks.jsonl` restores from disk first; snapshot data still loads into `btcSnapshot` and claim indexes, but the genesis block comes from persisted storage.

### P2P Before RPC

`qbtcd` constructs `P2PServer(node, p2pPort, dataDir)` before starting RPC. The constructor wires `node.onNewBlock` and `node.onNewTransaction` to P2P broadcast hooks, and it initializes ban/anchor persistence paths under the same data directory.

`await p2p.start()` opens the TCP listener before any outbound dialing. If `--local` is set, `setLocalMode(true)` is applied after the listener starts and before anchor/seed connection. `connectToAnchors` dials persisted known addresses from `anchors.json`; `connectToSeeds` dials configured seeds, starts peer discovery, and starts periodic seed reconnect logic.

RPC starts after the P2P object exists, so `/api/v1/status` and peer endpoints can reflect the same peer set that receives broadcasts. `startRpcServer` returns an Express app; `qbtcd` then calls `listen` with the parsed port and bind address and logs the URL when the HTTP server is listening.

## Mining Mode

### Wallet State

`--mine` makes the daemon use `dataDir/wallet.json` as the miner identity. If the file exists, qbtcd parses hex `publicKey` and `secretKey` fields into `Uint8Array` values and reuses the stored address. If parsing fails for any reason, it logs a warning and generates a replacement wallet.

When no valid wallet exists, `generateWallet` creates a new ML-DSA-65 keypair and the daemon writes `wallet.json` with hex public/secret keys plus the address. This file contains private key material and should be treated as sensitive local operator state.

### Sync Gate

If mining is enabled and the seed list is non-empty, `qbtcd` waits up to 15 seconds for `p2p.waitForSync`. Failure is fatal: it logs "Could not sync with seed nodes — refusing to mine on a fork" and exits with status 1. This is a process-level safety check that prevents a miner from starting on an isolated or stale chain when it expected to join the public network.

If there are no seeds, the sync gate is skipped. That is intentional for `--local` isolated runs and manual topologies where the operator does not want the daemon to require a seed before mining.

After the gate, `node.startMining(minerWallet.address, message)` is called without `await`. The continuous async miner owns its loop and can be aborted by peer blocks, reorg resets, or shutdown through `Node.stopMining`.

## Simulation Mode

`--simulate` is a development mode layered on top of the same `Node` instance. It creates three in-memory wallets, pins `node.chain.difficulty` to `INITIAL_TARGET` before each simulated mine, mines starter blocks on a fresh chain, schedules one block every 10 seconds, schedules one synthetic transaction every 15 seconds, and schedules one initial transaction after 2 seconds.

Simulation timer handles are pushed into `simulationTimers`, so signal shutdown can clear them before stopping mining and P2P. The mode uses synchronous `node.mine` for predictable development activity and should not be treated as production behavior.

## Shutdown and Fatal Errors

`qbtcd` installs one-shot `SIGTERM` and `SIGINT` handlers after RPC starts and before mining/simulation begins. The `shuttingDown` guard makes repeated signals no-op after the first cleanup starts.

Shutdown order is:

```text
clear simulation timers
node.stopMining()
await p2p.stop()
close RPC server
process.exit(0)
```

`node.stopMining` flips the mining flag, aborts any active mining round, and clears live mining stats. `p2p.stop` clears reconnect/discovery timers, clears fork-resolution state, saves anchors, disconnects all peers, and closes the TCP listener. RPC closes last so in-flight HTTP requests are not cut off before the node and P2P objects begin cleanup.

Unexpected startup/runtime errors that reject `main` are handled by the final `main().catch`. The daemon logs a fatal error and exits with status 1. Errors thrown inside detached asynchronous work must still be handled by that subsystem; only awaited startup phases and synchronous startup exceptions reach this top-level catch.

## Invariants and Edge Cases

### Genesis Inputs Must Precede Node Construction

Snapshot choice is locked in at `new Node('node', snapshot, storage)`. If a new flag or runtime mode needs to alter fork genesis, BTC snapshot metadata, or the storage backend, it must run before that line. Changing snapshot inputs after `Node` construction leaves `Blockchain.blocks[0]`, indexes, and claim context out of sync.

### Disk Restore Wins Over Fresh Genesis

`Blockchain.constructor` restores persisted blocks before creating a new genesis. This protects existing nodes from accidental genesis replacement when an operator later adds `--snapshot` or `--full`, but it also means debugging a wrong-genesis local test must start with the data directory contents, not just the CLI flags.

### Mining With Seeds Requires Sync

The only process-level block against accidental fork mining is the `config.seeds.length > 0` gate before `startMining`. Changes to seed defaults, `--local`, or custom seed parsing can therefore change mining safety. If a future launch path auto-populates peers somewhere else, it should preserve this "expected network means wait for sync" behavior.

### RPC and P2P Share One Node

RPC, P2P, mining, and simulation all operate against the same `Node` object. Do not create a second `Node` for a new service surface inside `qbtcd`; doing so would split mempool admission, chain height, P2P broadcasts, and status reporting.

### Local Mode Is Not Offline Mode

`--local` prevents default seed injection and enables P2P local-mode address behavior. It does not disable the P2P listener, RPC server, anchors, or explicit seeds. A local run can still connect outward if the operator supplies `--seeds`, and it can still accept inbound peers on the configured P2P port.

### Detached Mining Is Intentional

`node.startMining` is not awaited because it is a long-running loop. Shutdown reaches it through `node.stopMining`, and peer blocks reach it through aborts in `Node.receiveBlock`. Awaiting it in `main` would prevent simulation setup and the final ready log from running.

### Wallet Regeneration Can Change Miner Address

A corrupt `wallet.json` is not fatal. The daemon logs a warning and generates a new wallet, which changes the coinbase destination for subsequent mined blocks. Existing chain state is unaffected, but operators debugging "wrong miner address" should check for the "Corrupt wallet file — generating new wallet" log.

## Cross-References

- [NODE-ORCHESTRATION](./NODE-ORCHESTRATION.md) explains how the `Node` object coordinates chain, mempool, mining, P2P callbacks, and RPC submission after the daemon constructs it.
- [SNAPSHOT-PIPELINE](./SNAPSHOT-PIPELINE.md) covers `loadSnapshot`, deterministic snapshot metadata, fork genesis construction, and O(1) claim lookup.
- [BLOCK-STORAGE](./BLOCK-STORAGE.md) covers `FileBlockStorage`, `blocks.jsonl`, `metadata.json`, storage replay, and serialization boundaries.
- [P2P-SYNC](./P2P-SYNC.md) covers handshake, IBD, peer discovery, fork resolution, anchors, bans, and relay behavior after `qbtcd` starts P2P.
- [RPC](./RPC.md) covers deployment-facing `--rpc-trust-proxy` behavior and rate-limit client IP handling.
- [RPC-ENDPOINTS](./RPC-ENDPOINTS.md) covers the `/api/v1` route catalog exposed by `startRpcServer`.
- [MINING-LIFECYCLE](./MINING-LIFECYCLE.md) covers candidate assembly, non-blocking PoW, abort-on-new-tip, difficulty retargeting, and subsidy logic.
- [MEMPOOL-LIFECYCLE](./MEMPOOL-LIFECYCLE.md) covers transaction admission and revalidation once RPC, P2P, mining, or simulation submit transactions into the live node.
