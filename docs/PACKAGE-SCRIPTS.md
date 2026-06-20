# Package Scripts and Entrypoints

How root and website `pnpm` scripts map to TypeScript entrypoints, shell wrappers, tests, local nodes, production-adjacent tools, and data-mutating snapshot commands. Read this when changing `package.json`, `website/package.json`, `src/qbtcd.ts` CLI wiring, `src/tools/*`, `scripts/*.sh`, Playwright command names, or when debugging "which command actually runs this code?"

This page is a command-surface catalog, not a replacement for the subsystem docs. It explains which script owns each runnable path, whether it is local-only or production-adjacent, and what state it can touch. Search terms that should land here include `pnpm run qbtcd`, `pnpm run mine`, `pnpm run claim:generate`, `pnpm run convert-snapshot`, `pnpm run dump-and-convert`, `pnpm run website:screenshots`, `pnpm run q`, `ship`, `generate-snapshot`, and `snapshot:activate`.

## Why It Exists

The repo exposes several different command families through one root `package.json`: cryptography demos, daemon startup, local multi-node testing, BTC claim tooling, snapshot conversion, backend tests, website wrappers, traffic generation, production monitoring, and snapshot activation. Some are harmless local demos. Others touch remote production hosts, regenerate snapshot data, wipe chain replay files, or rely on historical container names.

That mix is useful but easy to misread. A maintainer looking only at the script name cannot always tell whether a command runs local TypeScript, shells into `qubitcoin@goro`, builds static website assets, starts a long-running node, or mutates snapshot/chain state. The active deployment path is GitHub Actions plus `docker compose`; several shell scripts remain as manual or legacy support. The command layer needs its own map so changes to package scripts do not accidentally bypass the code paths documented in `QBTCD-RUNTIME`, `OPERATOR-TOOLS`, `WEBSITE-QA`, or `DEPLOYMENT-SURFACES`.

The most important split is between "entrypoint wrappers" and "workflow owners". Most `pnpm` scripts are thin wrappers over one TypeScript file, so behavior belongs to that file. The workflow scripts under `scripts/` are different: they compose SSH, Docker, rsync, Bitcoin Core RPC, snapshot conversion, and process restarts. Those should be treated as operator procedures, not library entrypoints.

## Key Files

| Anchor | Role |
|---|---|
| `package.json:5` | Root package manager pin for the backend workspace. |
| `package.json:7` | Root `scripts` object, the command surface for backend, tools, website wrappers, and operator wrappers. |
| `package.json:9` | `build`, the TypeScript compiler check for `src/`. |
| `package.json:10` | `start`, the aggregate PQC demo entrypoint. |
| `package.json:16` | `blockchain`, the in-process simulation wrapper. |
| `package.json:17` | `claim`, full interactive BTC claim flow. |
| `package.json:18` | `claim:generate`, offline claim transaction creation. |
| `package.json:19` | `claim:send`, online claim transaction broadcast. |
| `package.json:21` | `qbtcd`, the canonical daemon wrapper. |
| `package.json:23` | `node:alice`, first local multi-node script. |
| `package.json:26` | `convert-snapshot`, local snapshot converter entrypoint. |
| `package.json:27` | `dump-and-convert`, converter with Bitcoin Core dump enabled. |
| `package.json:28` | `test`, the one-shot Vitest suite. |
| `package.json:31` | `website`, root wrapper for the Vite dev server. |
| `package.json:33` | `website:screenshots`, root wrapper for Playwright screenshots. |
| `package.json:34` | `dev:tx`, live RPC traffic generator. |
| `package.json:35` | `ship`, reminder shim for automatic deployment. |
| `package.json:36` | `generate-snapshot`, remote snapshot generation shell wrapper. |
| `package.json:37` | `snapshot:activate`, remote snapshot activation shell wrapper. |
| `package.json:38` | `q`, production monitoring wrapper. |
| `website/package.json:4` | Website package manager pin. |
| `website/package.json:6` | Website-local scripts used directly and by root wrappers. |
| `src/qbtcd.ts:36` | Daemon CLI parser for the `qbtcd`, `mine`, and `node:*` scripts. |
| `src/tools/claim-btc.ts:689` | Claim tool mode dispatch: default full flow, `generate`, or `send`. |
| `src/tools/convert-snapshot.ts:191` | Snapshot converter argument parser. |
| `src/tools/convert-snapshot.ts:737` | Snapshot converter main dispatch. |
| `src/dev-tx.ts:16` | Traffic generator RPC and wallet path defaults. |
| `scripts/q.ts:17` | Production monitor container names. |
| `scripts/generate-snapshot.sh:17` | Remote host and paths for snapshot generation. |
| `scripts/activate-snapshot.sh:48` | Snapshot symlink update and chain-data reset path. |
| `docker-compose.yml:5` | Active compose service name, `qbtc-miner`. |
| `.github/workflows/deploy.yml:111` | Active deployment job boundary for compose-managed backend. |

