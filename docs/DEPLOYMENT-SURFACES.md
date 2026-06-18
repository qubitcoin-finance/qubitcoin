# Deployment Surfaces

How production deployment, release tagging, static website publishing, manual SSH scripts, and Ansible provisioning coexist in this repo. Read this when changing deployment wiring, deciding whether a script is active production flow or legacy/manual support, or debugging mismatches between `qbtc-miner`, `qbtc-node`, GHCR images, `/home/qubitcoin/www`, nginx, and `/api/v1/status`.

The active production path is a GitHub Actions push-to-`main` pipeline: build and push the `ghcr.io/qubitcoin-finance/qbtcd` image, build the website artifact, run `docker compose` on the self-hosted runner, copy static files into `/home/qubitcoin/www`, and health-check RPC on `127.0.0.1:3010`. Several other deployment assets remain in the tree, but they serve different roles: `release.yml` tags GitHub releases, `scripts/deploy*.sh` are direct SSH/manual paths, and `ansible/` provisions or starts miner nodes outside the compose-owned production stack.

## Why It Exists

Deployment code is spread across workflows, shell scripts, Compose, nginx configuration, package scripts, and Ansible playbooks. Those files do not all describe the same runtime topology.

That matters because the names are close enough to confuse:

- The active compose service is `qbtc-miner`.
- Older direct Docker scripts start `qbtc-node`, `qbtc-q`, and `qbtc-devtx`.
- The Ansible role defaults to a container named `qbtc-miner`, but exposes container ports with `-p` instead of the production host-network compose shape.
- The website is not served by a website container; the workflow copies Vite output into `/home/qubitcoin/www`, and nginx proxies `/api/` to the node RPC port.

The deployment surface also has stateful boundaries. `/home/qubitcoin/qbtc-data` is persistent chain/node data, `/home/qubitcoin/qbtc-snapshot.jsonl` is a read-only snapshot mount in production, and `/home/qubitcoin/www` is disposable static website output. Treating those as interchangeable would either lose node state, serve stale frontend files, or boot a node from a different snapshot path than production uses.

## Key Files

| Anchor | Role |
|--------|------|
| `.github/workflows/deploy.yml:3` | Push-to-`main` trigger for the active deployment workflow. |
| `.github/workflows/deploy.yml:13` | `build-and-push` job on GitHub-hosted runners. |
| `.github/workflows/deploy.yml:64` | Multi-arch Docker image build and push for the miner/node image. |
| `.github/workflows/deploy.yml:85` | Website build from `website/` before artifact upload. |
| `.github/workflows/deploy.yml:95` | `deploy` job on the self-hosted Linux runner. |
| `.github/workflows/deploy.yml:115` | `docker compose pull` for production backend refresh. |
| `.github/workflows/deploy.yml:120` | One-shot cleanup for legacy non-compose containers. |
| `.github/workflows/deploy.yml:132` | `docker compose up -d --remove-orphans`. |
| `.github/workflows/deploy.yml:135` | Health check against `127.0.0.1:$RPC_PORT/api/v1/status`. |
| `.github/workflows/deploy.yml:156` | Static website copy into `/home/qubitcoin/www`. |
| `.github/workflows/release.yml:3` | Push-to-`main` trigger for release tagging. |
| `.github/workflows/release.yml:29` | Tag push using the computed version. |
| `docker-compose.yml:4` | Production compose service definition. |
| `docker-compose.yml:6` | GHCR image tag consumed by compose. |
| `docker-compose.yml:9` | Host networking for the production backend container. |
| `docker-compose.yml:12` | Persistent data and read-only snapshot mounts. |
| `docker-compose.yml:15` | Runtime `qbtcd` arguments used by the production service. |
| `scripts/nginx-qubitcoin.conf:24` | Static website document root. |
| `scripts/nginx-qubitcoin.conf:44` | nginx `/api/` proxy boundary. |
| `package.json:35` | `pnpm ship` reminder shim; not the active workflow. |
| `scripts/deploy.sh:27` | Manual SSH path starting legacy `qbtc-node`. |
| `scripts/deploy-backend.sh:19` | Backend-only manual SSH path starting legacy `qbtc-node`. |
| `scripts/deploy-ui.sh:16` | Manual remote website build path. |
| `ansible/deploy-miner.yml:2` | Ansible playbook for miner-node deployment. |
| `ansible/roles/qbtc-miner/defaults/main.yml:2` | Ansible role defaults for user, image, ports, and name. |
| `ansible/roles/qbtc-miner/tasks/main.yml:53` | Ansible `docker run` command for a standalone miner node. |

## How It Works

### Active CI/CD Path

The active deployment path starts when a commit lands on `main`.

