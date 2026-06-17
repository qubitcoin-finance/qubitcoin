# QubitCoin

Post-quantum Bitcoin fork using ML-DSA-65 (Dilithium) signatures. Node.js/TypeScript implementation with UTXO model, SHA-256 PoW, and BTC claim mechanism.

## Quick Reference

- **Repo:** `qubitcoin-finance/qubitcoin`
- **Stack:** TypeScript (ESM), ts-node, Express v5, Vite + Tailwind (explorer)
- **Test:** `pnpm test` (vitest, ~635 tests — count drifts as tests are added)
- **Build:** `pnpm build` (tsc)
- **Run node:** `pnpm run qbtcd -- --mine --full`
- **Package manager:** Use `pnpm` (target `pnpm 11`); both `package.json` and `website/package.json` are still pinned to `pnpm@9.15.9`, so plan an upgrade.
- **Docker image:** `ghcr.io/qubitcoin-finance/qbtcd:main`
- **Containers** (current deployment stack on the self-hosted runner):
  - `qbtc-miner` — host-networked compose service running the miner/node image, RPC on `127.0.0.1:3010`, data `/home/qubitcoin/qbtc-data`, snapshot `/home/qubitcoin/qbtc-snapshot.jsonl` mounted read-only at `/snapshot.jsonl`

## Deployment

### CI/CD Pipeline (push to main)

1. **deploy.yml / build-and-push** — builds multi-arch Docker image, pushes to GHCR (GitHub-hosted runner)
2. **deploy.yml / deploy** — runs on self-hosted runner:
   - Checks out repo, `docker compose pull && docker compose up -d` (uses `docker-compose.yml` at repo root)
   - Builds website (`website/` via Vite) and deploys static files
   - Health check against `127.0.0.1:3010/api/v1/status`
3. **release.yml** — tags and creates GitHub release

Push to `main` triggers automatic deployment. No SSH required.
The legacy `pnpm ship` script still exists as a reminder shim; its message still points at `.github/workflows/docker.yml`, but the active workflow is `.github/workflows/deploy.yml`, and `scripts/deploy.sh` is not part of the current workflow.

**Runner setup:**
- Self-hosted runner registered via GitHub UI (Settings → Actions → Runners)
- Runs `deploy.yml` on push to `main`

### Container Details (backend)

- **Service:** `qbtc-miner`
- **Ports:** 3010 (RPC, bound to `127.0.0.1`)
- **Data:** `/home/qubitcoin/qbtc-data` (persistent bind mount)
- **Snapshot:** `/home/qubitcoin/qbtc-snapshot.jsonl` mounted read-only at `/snapshot.jsonl`
- **Image tag:** `ghcr.io/qubitcoin-finance/qbtcd:main`
- **Networking:** host (`--network host`)
- **Health check:** `curl http://127.0.0.1:3010/api/v1/status`
- **nginx upstream:** `proxy_pass http://127.0.0.1:3010;` in `/etc/nginx/sites-enabled/qubitcoin.finance`

### Website (frontend)

- **Source:** `website/` (Vite + Tailwind static site)
- **Build:** `cd website && pnpm build` → `website/dist/`
- **Deployed to:** self-hosted server (served by nginx)
- **Proxies:** `/api` → backend container RPC endpoint

## Project Structure

- `src/` — Node implementation (qbtcd, crypto, p2p, rpc, mempool, chain)
- `website/` — Block explorer (Vite + Tailwind)
- `ansible/` — Deployment playbooks
- `.github/workflows/` — CI/CD (deploy.yml, release.yml)

## Key Libraries

- `@noble/post-quantum` — ML-DSA-65 (FIPS 204)
- `@noble/curves` — ECDSA secp256k1 (BTC claims)
- `@noble/hashes` — SHA-256, RIPEMD-160

## Coding Conventions