## Command Families

### Build and Tests

The root `build` script runs `tsc` over the backend TypeScript project. It does not build the website. That distinction matters because backend runtime scripts use `ts-node` with transpilation behavior, while `pnpm build` is the explicit typecheck gate for `src/` changes.

The root `test`, `test:verbose`, and `test:watch` scripts all call Vitest. They are backend tests; browser coverage lives under the website workspace. When a change touches `src/`, the normal verification pair is `pnpm test` plus `pnpm build`.

Website build and browser verification are separate:

```text
root package.json
  website           -> cd website && pnpm run dev
  website:build     -> cd website && pnpm run build
  website:screenshots -> cd website && pnpm run screenshots

website/package.json
  dev         -> vite
  build       -> vite build
  preview     -> vite preview
  test:visual -> playwright test
  screenshots -> playwright test && echo screenshot location
```

`website/playwright.config.ts` starts `pnpm run build && pnpm run preview` on port `4173` before Playwright tests. Running `pnpm run website:screenshots` from the root therefore crosses into the website project, builds the Vite app, serves it with `vite preview`, and runs the viewport matrix.

### Cryptography Demos

The `start`, `kem`, `sign`, `hash-sign`, `hybrid`, and `bench` scripts are educational post-quantum cryptography demos and benchmarks. They execute TypeScript files directly through `node --loader ts-node/esm`.

`start` runs `src/index.ts`, which imports and executes ML-KEM, ML-DSA, SLH-DSA, hybrid, and benchmark demos in one process. The individual scripts run one demo each. These scripts do not start a node, mutate chain state, or participate in consensus. They are covered by [PQC-ALGORITHM-SUITE](./PQC-ALGORITHM-SUITE.md).

### Daemon and Local Nodes

`qbtcd` is the canonical daemon script. It wraps `src/qbtcd.ts`, whose parser accepts flags such as `--port`, `--p2p-port`, `--snapshot`, `--datadir`, `--seeds`, `--mine`, `--full`, `--local`, `--message`, `--rpc-bind`, `--rpc-trust-proxy`, and `--simulate`.

`mine` is only a convenience wrapper for the same daemon with `--mine` pre-applied. It does not change the daemon's default port, data directory, seed behavior, or snapshot behavior by itself.

The `node:alice`, `node:bob`, and `node:charlie` scripts are fixed local multi-node profiles. They run the same daemon with different RPC ports, P2P ports, data directories, mining flags, and seed lists:

```text
node:alice   -> port 3001, p2p 6001, data/alice, mining
node:bob     -> port 3002, p2p 6002, data/bob, seed 127.0.0.1:6001
node:charlie -> port 3003, p2p 6003, data/charlie, seeds 6001 and 6002
```

These are development profiles, not production topology. Production compose uses `qbtc-miner`, RPC `3010`, host networking, `/home/qubitcoin/qbtc-data`, and `/snapshot.jsonl`.

### Claims

`claim`, `claim:generate`, and `claim:send` all wrap `src/tools/claim-btc.ts`.

The tool dispatches by first CLI argument:

```text
no mode    -> modeFull()
generate   -> modeGenerate()
send <file> -> modeSend(file)
```

The full flow connects to `QBTC_RPC` or `http://127.0.0.1:3001`, fetches `/api/v1/status` and `/api/v1/claims/stats`, asks for BTC credentials, generates a new ML-DSA-65 QBTC wallet, derives the snapshot hash from genesis, probes the expected amount through the node, then broadcasts to `/api/v1/tx`.

The offline `claim:generate` path creates a signed claim transaction file without broadcasting. The online `claim:send` path reads a saved JSON transaction and broadcasts it. The claim construction and validation rules are documented in [CLAIM-FLOW](./CLAIM-FLOW.md); this page only maps the command names to modes.

