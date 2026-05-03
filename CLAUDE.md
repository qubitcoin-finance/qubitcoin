# QubitCoin

Post-quantum Bitcoin fork using ML-DSA-65 (Dilithium) signatures. Node.js/TypeScript implementation with UTXO model, SHA-256 PoW, and BTC claim mechanism.

## Quick Reference

- **Repo:** `qubitcoin-finance/qubitcoin`
- **Stack:** TypeScript (ESM), ts-node, Express v5, Vite + Tailwind (explorer)
- **Test:** `pnpm test` (vitest, 630 tests)
- **Build:** `pnpm build` (tsc)
- **Run node:** `pnpm run qbtcd -- --mine --full`
- **Docker image:** `ghcr.io/qubitcoin-finance/qbtcd:main`
- **Containers** (all run as `qubitcoin` user on self-hosted runner, all host-networked, all share the image above):
  - `qbtc-node` — main node, RPC on `127.0.0.1:3010`, P2P `6001`, data `/home/qubitcoin/qbtc-data`
  - `qbtc-q` — peer miner, RPC `127.0.0.1:3011`, P2P `6002`, peers `localhost:6001`, data `/home/qubitcoin/qbtc-q-data`
  - `qbtc-devtx` — dev transaction generator targeting `qbtc-node`

## Deployment

### CI/CD Pipeline (push to main)

1. **deploy.yml / build-and-push** — builds multi-arch Docker image, pushes to GHCR (GitHub-hosted runner)
2. **deploy.yml / deploy** — runs on self-hosted runner:
   - Checks out repo, `docker compose pull && docker compose up -d` (uses `docker-compose.yml` at repo root)
   - Builds website (`website/` via Vite) and deploys static files
   - Health check against `127.0.0.1:3010/api/v1/status`
3. **release.yml** — tags and creates GitHub release

Push to `main` triggers automatic deployment. No SSH required.
The old `pnpm ship` / `scripts/deploy.sh` scripts are removed — everything goes through GHA.

**Runner setup:**
- Self-hosted runner registered via GitHub UI (Settings → Actions → Runners)
- Runs `deploy.yml` on push to `main`

### Container Details (backend)

- **Ports (qbtc-node):** 3010 (RPC, bound to `127.0.0.1`), 6001 (P2P)
- **Ports (qbtc-q):** 3011 (RPC), 6002 (P2P)
- **Data:** `/home/qubitcoin/qbtc-data`, `/home/qubitcoin/qbtc-q-data` (persistent bind mounts)
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

## Architecture & Patterns

1. **Block persistence** — All block reads/writes go through the `BlockStorage` interface (`src/storage.ts`). Never touch the `.jsonl` file directly.
2. **Logging** — Import `log` from `src/log.ts`. Never instantiate a separate pino instance.
3. **Validation helpers** — Use `isValidHash` and `sanitize` from `src/utils.ts` for input sanitisation in RPC handlers. Do not inline regex checks.
4. **Crypto** — All post-quantum operations (`ml-dsa`) go through `src/crypto.ts`. Do not call `@noble/post-quantum` directly from business logic.
5. **New modules** — Node implementation goes in `src/`. Tools/scripts go in `src/tools/`. Tests go in `src/__tests__/` with the `*.test.ts` suffix.
6. **No circular imports** — Dependency order: `utils → log → crypto → block → transaction → snapshot → snapshot-loader → claim → chain → mempool → p2p → rpc → node → qbtcd`.
7. **P2P layout** — Keep networking code split under `src/p2p/` (`peer.ts`, `protocol.ts`, `server.ts`). Add new peer/protocol/server concerns there instead of expanding `rpc.ts` or `node.ts`.
8. **Website layout** — Landing-page behavior lives in `website/src/main.ts`, explorer behavior in `website/src/explorer-main.ts`, blog content in `website/src/blog/*.ts`, and browser tests in `website/e2e/*.spec.ts`.
9. **Explorer data flow** — Preserve the explorer’s `/api/v1` base path, hash-based routing, and shared fetch helpers in `website/src/explorer-main.ts` when adding new explorer views or API calls.

## Testing Rules

1. **Run:** `pnpm test` (vitest, one-shot). `pnpm test:watch` during development.
2. **Pre-push hook** — husky runs `pnpm test` before every push. Do not bypass with `--no-verify`.
3. **Test location** — All tests live in `src/__tests__/<module>.test.ts`, mirroring the source file name.
4. **What to test** — New RPC endpoints, validation logic, consensus rules, crypto helpers, and any non-trivial branching. DoS/hardening scenarios go in `src/__tests__/hardening.test.ts`. Skip trivial getters and pure-config constants.
5. **Mocking** — Do not mock crypto operations (`ml-dsa`, `sha256`). Use real keys generated in `src/__tests__/fixtures.ts`. Mocking is acceptable for network I/O (P2P sockets, HTTP requests).
6. **Run after changes** — Run `pnpm test` before committing any change to `src/`.
7. **Website coverage** — For changes under `website/` that affect rendering, routing, responsive layout, or API error handling, run `cd website && pnpm test:visual` or `pnpm screenshots` in addition to any relevant backend tests.

## Dependency & Supply-Chain Security

1. **Commit lock file** — `pnpm-lock.yaml` must always be committed. Never install dependencies without it.
2. **No silent additions** — Do not add a package not already in `package.json` without explicit user approval. Justify every new dependency in the commit message.
3. **Inspect postinstall scripts** — Before adding any package, check for `postinstall`/`prepare` scripts in its `package.json` (e.g. `pnpm info <pkg> scripts`). Flag any that run arbitrary shell commands.
4. **Audit after updates** — Run `pnpm audit` after any dependency change and fix high/critical advisories before committing.
5. **Verify new packages** — Check download counts, publish date, and maintainer history on npm before adding an unfamiliar package.
6. **Two lockfiles** — This repo has separate pnpm projects at the root and in `website/`. Dependency changes must keep `pnpm-lock.yaml` and/or `website/pnpm-lock.yaml` in sync with the manifest that changed.

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