1. **TypeScript strict mode** — `tsconfig.json` enables `strict: true`. Never use `any`; use `unknown` and narrow instead.
2. **ESM imports** — All local imports must use the `.js` extension (e.g. `import { log } from './log.js'`), even for `.ts` source files. This is required by Node ESM loader.
3. **Logging** — Use `import { log } from './log.js'` (pino). Never use `console.log` in production paths; `console.log` is acceptable only in one-off demo/tool scripts.
4. **No linter/formatter** — There is no ESLint or Prettier configured. Maintain consistency with surrounding code style by hand.
5. **Naming** — `camelCase` for variables and functions, `PascalCase` for types/interfaces/classes, `UPPER_SNAKE_CASE` for module-level constants. File names are `kebab-case.ts`.
6. **Error handling** — Throw `Error` with a descriptive message for unrecoverable programmer errors. Return `null` / `false` for expected negative outcomes (e.g. block not found, hash mismatch). Log at `warn` or `error` level before returning a failure from an RPC handler.
7. **Async** — Use `async/await` throughout. No callbacks or raw Promise chains.
8. **Toolchain targets** — Keep backend code compatible with Node.js v20+, TypeScript 6, `ts-node` ESM, and Express v5. Keep website changes compatible with Vite 7, TailwindCSS v4, and Playwright 1.58.
9. **Imports** — Use relative imports; there are no path aliases or barrel-file conventions configured for either `src/` or `website/src/`.
10. **Frontend style** — The website is plain TypeScript plus DOM APIs, not React/Vue. Extend the existing vanilla entrypoints instead of introducing a frontend framework.
11. **Runtime type-check gap** — Root scripts run through `ts-node` with `"transpileOnly": true`. After TypeScript changes, especially import wiring, CLI entrypoints, or shared types, run `pnpm build`; do not assume `pnpm run qbtcd` or other scripts will catch type errors.
12. **CLI/demo exceptions** — Interactive tools under `src/tools/` and demo/simulation files such as `src/*-demo.ts` and `src/*simulation.ts` may use `console.log`/`console.error` for terminal UX. Do not copy those patterns into long-running node, RPC, mempool, chain, or P2P code.

## Architecture & Patterns

1. **Block persistence** — All block reads/writes go through the `BlockStorage` interface (`src/storage.ts`). Never touch the `.jsonl` file directly.
2. **Logging** — Import `log` from `src/log.ts`. Never instantiate a separate pino instance.
3. **Validation helpers** — Use `isValidHash` and `sanitize` from `src/utils.ts` for input sanitisation in RPC handlers. Do not inline regex checks.
4. **Crypto** — All post-quantum operations (`ml-dsa`) go through `src/crypto.ts`. Do not call `@noble/post-quantum` directly from business logic.
5. **New modules** — Node implementation goes in `src/`. Tools/scripts go in `src/tools/`. Tests go in `src/__tests__/` with the `*.test.ts` suffix.
6. **No circular imports** — Dependency order: `utils → log → crypto → block → transaction → snapshot → snapshot-loader → claim → storage → chain → mempool → miner → p2p → rpc → node → qbtcd`. Type-only imports (`import type`) that would create a cycle (e.g. `p2p/server.ts` importing `type Node`) are permitted since they are erased at runtime.
7. **P2P layout** — Keep networking code split under `src/p2p/` (`peer.ts`, `protocol.ts`, `server.ts`). Add new peer/protocol/server concerns there instead of expanding `rpc.ts` or `node.ts`.
8. **Website layout** — Landing-page behavior lives in `website/src/main.ts`, explorer behavior in `website/src/explorer-main.ts`, blog content in `website/src/blog/*.ts`, and browser tests in `website/e2e/*.spec.ts`.
9. **Explorer data flow** — Preserve the explorer’s `/api/v1` base path, hash-based routing, and shared fetch helpers in `website/src/explorer-main.ts` when adding new explorer views or API calls.
10. **Serialization boundary** — When persisting blocks/transactions or exposing binary-heavy structures over JSON, reuse `sanitize`/`sanitizeForStorage` plus `deserializeTransaction`/`deserializeBlock` from `src/storage.ts`. Do not hand-roll `Uint8Array` to hex conversion or parsing logic in new modules.
11. **Website state management** — Keep website interactivity in vanilla TypeScript with module-local state, DOM updates, polling, and URL-hash routing. Do not introduce a frontend router, global state library, or framework-style store for landing-page or explorer changes.

## Testing Rules