### Snapshot Conversion

`convert-snapshot` runs `src/tools/convert-snapshot.ts` with no extra flags. The converter defaults to the full local pipeline: read a `dumptxoutset` binary, extract claimable coins into a work directory, aggregate balances, compute the snapshot merkle root, and write the final NDJSON snapshot.

`dump-and-convert` runs the same converter with `--dump --force`. In the converter itself, `--dump` enables the Bitcoin Core `dumptxoutset` phase before extract and aggregate. `--force` permits replacing an existing output file. This is a data-generating command, not a normal build command.

The converter also supports explicit `extract` and `aggregate` subcommands. `parseArgs` strips a literal `--` separator, detects the subcommand, and assigns defaults:

```text
extract   -> input, workdir
aggregate -> workdir, output, gzip, force, postfix
full      -> input, workdir, output, gzip, force, postfix, dump
```

The root package scripts expose only the default full path and the dump-enabled full path. Manual subcommand use goes through the same entrypoint with extra arguments.

### Remote Snapshot Shell Wrappers

`generate-snapshot` runs `scripts/generate-snapshot.sh`. That shell script connects to `qubitcoin@goro`, syncs the project, installs dependencies, optionally runs Bitcoin Core `dumptxoutset`, then runs the converter's `extract` and `aggregate` phases on the remote host.

`snapshot:activate` runs `scripts/activate-snapshot.sh`. It finds or accepts a snapshot version, verifies the remote file, updates `~/qbtc-snapshot.jsonl`, removes `blocks.jsonl` and `metadata.json` from remote chain data paths, restarts processes through `pm2`, and checks RPC status.

These two commands are operationally sensitive. They should not be treated like local verification commands because they can regenerate snapshot data, change the active snapshot symlink, and reset chain replay files on the remote machine.

### Website Wrappers

The root website scripts are just convenience wrappers into `website/`; they do not share the backend `tsconfig.json` or Vitest suite.

`website` starts Vite dev mode. `website:build` runs Vite production build. `website:screenshots` runs the website-local `screenshots` script, which in turn runs Playwright. The website-local `test:visual` and `screenshots` both run `playwright test`; the `screenshots` script only adds a message about `tmp/screenshots/`.

Website command behavior is documented further in [WEBSITE-QA](./WEBSITE-QA.md), while the static landing/explorer shell is documented in [WEBSITE-LANDING](./WEBSITE-LANDING.md).

### Traffic Generation

`dev:tx` runs `src/dev-tx.ts`. It defaults to RPC `http://127.0.0.1:3001` and wallet file `data/node/wallet.json`, but accepts positional overrides. The script reads the miner wallet, fetches UTXOs through `/api/v1/address/:address/utxos`, creates signed transactions to generated recipient wallets, posts them to `/api/v1/tx`, and repeats every three seconds.

This is a live-node traffic generator for local or controlled environments. It expects a mining node with a wallet file and spendable mature UTXOs. It is covered with the other development simulations in [DEV-SIMULATIONS](./DEV-SIMULATIONS.md).

### Production Monitoring and Legacy Deploy Helpers

`q` runs `scripts/q.ts`. It SSHes to `qubitcoin@goro`, fetches RPC status from `127.0.0.1:3010` and `127.0.0.1:3011`, displays recent blocks, checks Docker containers, and tails logs.

The current `q` script still names `qbtc-node`, `qbtc-q`, and `qbtc-devtx` as its known containers. The active compose deployment in `docker-compose.yml` defines `qbtc-miner`, and `.github/workflows/deploy.yml` includes a one-shot adoption step to remove legacy non-compose containers. Treat `q` as production-adjacent monitoring for the historical multi-container stack unless its container list is updated.

`ship` is only a reminder shim. It prints that deployment is automatic after pushing to `main`, but its message points at `.github/workflows/docker.yml`. The active workflow is `.github/workflows/deploy.yml`.

`scripts/deploy.sh`, `scripts/deploy-backend.sh`, and `scripts/deploy-ui.sh` are manual SSH deployment helpers. They start or update older direct-Docker containers and static website files. They are not the active push-to-main deployment path described by the workflow and compose files.

## How It Works

The command layer has three levels:

```text
pnpm script
  -> TypeScript entrypoint or shell script
    -> subsystem owner

examples:
  pnpm run qbtcd
    -> src/qbtcd.ts
      -> Node, Blockchain, P2PServer, RPC, FileBlockStorage

  pnpm run claim:send <file>
    -> src/tools/claim-btc.ts send
      -> fetch /api/v1/status, POST /api/v1/tx

  pnpm run website:screenshots
    -> cd website && pnpm run screenshots
      -> Playwright config, Vite build, vite preview

  pnpm run snapshot:activate
    -> scripts/activate-snapshot.sh
      -> remote symlink, chain replay files, process restart
```

For TypeScript entrypoints, the script usually contains no logic beyond choosing the file and static arguments. Behavior changes should happen in the owning TypeScript module, and the script should stay a readable wrapper.

For shell wrappers, the script is the workflow. Those files encode remote hosts, bind paths, container names, snapshot paths, and service-control steps. Updating one requires checking [DEPLOYMENT-SURFACES](./DEPLOYMENT-SURFACES.md), [OPERATOR-TOOLS](./OPERATOR-TOOLS.md), and the active workflow/compose topology.

## Invariants and Edge Cases

- **Use `pnpm`, not npm.** Both root and website manifests declare `packageManager: pnpm@9.15.9`. The project may plan an upgrade, but current scripts and lockfiles are pnpm-shaped.

- **Root build is backend-only.** `pnpm build` runs `tsc`; it does not run `cd website && pnpm build`. Website changes need website verification separately.

- **Root tests are backend-only.** `pnpm test` runs Vitest. Browser rendering and responsive checks are under `website/` through Playwright.

- **`qbtcd` owns daemon flags.** `mine` and `node:*` are wrappers over the same parser. Add or change daemon options in `src/qbtcd.ts`, then keep wrapper scripts consistent.

- **`claim:*` modes are positional.** The claim tool dispatches on `process.argv[2]`. `pnpm run claim:send <file>` must preserve the file argument after the fixed `send` token.

- **Snapshot commands are not ordinary maintenance commands.** `dump-and-convert`, `generate-snapshot`, and `snapshot:activate` can create or replace snapshot outputs, interact with Bitcoin Core, or reset chain replay files. Verify paths and operator intent before running them.

- **Manual deployment scripts are not the active CI/CD path.** The active backend deployment uses `.github/workflows/deploy.yml` and `docker-compose.yml`. Direct SSH scripts still exist, but their container names and topology differ.

- **The `q` monitor can drift from compose.** It currently expects `qbtc-node`, `qbtc-q`, and `qbtc-devtx`, while compose owns `qbtc-miner`. If production monitoring behavior changes, reconcile this script with the active deployment surface.

- **`ship` is informational.** It does not deploy. Its output is a reminder string, not a workflow invocation.

## Cross-References

- [QBTCD-RUNTIME](./QBTCD-RUNTIME.md) for daemon CLI parsing, startup order, snapshot bootstrap, RPC/P2P startup, mining gates, and shutdown.
- [OPERATOR-TOOLS](./OPERATOR-TOOLS.md) for snapshot conversion, activation, BTC claim generation, and production monitoring workflows.
- [DEPLOYMENT-SURFACES](./DEPLOYMENT-SURFACES.md) for active GitHub Actions deployment, compose topology, static website publishing, and manual script boundaries.
- [WEBSITE-QA](./WEBSITE-QA.md) for Playwright, screenshots, Vite preview, mocked API responses, and browser verification.
- [WEBSITE-LANDING](./WEBSITE-LANDING.md) for the shared static website shell that the website scripts build.
- [CLAIM-FLOW](./CLAIM-FLOW.md) for BTC ownership proof construction, claim validation, and claim maturity.
- [SNAPSHOT-PIPELINE](./SNAPSHOT-PIPELINE.md) for snapshot NDJSON loading, merkle commitment, and fork genesis construction.
- [DUMPTXOUTSET-FORMAT](./DUMPTXOUTSET-FORMAT.md) for the Bitcoin Core binary UTXO dump format consumed by snapshot conversion.
- [DEV-SIMULATIONS](./DEV-SIMULATIONS.md) for the in-process demos and the live RPC traffic generator.
- [PQC-ALGORITHM-SUITE](./PQC-ALGORITHM-SUITE.md) for the standalone post-quantum demo and benchmark scripts.