```text
push to main
  |
  v
.github/workflows/deploy.yml
  |
  +-- build-and-push (ubuntu-latest)
  |     |
  |     +-- build/push ghcr.io/qubitcoin-finance/qbtcd
  |     +-- build website/dist
  |     +-- upload website artifact
  |
  +-- deploy (self-hosted linux)
        |
        +-- docker compose pull
        +-- remove old non-compose qbtc-node/qbtc-q/qbtc-devtx containers
        +-- docker compose up -d --remove-orphans
        +-- curl 127.0.0.1:3010/api/v1/status
        +-- copy website artifact to /home/qubitcoin/www
```

The backend image is produced by `docker/build-push-action` with `linux/amd64` and `linux/arm64` platforms. The workflow tags it through `docker/metadata-action`, including the branch, commit SHA, and computed version.

The website is not deployed as a container in the active path. The build job runs `cd website && pnpm install --frozen-lockfile && pnpm build`, uploads `website/dist/`, and the self-hosted runner later copies the downloaded artifact into `/home/qubitcoin/www`.

The deploy job intentionally uses `actions/checkout` with `clean: false`. That lets the self-hosted runner keep local machine state that is outside the repository checkout while still refreshing the repo content needed by compose and deployment scripts.

### Compose-Owned Backend

The production backend runtime is defined by root `docker-compose.yml`, not by the legacy SSH scripts.

The only service is `qbtc-miner`. It uses image `ghcr.io/qubitcoin-finance/qbtcd:main`, runs with `network_mode: host`, and starts `qbtcd` with:

```text
--mine
--datadir=/data
--port=3010
--snapshot=/snapshot.jsonl
--rpc-bind=127.0.0.1
```

The compose file mounts `/home/qubitcoin/qbtc-data` at `/data`, which is the persistent node data directory. It mounts `/home/qubitcoin/qbtc-snapshot.jsonl` at `/snapshot.jsonl` read-only, so the production container consumes an existing snapshot file instead of mutating it.

The `NODE_OPTIONS=--max-old-space-size=12288` environment setting belongs to the container runtime, not the TypeScript code. It raises the Node.js heap ceiling for snapshot and chain workloads without changing consensus behavior.

### Legacy Container Adoption

The deploy workflow includes a cleanup step for `qbtc-node`, `qbtc-q`, and `qbtc-devtx`. It inspects each container and removes it only if Docker reports no Compose project label.

That step exists because earlier manual scripts created containers outside Compose. A container name created by direct `docker run` can block `docker compose up` from claiming the intended runtime names. Once Compose owns the backend, the cleanup loop becomes a no-op for compose-managed containers.

The cleanup does not delete bind-mounted data directories. It only removes legacy containers whose names collide with the current deployment model.

### Health Check Boundary

The deploy job waits for `http://127.0.0.1:3010/api/v1/status`. That matches the compose command's `--port=3010` and `--rpc-bind=127.0.0.1`.

This is a local backend health check from the self-hosted runner. Public clients reach the same RPC service through nginx under `/api/`, but the workflow verifies the service before the public proxy path matters.

The health loop waits up to 30 tries with 10-second sleeps. On failure it prints the last 50 lines from `docker compose logs` and exits non-zero, which fails the deployment job before the run can be mistaken for healthy.

### Website and nginx Boundary

The active workflow deploys the website by replacing the contents of `/home/qubitcoin/www` with the built artifact. nginx serves that directory as the document root and uses SPA fallback routing:

```text
/home/qubitcoin/www
  |
  +-- static Vite output
  |
  v
nginx location /
  |
  +-- try_files $uri $uri/ /index.html
```

The same nginx config proxies `/api/` to `http://127.0.0.1:3010`, adding standard forwarding headers. That keeps the browser-facing URL stable while the RPC server remains bound to loopback in the container command.

Snapshot downloads are separate from the API proxy. nginx serves `/snapshot/` from `/home/qubitcoin/www/snapshot/` with buffering disabled, which is appropriate for large static snapshot files and avoids routing downloads through the RPC server.

### Release Workflow

`.github/workflows/release.yml` is also triggered by pushes to `main`, but it does not deploy the node or website.

Its job is versioning: it computes a version with `codacy/git-version`, pushes that tag, and creates or updates a GitHub release with `ncipollo/release-action`.

Do not treat the release workflow as an alternative deploy path. It produces repository metadata, not runtime state on the self-hosted runner.

### Manual SSH Scripts

The `scripts/deploy.sh`, `scripts/deploy-backend.sh`, and `scripts/deploy-ui.sh` files are direct SSH workflows targeting `qubitcoin@goro`.

They predate or sit alongside the compose-owned deployment model and encode different topology:

- `scripts/deploy.sh` starts three direct Docker containers: `qbtc-node`, `qbtc-q`, and `qbtc-devtx`.
- `scripts/deploy-backend.sh` starts the backend containers without building the website.
- `scripts/deploy-ui.sh` syncs the repo to the remote host, builds the website remotely, copies output to `~/www`, and installs nginx config.

