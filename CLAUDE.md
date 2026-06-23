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
| `docs/ANSIBLE-MINER-ROLE.md` | Standalone Ansible miner deployment role and how it differs from compose-owned production | Working on `ansible/deploy-miner.yml`, `ansible/roles/qbtc-miner/*`, sample inventories, or debugging an Ansible-launched miner |
| `docs/BLOCK-HEADER-FORMAT.md` | Byte-level 112-byte block header layout, `serializeBlockHeader`, `computeBlockHash`, merkle root, and PoW predicate | Working on `src/block.ts` serialization, debugging "Block hash mismatch" or "Merkle root mismatch" errors, or computing a header hash by hand |
| `docs/BLOCK-STORAGE.md` | Block persistence and serialization through `BlockStorage`, NDJSON files, and sanitize/deserialize helpers | Working on `src/storage.ts`, the disk/JSON boundary, or replay errors such as corrupted entries and oversized hex |
| `docs/BLOCK-VALIDATION.md` | Ordered block consensus checks in `validateBlock` plus contextual gates in `Blockchain.addBlock` | Working on `validateBlock`, `addBlock`, difficulty/MTP logic, or block rejection errors |
| `docs/BRIDGE.md` | Design-only SP1 + Groth16 bridge to wrap QBTC on Base as ERC-20 | Working on cross-chain bridge design, wQBTC mint/burn flow, or SP1/Groth16 proof integration |
| `docs/BROWSER-CLAIM-WORKFLOW.md` | Explorer browser-only claim builder for `/#/claim`, including local key handling and claim JSON export/import | Working on `website/src/claim-browser.ts`, the claim route, browser-side BTC credential derivation/signing, claim API wiring, or the privacy test that ensures keys never leave the browser |
| `docs/BTC-SCRIPT-COVERAGE.md` | Which Bitcoin script templates become claimable snapshot entries and which are excluded | Working on `parseDumptxoutset`, snapshot coverage stats, claimable script support, or website claim-count copy |
| `docs/CHAIN-WORK-FORK-CHOICE.md` | Accumulated proof-of-work (`blockWork`, `cumulativeWork`), fork-choice rule, and DoS guard during sync | Working on `blockWork`/`cumulativeWork`, debugging "no reorg" or "banning impossibly high work" log lines, or wiring `cumulativeWork` through the P2P handshake |
| `docs/CLAIM-FLOW.md` | BTC→QBTC claim construction and validation across snapshot lookup, proof verification, and one-shot spend tracking | Working on claim creation, `verifyClaimProof`, claim maturity, snapshot lookup, or supported BTC claim paths |
| `docs/CONSENSUS-PARAMETERS.md` | Catalog of consensus-critical constants, their meanings, and enforcement points | Working on protocol constants, looking up exact values, or assessing the impact of changing a consensus parameter |
| `docs/CRYPTO-PRIMITIVES.md` | Map of all cryptographic primitives in `src/crypto.ts`, including ML-DSA, secp256k1, hashes, and BTC address derivation helpers | Working on signing/verification code, address derivation, script encoding helpers, or signature/key byte-size issues |
| `docs/DEPLOYMENT-SURFACES.md` | Production deployment paths across GitHub Actions, compose, website publish, manual scripts, and Ansible | Working on deployment wiring, determining whether a script is live or legacy, or debugging topology mismatches |
| `docs/DEV-SIMULATIONS.md` | Developer demo/simulation entrypoints for consensus, claims, and live RPC traffic generation | Working on `src/simulation.ts`, `src/claim-simulation.ts`, `src/dev-tx.ts`, or reproducing end-to-end behavior locally |
| `docs/DOS-HARDENING.md` | DoS boundaries and input limits across RPC, P2P, storage, mempool, block validation, and snapshot loading | Working on request/message limits, malformed untrusted data handling, abuse scoring, or resource-exhaustion symptoms |
| `docs/DUMPTXOUTSET-FORMAT.md` | Byte-level reference for Bitcoin Core `dumptxoutset` v2 as parsed by `src/tools/parse-utxoset.ts` | Working on snapshot parsing, binary decode bugs, amount/script decoding, or resume-mid-record behavior |
| `docs/EXPLORER-CONTENT.md` | Explorer embedded docs/blog content architecture and routing to static sections/posts | Working on `#/docs/*`, `#/blog/*`, or debugging missing embedded explorer content |
| `docs/EXPLORER-DATA-FLOW.md` | Explorer frontend routing, fetch helpers, and `/api/v1` view wiring | Working on `website/src/explorer-main.ts`, `website/src/explorer-api.ts`, new explorer views, or blank/misrouted renders |
| `docs/EXPLORER-PRESENTATION.md` | Explorer formatting helpers for amounts, statuses, badges, timing, links, and HTML escaping | Working on `website/src/explorer-format.ts`, explorer presentation bugs, or XSS-safe rendering |
| `docs/MEMPOOL-LIFECYCLE.md` | Mempool admission, eviction, fee-density ordering, claim reservation, and tip-change revalidation | Working on `Mempool.addTransaction`, block assembly inputs, mempool RPCs, or rejection/eviction behavior |
| `docs/MINING-LIFECYCLE.md` | Mining candidate assembly, async PoW loop, restart-on-new-tip behavior, retargeting, and subsidy flow | Working on `miner.ts`, `startMining`/`stopMining`, hashrate stats, difficulty adjustment, or mining responsiveness |
| `docs/NODE-ORCHESTRATION.md` | `Node` coordination across chain, mempool, mining, P2P hooks, RPC submission, and reorg resets | Working on `src/node.ts`, `src/qbtcd.ts`, or cross-subsystem bugs such as stale mempool entries or missing relay |
| `docs/OPERATOR-TOOLS.md` | Operator-facing snapshot, claim, and monitoring tools plus their package-script entrypoints | Working on `src/tools/*`, `scripts/*.sh`, `scripts/q.ts`, or package scripts such as `convert-snapshot`, `claim:generate`, `snapshot:activate`, and `q` |
| `docs/OTHER-SCRIPT-INSPECTION.md` | Diagnostic reference for Bitcoin `dumptxoutset` outputs classified as `other`; excluded script patterns and why they are skipped | Investigating excluded snapshot value, `rawScript`, `scriptPattern`, or questions about which non-standard Bitcoin scripts were skipped and why |
| `docs/P2P-SYNC.md` | P2P networking, handshake, IBD, fork resolution, reorg, and transaction/block relay | Working on `src/p2p/`, sync/fork behavior, peer discovery, or peers that connect but never synchronize |
| `docs/P2P-WIRE-PROTOCOL.md` | Byte-level wire framing (4-byte length prefix + JSON), 14 `MessageType` values, payload interfaces, and `encodeMessage`/`decodeMessages` codec | Working on `src/p2p/protocol.ts`, debugging framing/disconnect errors, adding a new message type, or reasoning about `PROTOCOL_VERSION` compatibility |
| `docs/PACKAGE-SCRIPTS.md` | Mapping of root and website `pnpm` scripts to entrypoints, wrappers, tests, and data-mutating commands | Working on `package.json`, `website/package.json`, CLI script wiring, or figuring out which command runs which code path |
| `docs/PEER-ADDRESS-MANAGEMENT.md` | Peer address discovery, validation, gossip, persistence, subnet diversity, and banning | Working on address-book/anchor/ban-list code, `addr`/`getaddr` handling, or peer reconnect/gossip issues |
| `docs/PQC-ALGORITHM-SUITE.md` | Standalone post-quantum demo and benchmark suite, and rationale for ML-DSA-65 as the consensus choice | Working on PQC demo scripts, benchmark output, algorithm comparisons, or explaining the consensus algorithm selection |
| `docs/QBTCD-RUNTIME.md` | `qbtcd` daemon lifecycle from CLI parsing through snapshot bootstrap, replay, startup, mining gates, and shutdown | Working on `src/qbtcd.ts`, daemon launch scripts, `--full`/`--mine`/`--local`/`--rpc-bind`/`--rpc-trust-proxy`, or startup/shutdown behavior |
| `docs/REORG-UNDO.md` | In-memory UTXO undo journal, fast/slow reset paths, and reorg application details in `src/chain.ts` | Working on `Blockchain` state mutation, reorg apply/undo, `MAX_REORG_DEPTH`, or wrong balance/work after reset/reorg |
| `docs/RPC-ENDPOINTS.md` | Implemented `/api/v1` endpoint catalog, validation, sanitization, and rate/body-size handling | Adding or debugging RPC endpoints in `src/rpc.ts` or explorer/backend API mismatches |
| `docs/RPC.md` | RPC proxy-trust and client-IP handling notes for rate limiting behind reverse proxies | Working on RPC deployment, reverse-proxy setup, or `--rpc-trust-proxy` behavior |
| `docs/SECURITY-MODEL.md` | Trust boundaries across consensus, claims, P2P, RPC, snapshots, storage, and operator-managed files | Working on security review, threat modeling, or deciding whether a control belongs in consensus or policy |
| `docs/SNAPSHOT-PIPELINE.md` | Snapshot loading, merkle commitment, genesis construction, and O(1) BTC address lookup | Working on snapshot loading, claim verification dependencies, fork genesis construction, or snapshot validation errors |
| `docs/SUPPLY-AND-EMISSION.md` | QBTC money creation, snapshot premine semantics, mining rewards, halving schedule, and supply caps | Working on total-supply reasoning, reward math, emission rules, or max-money validation errors |
| `docs/TEST-HARNESS.md` | Backend Vitest harness, shared fixtures, deterministic mining, loopback probes, and RPC/network test helpers | Adding or debugging tests under `src/__tests__/`, especially shared harness utilities |
| `docs/TRANSACTION-ANATOMY.md` | Transaction construction, signing, hashing, validation, fee math, and maturity rules | Working on transaction creation/validation, sighash or txid issues, fee math, or maturity-related failures |
| `docs/TRANSACTION-JOURNEY.md` | End-to-end transaction path across RPC, `Node`, mempool, miner, and P2P relay | Working on full transaction flow debugging from broadcast through mining and peer acceptance |
| `docs/UTXO-INDEXING.md` | In-memory UTXO, address, and transaction indexes that power balance and lookup queries | Working on `getBalance`, `findUTXOs`, `findTransactionBlock`, address/tx RPCs, or missing/wrong indexed data |
| `docs/WEBSITE-LANDING.md` | Landing-page shell, shared website/explorer HTML boundary, and marketing-page behavior | Working on `website/index.html`, landing navigation/SEO/animations, mobile menu, or the landing/explorer boundary |
| `docs/WEBSITE-QA.md` | Playwright-based website QA workflow with mocked `/api/v1` data and screenshot coverage | Working on `website/src/*`, `website/e2e/*`, `website/playwright.config.ts`, rendering regressions, or screenshot coverage |