1. **Run:** `pnpm test` (vitest, one-shot). `pnpm test:watch` during development.
2. **Pre-push hook** — husky runs `pnpm test` before every push. Do not bypass with `--no-verify`.
3. **Test location** — All tests live in `src/__tests__/<module>.test.ts`, mirroring the source file name.
4. **What to test** — New RPC endpoints, validation logic, consensus rules, crypto helpers, and any non-trivial branching. DoS/hardening scenarios go in `src/__tests__/hardening.test.ts`. Skip trivial getters and pure-config constants.
5. **Mocking** — Do not mock crypto operations (`ml-dsa`, `sha256`). Use real keys generated in `src/__tests__/fixtures.ts`. Mocking is acceptable for network I/O (P2P sockets, HTTP requests).
6. **Run after changes** — Run `pnpm test` before committing any change to `src/`.
7. **Website coverage** — For changes under `website/` that affect rendering, routing, responsive layout, or API error handling, run `cd website && pnpm test:visual` or `pnpm screenshots` in addition to any relevant backend tests.
8. **Website command forms** — From the repo root, use `pnpm run website:screenshots`; from `website/`, use `pnpm screenshots` or `pnpm test:visual`. Do not assume a root-level `pnpm screenshots` script exists.
9. **Build verification** — For changes to TypeScript source, ESM import paths, or package scripts that affect runtime entrypoints, run `pnpm build` in addition to tests because the default `ts-node` scripts skip typechecking.
10. **Website build verification** — Root `pnpm build` only typechecks the backend `src/` tree. After changes under `website/src/`, `website/index.html`, or Vite/Tailwind wiring, run `cd website && pnpm build` as well.

## Dependency & Supply-Chain Security

1. **Commit lock file** — `pnpm-lock.yaml` must always be committed. Never install dependencies without it.
2. **No silent additions** — Do not add a package not already in `package.json` without explicit user approval. Justify every new dependency in the commit message.
3. **Inspect postinstall scripts** — Before adding any package, check for `postinstall`/`prepare` scripts in its `package.json` (e.g. `pnpm info <pkg> scripts`). Flag any that run arbitrary shell commands.
4. **Audit after updates** — Run `pnpm audit` after any dependency change and fix high/critical advisories before committing.
5. **Verify new packages** — Check download counts, publish date, and maintainer history on npm before adding an unfamiliar package.
6. **Two lockfiles** — This repo has separate pnpm projects at the root and in `website/`. Dependency changes must keep `pnpm-lock.yaml` and/or `website/pnpm-lock.yaml` in sync with the manifest that changed.
7. **Two manifests** — Treat `website/package.json` the same as the root `package.json`: no frontend dependency additions, removals, or version bumps without explicit approval.
8. **Frontend audits** — After changing dependencies under `website/`, run `cd website && pnpm audit` in addition to any root-level audit that applies.

## Scope & Safety Rules

1. **Commit message style** — Conventional Commits: `type(scope): short description`. Types in use: `feat`, `fix`, `test`, `refactor`, `docs`, `build`, `chore`. Keep the subject line under 72 characters.
2. **Branch policy** — All changes go to `main` directly (this project does not use feature branches). Push to `main` triggers automatic deployment — double-check before pushing.
3. **Never do without explicit approval:**
   - Rewrite or delete block/UTXO data files under `data/` or bind-mount paths.
   - Change consensus constants (`STARTING_DIFFICULTY`, `COINBASE_MATURITY`, `DIFFICULTY_ADJUSTMENT_INTERVAL`, `MAX_BLOCK_SIZE`, `MAX_BLOCK_TRANSACTIONS`, `MAX_FUTURE_BLOCK_TIME_MS`, etc.).
   - Modify `.github/workflows/` CI/CD pipelines.
   - Add or remove Docker volumes/ports in `docker-compose.yml`.
   - Commit any file containing private keys, seeds, or `.env` secrets.
4. **No force-push** — Never `git push --force` to `main`.
5. **Hook bypass** — Never use `--no-verify`. If a hook fails, fix the underlying issue.
6. **Snapshot/monitoring scripts** — `generate-snapshot` (`scripts/generate-snapshot.sh`), `snapshot:activate` (`scripts/activate-snapshot.sh`), and `q` (`scripts/q.ts`, production container monitoring dashboard) now exist and are runnable. `generate-snapshot`/`snapshot:activate` regenerate and swap in BTC snapshot data — treat as data-mutating; do not run without explicit approval. Always verify the underlying file exists before invoking any npm script.