Those scripts are useful as references for manual recovery or older operational paths, but they are not what a normal push-to-`main` run executes. The active workflow's adoption step explicitly removes non-compose containers with the names those scripts create.

### Ansible Miner Role

`ansible/deploy-miner.yml` applies the `qbtc-miner` role to all hosts in the selected inventory.

The role installs Docker, enables the service, adds `qbtc_user` to the `docker` group, creates the data directory, pulls the configured image, removes an existing container with `qbtc_node_name`, and runs a detached miner container. It then polls `http://127.0.0.1:{{ qbtc_rpc_port }}/api/v1/status`.

The defaults describe a standalone miner node shape:

- user `qbtc`
- image `ghcr.io/qubitcoin-finance/qbtcd:main`
- data directory `/home/{{ qbtc_user }}/qbtc-data`
- P2P port `6001`
- RPC port `3001`
- container name `qbtc-miner`

This is not the same as the production compose shape. The Ansible role uses explicit `-p {{ qbtc_rpc_port }}:3001` and `-p {{ qbtc_p2p_port }}:6001` port mappings, and it runs `--mine --full --datadir /data`, letting the node bootstrap the full snapshot path. Production compose uses host networking, port `3010`, loopback RPC bind, and a read-only `/snapshot.jsonl` mount.

## Invariants and Edge Cases

### One Active Production Owner

The active owner of production deployment is `.github/workflows/deploy.yml` plus `docker-compose.yml`.

Manual scripts and Ansible should not be assumed to describe the currently running production stack unless an operator intentionally used them. When behavior differs, use the workflow and compose file as the source of truth for push-to-`main` production.

### Persistent Data Is Not Website Output

`/home/qubitcoin/qbtc-data` is durable node data. `/home/qubitcoin/qbtc-snapshot.jsonl` is the mounted snapshot file. `/home/qubitcoin/www` is replaceable static website output.

The deploy workflow deletes and replaces website files, but it does not delete the node data directory or snapshot file. A deployment change that crosses those boundaries should be treated as data-affecting, not as a normal docs or website refresh.

### RPC Is Loopback-Bound In Production

The production command binds RPC to `127.0.0.1` and the health check uses `127.0.0.1:3010`.

Public API access is mediated by nginx's `/api/` proxy. This keeps the node RPC service local to the host while still exposing the explorer API under the website origin.

### Compose Uses Host Networking

The production service uses `network_mode: host`, so there is no Compose `ports:` mapping for RPC. The `--port=3010` and `--rpc-bind=127.0.0.1` flags are the binding controls that matter.

This differs from the Ansible role's explicit `-p` mappings. When comparing local Docker behavior to production behavior, check whether the container is running with host networking or bridge port publishing.

### Website Builds Happen Before Runtime Deployment

The website artifact is built in the GitHub-hosted `build-and-push` job and uploaded for the self-hosted runner. The self-hosted runner deploys those already-built files.

The manual `deploy-ui.sh` path builds remotely on `goro`, which means package installation and build failures happen on the server instead of in the GitHub-hosted job. That is a different failure mode from the active deployment workflow.

### `pnpm ship` Is A Reminder Shim

The root `ship` script prints a reminder that deployment is automatic. It is not a deployment implementation.

Its message points at `.github/workflows/docker.yml`, while the active workflow in this tree is `.github/workflows/deploy.yml`. Treat the workflow file itself, not the shim text, as the authority.

### Release Tags Are Separate From Runtime Health

`release.yml` and `deploy.yml` both run on pushes to `main`, but they answer different questions.

`deploy.yml` answers "is the running node and website updated and healthy?" `release.yml` answers "what version tag and GitHub release correspond to this state?" A successful release action does not imply the self-hosted runner deployed, and a successful deploy does not depend on the release job's tag creation.

## Cross-References

- [QBTCD-RUNTIME](./QBTCD-RUNTIME.md) for daemon startup flags, snapshot bootstrap, storage replay, RPC/P2P startup, mining gates, and shutdown.
- [OPERATOR-TOOLS](./OPERATOR-TOOLS.md) for snapshot conversion, snapshot activation, BTC claim tooling, and the `q` monitoring script.
- [RPC](./RPC.md) for proxy trust configuration behind nginx and how forwarded client IPs affect rate limiting.
- [RPC-ENDPOINTS](./RPC-ENDPOINTS.md) for the `/api/v1/status` health-check endpoint and the rest of the RPC surface.
- [SNAPSHOT-PIPELINE](./SNAPSHOT-PIPELINE.md) for how the mounted snapshot file becomes genesis commitment and claim lookup state.
- [WEBSITE-QA](./WEBSITE-QA.md) for validating website changes before deployment.