## Docs Reference

| File | Topic | Load when |
|------|-------|-----------|
| `docs/BRIDGE.md` | ZK bridge (SP1 + Groth16) to wrap QBTC as ERC-20 on Base L2 — design-only, no implementation | Working on cross-chain bridge, wQBTC minting, or SP1/Groth16 proof integration |
| `docs/RPC.md` | RPC server proxy-trust and rate-limit client-IP handling notes | Working on RPC deployment, reverse-proxy setup, or `--rpc-trust-proxy` behavior |
| `docs/CLAIM-FLOW.md` | BTC→QBTC claim flow: ECDSA/Schnorr ownership proofs, `verifyClaimProof`, snapshot index, double-claim prevention, supported BTC claim paths | Working on claim construction, claim validation, snapshot lookups, claim maturity, or any P2PKH/P2PK/P2WPKH/P2SH/P2TR/P2WSH/multisig claim path |
| `docs/MINING-LIFECYCLE.md` | Mining: candidate assembly from mempool, non-blocking batched PoW (`mineBlockAsync`), abort-on-new-tip, difficulty retargeting, coinbase subsidy halving | Working on `miner.ts`, `startMining`/`stopMining`/`receiveBlock` in `node.ts`, hashrate/`miningStats`, difficulty adjustment, or block-production timing |
| `docs/P2P-SYNC.md` | P2P networking & IBD: handshake, length-prefixed JSON over TCP, `getblocks`/`getheaders` sync, fork resolution by cumulative work, reorg, peer discovery, misbehavior banning | Working on `src/p2p/`, or debugging "IBD timeout", "genesis hash mismatch", "Fork detected", "all blocks rejected", or peers that connect but never sync |
| `docs/BLOCK-STORAGE.md` | Block persistence & serialization: `BlockStorage` interface, NDJSON `blocks.jsonl`/`metadata.json`, `sanitize`/`deserializeBlock`/`deserializeTransaction` round-trip, shape validation, DoS-bounded hex decoding, chain replay on startup | Working on `src/storage.ts`, the serialization boundary, or debugging "Skipping corrupted block entry", "hex string too large", or chain-replay-on-startup behavior |
| `docs/BLOCK-VALIDATION.md` | Block acceptance lifecycle: ordered cheap→expensive consensus checks in `validateBlock` (`src/block.ts`), contextual gates in `Blockchain.addBlock` (target match, claim ECDSA proofs), two-phase claim validation, difficulty retargeting, MTP/future-time bounds | Working on `validateBlock`, `addBlock`, `adjustDifficulty`, or `medianTimestamp`, or debugging "Block hash mismatch", "Block target mismatch", "Invalid block height", "must be greater than median time past", "Merkle root mismatch", "Duplicate transaction ID", "First transaction must be coinbase", or "Coinbase amount … exceeds max reward" |
| `docs/REORG-UNDO.md` | In-memory UTXO/undo machinery in `src/chain.ts`: `BlockUndo` journal, `applyBlock`/`disconnectBlock`, fast-vs-slow `resetToHeight`, `MAX_REORG_DEPTH`, `cumulativeWork` | Working on `Blockchain` state mutation, reorg apply/undo, or debugging wrong balance/`cumulativeWork` after a reorg or a `resetToHeight` full-replay fallback |
| `docs/MEMPOOL-LIFECYCLE.md` | Mempool admission, eviction, fee-density ordering, claim reservation, and revalidation on chain-tip changes | Working on `Mempool.addTransaction`, `getTransactionsForBlock`, `removeTransactions`, `revalidate`, `/api/v1/tx`, `/api/v1/mempool/txs`, or debugging mempool rejection/eviction errors |
| `docs/EXPLORER-CONTENT.md` | Explorer embedded docs/blog content system: static `DOC_SECTIONS` and `BLOG_POSTS` rendered from TypeScript modules | Working on `#/docs/*` sections, `#/blog/*` posts, explorer static-content navigation, or debugging why embedded docs/blog content does not render |
| `docs/EXPLORER-DATA-FLOW.md` | Explorer frontend routing/rendering in `website/src/explorer-main.ts`: hash-based navigation, `/api/v1` fetch helpers, search dispatch, and multi-page Vite wiring | Working on new explorer views, frontend API wiring, route parsing, or debugging blank/incorrect explorer renders |
| `docs/SNAPSHOT-PIPELINE.md` | BTC snapshot NDJSON → fork genesis + O(1) claim lookup: `loadSnapshot`, `BtcSnapshot`, `computeSnapshotMerkleRoot`, `getSnapshotIndex`, `createForkGenesisBlock`, sharded in-memory index | Working on snapshot loading, claim verification, fork genesis construction, or debugging "Snapshot missing btcTimestamp", "invalid address", or "BTC address not found in snapshot" |
| `docs/TEST-HARNESS.md` | Backend Vitest harness: shared fixtures, deterministic mining helpers, loopback TCP gates, and RPC/network test utilities | Adding or debugging tests under `src/__tests__/`, especially harness helpers such as `mineOnChain`, loopback socket probes, or RPC/P2P test setup |
| `docs/TRANSACTION-ANATOMY.md` | Transaction construction, hashing, signing, and validation: `Transaction`/`UTXO`/`TransactionInput` types, `serializeForSigning`, `computeTxId`, `createTransaction`, `validateTransaction`, fee/dust/subsidy math | Working on transaction construction, debugging "Invalid signature at input", "Transaction ID mismatch", "UTXO not found", "below dust threshold", "Coinbase UTXO not mature", or fee math |
| `docs/UTXO-INDEXING.md` | In-memory UTXO/address/tx indexes in `src/chain.ts`: `utxoSet`, `utxosByAddress`, `transactionIndex`, `getBalance`, `findUTXOs`, `findTransactionBlock`, `indexUtxo`/`unindexUtxo` | Working on `getBalance`, `findUTXOs`, `findTransactionBlock`, the `/api/v1/address/*` or `/api/v1/tx/*` RPC endpoints, or debugging wrong balance, missing UTXO, or transaction-not-found |
| `docs/CRYPTO-PRIMITIVES.md` | All cryptographic primitives in `src/crypto.ts`: ML-DSA-65 (native consensus), secp256k1 ECDSA/Schnorr (BTC claim proofs), SHA-256/RIPEMD-160 helpers, address-derivation for all 5 BTC script types, `buildMultisigScript`/`parseWitnessScript` | Working on signing/verification logic, adding a new address type, calling `signData`/`verifySignature`/`ecdsaSign`/`schnorrSign`, or debugging signature byte-size mismatches |
| `docs/NODE-ORCHESTRATION.md` | `Node` class coordination across chain, mempool, mining, P2P hooks, RPC submission, reorg resets, and daemon startup | Working on `src/node.ts`, `src/qbtcd.ts`, or debugging stale mempool entries after mining, missing relay after acceptance, mining not aborting on new peer blocks, stale `miningStats`, or reorgs that do not revalidate pending transactions |
| `docs/QBTCD-RUNTIME.md` | `qbtcd` daemon lifecycle: CLI parsing, snapshot bootstrap, storage replay, P2P/RPC startup, mining gatekeeping, simulation mode, and shutdown | Working on `src/qbtcd.ts`, daemon-launching package scripts, `--full`/`--mine`/`--local`/`--rpc-bind`/`--rpc-trust-proxy`, startup sync/mining refusal logs, or process-exit behavior |
| `docs/RPC-ENDPOINTS.md` | RPC endpoint catalog for `src/rpc.ts`: route ordering, request validation, response sanitization, body-size limits, rate limiting, and split between chain/mempool reads for all `/api/v1/*` routes | Adding or debugging any RPC endpoint (`startRpcServer`, `/api/v1/status`, `/api/v1/blocks`, `/api/v1/block/:hash`, `/api/v1/tx`, `/api/v1/mempool/txs`, `/api/v1/address/*`, `/api/v1/difficulty`, `/api/v1/peers`) |
