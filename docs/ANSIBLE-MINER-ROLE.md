# Ansible Miner Role

How the standalone Ansible miner deployment works, and when it differs from the compose-owned production deployment. Read this when changing `ansible/deploy-miner.yml`, `ansible/roles/qbtc-miner/*`, the sample inventories, or debugging an Ansible-launched node that uses `docker run -p`, `--mine`, `--full`, `/data`, or `qbtc_message`.

This page documents the role as it exists in the working tree. It is not the active push-to-`main` production path; that belongs to GitHub Actions plus root `docker-compose.yml`. The Ansible role remains useful for provisioning or refreshing a standalone mining node, but it encodes a different runtime topology: bridge-network Docker port publishing, default container ports `3001`/`6001`, snapshot bootstrap through `--full`, and health checking the host-published RPC port.

## Why It Exists

The repository has several deployment mechanisms with overlapping names. The Ansible role and the production compose service both use the `qbtc-miner` container name and the `ghcr.io/qubitcoin-finance/qbtcd:main` image, but they do not start the node the same way.

That distinction matters during operations. A production issue on `qubitcoin.finance` should be debugged against `docker-compose.yml` and `.github/workflows/deploy.yml`; an Ansible-launched miner should be debugged against `ansible/roles/qbtc-miner/tasks/main.yml` and the selected inventory. Mixing the two can lead to wrong port assumptions: production RPC is `127.0.0.1:3010` through host networking, while the Ansible role publishes a chosen host port to container port `3001`.

The role also owns machine state outside the repository checkout. It installs Docker, changes Unix group membership, creates the node data directory, removes and recreates a container, and lets `qbtcd --full` download or reuse the snapshot inside `/data`. Those are operational side effects, not documentation-only changes.

## Key Files

| Anchor | Role |
|---|---|
| `ansible/deploy-miner.yml:2` | Playbook entrypoint named "Deploy QBTC mining node". |
| `ansible/deploy-miner.yml:5` | Applies the `qbtc-miner` role to every selected host. |
| `ansible/roles/qbtc-miner/defaults/main.yml:2` | Default remote user, `qbtc`. |
| `ansible/roles/qbtc-miner/defaults/main.yml:3` | Default Docker image, `ghcr.io/qubitcoin-finance/qbtcd:main`. |
| `ansible/roles/qbtc-miner/defaults/main.yml:4` | Default persistent data directory, `/home/{{ qbtc_user }}/qbtc-data`. |
| `ansible/roles/qbtc-miner/defaults/main.yml:5` | Default host P2P port, `6001`. |
| `ansible/roles/qbtc-miner/defaults/main.yml:6` | Default host RPC port, `3001`. |
| `ansible/roles/qbtc-miner/defaults/main.yml:7` | Default container name, `qbtc-miner`. |
| `ansible/roles/qbtc-miner/defaults/main.yml:8` | Optional coinbase message, blank by default. |
| `ansible/roles/qbtc-miner/tasks/main.yml:3` | Installs the distro `docker.io` package. |
| `ansible/roles/qbtc-miner/tasks/main.yml:11` | Starts and enables the Docker systemd service. |
| `ansible/roles/qbtc-miner/tasks/main.yml:19` | Adds `qbtc_user` to the `docker` group. |
| `ansible/roles/qbtc-miner/tasks/main.yml:27` | Creates the persistent data directory. |
| `ansible/roles/qbtc-miner/tasks/main.yml:37` | Pulls the configured Docker image. |
| `ansible/roles/qbtc-miner/tasks/main.yml:42` | Stops any existing container with `qbtc_node_name`. |
| `ansible/roles/qbtc-miner/tasks/main.yml:47` | Removes the stopped container before recreation. |
| `ansible/roles/qbtc-miner/tasks/main.yml:53` | Runs the detached Docker container. |
| `ansible/roles/qbtc-miner/tasks/main.yml:58` | Publishes host RPC port to container port `3001`. |
| `ansible/roles/qbtc-miner/tasks/main.yml:59` | Publishes host P2P port to container port `6001`. |
| `ansible/roles/qbtc-miner/tasks/main.yml:60` | Mounts `qbtc_datadir` at `/data`. |
| `ansible/roles/qbtc-miner/tasks/main.yml:62` | Starts `qbtcd` with `--mine --full --datadir /data`. |
| `ansible/roles/qbtc-miner/tasks/main.yml:63` | Optionally passes `--message "{{ qbtc_message }}"`. |
| `ansible/roles/qbtc-miner/tasks/main.yml:67` | Polls node RPC after container start. |
| `ansible/roles/qbtc-miner/tasks/main.yml:69` | Health URL uses `127.0.0.1:{{ qbtc_rpc_port }}/api/v1/status`. |
| `ansible/roles/qbtc-miner/tasks/main.yml:74` | Health wait retries 60 times with 10 second delay. |
| `ansible/inventory.yml:4` | Root-host sample inventory targeting `65.108.198.110`. |
| `ansible/inventory.local.yml:4` | Local named-host inventory targeting `qubitcoin.finance`. |
| `ansible/inventory.local.yml:6` | Example override for RPC host port `3002`. |
| `ansible/inventory.local.yml:7` | Example override for P2P host port `6002`. |
| `ansible/gha-runner.yml:1` | Deprecated runner provisioning pointer; not the miner role. |
| `Dockerfile:22` | Image exposes container ports `3001` and `6001`. |
| `Dockerfile:26` | Image entrypoint binds RPC to `0.0.0.0` inside the container. |
| `Dockerfile:27` | Image default command is `--mine --full --datadir /data`. |
| `src/qbtcd.ts:51` | Daemon help text: RPC port default is `3001`. |
| `src/qbtcd.ts:52` | Daemon help text: P2P port default is `6001`. |
| `src/qbtcd.ts:57` | `--full` means auto-download snapshot if missing. |
| `src/qbtcd.ts:178` | `--mine` / `--full` default to public seed selection unless local. |
| `src/qbtcd.ts:183` | `--full` snapshot bootstrap path. |
| `src/qbtcd.ts:226` | P2P server uses the configured daemon P2P port. |
| `src/qbtcd.ts:303` | Mining starts with the optional configured coinbase message. |
| `docker-compose.yml:9` | Production compose uses host networking, unlike this role. |
| `docker-compose.yml:18` | Production compose sets RPC port `3010`. |
| `docker-compose.yml:19` | Production compose mounts a read-only snapshot path. |
| `docker-compose.yml:20` | Production compose binds RPC to `127.0.0.1`. |

## How It Works

### Playbook Entry

`ansible/deploy-miner.yml` is intentionally thin:

```text
deploy-miner.yml
  |
  +-- hosts: all
  +-- gather_facts: true
  +-- roles:
        +-- qbtc-miner
```

The selected inventory decides which machines receive the role and which defaults are overridden. The playbook itself does not distinguish production, staging, or local hosts.

### Role Defaults

The role defaults describe one standalone miner:

```text
qbtc_user:      qbtc
qbtc_image:     ghcr.io/qubitcoin-finance/qbtcd:main
qbtc_datadir:   /home/{{ qbtc_user }}/qbtc-data
qbtc_p2p_port:  6001
qbtc_rpc_port:  3001
qbtc_node_name: qbtc-miner
qbtc_message:   ""
```

The host ports are Ansible variables. The container ports are fixed by the role's `docker run` command: host `qbtc_rpc_port` maps to container `3001`, and host `qbtc_p2p_port` maps to container `6001`.

This works because the Docker image entrypoint starts `qbtcd` with `--rpc-bind 0.0.0.0`, making container RPC reachable through Docker's port publishing. Without that image-level bind override, the daemon's default `127.0.0.1` bind would be loopback inside the container and would not accept traffic forwarded from the host.

### Machine Preparation

The first half of the role prepares the remote host:

```text
install docker.io
start and enable docker.service
add qbtc_user to docker group
create qbtc_datadir owned by qbtc_user
pull qbtc_image
```

The Docker install and service tasks run with `become: true`. The image pull uses the Docker CLI directly and is always marked changed. The data directory is durable node state; it is not removed by the role.

Adding the user to the `docker` group affects future login sessions. The current play still invokes Docker commands as Ansible is connected, so group membership should not be treated as a complete privilege model for the same run.

### Container Replacement

The role stops and removes any existing container named `qbtc_node_name`, ignoring failures when it does not exist:

```text
docker stop {{ qbtc_node_name }}
docker rm {{ qbtc_node_name }}
```

It then starts a fresh detached container:

```text
docker run -d
  --name {{ qbtc_node_name }}
  --restart unless-stopped
  -p {{ qbtc_rpc_port }}:3001
  -p {{ qbtc_p2p_port }}:6001
  -v {{ qbtc_datadir }}:/data
  {{ qbtc_image }}
  --mine --full --datadir /data
  [--message "{{ qbtc_message }}"]
```

Only the container is replaced. The bind-mounted data directory remains in place, so `blocks.jsonl`, `metadata.json`, `wallet.json`, `anchors.json`, `banned.json`, and a downloaded `qbtc-snapshot.jsonl` can survive the refresh through the shared `/data` path.

### Runtime Startup

The role passes `--mine --full --datadir /data`. In `qbtcd`, that means:

- `--full` creates the data directory if needed and downloads the default snapshot into `qbtc-snapshot.jsonl` when no snapshot path exists.
- `--mine` starts continuous mining after daemon startup.
- `--mine` or `--full` with no explicit seeds causes default seed selection: `qubitcoin.finance:6001`, unless local mode is used.
- The miner waits for P2P sync when seeds are configured, then starts mining with the generated or loaded wallet.
- `--message` becomes the optional coinbase message included in mined blocks.

The Ansible role does not pass `--snapshot`, `--seeds`, `--local`, `--rpc-bind`, or `--rpc-trust-proxy`. Those remain controlled by the Docker image entrypoint and daemon defaults.

### Health Check

After starting the container, Ansible polls:

```text
http://127.0.0.1:{{ qbtc_rpc_port }}/api/v1/status
```

It retries 60 times with a 10 second delay. The comment notes that snapshot download and genesis startup can take about 10 minutes, matching the maximum wait window.

The check runs from the remote host against the host-published RPC port. It is not the public website `/api/` proxy path and it is not the production compose health check at `127.0.0.1:3010`.

### Inventories

`ansible/inventory.yml` targets `goro` by numeric IP as `root`, sets `ansible_become: false`, and includes a `miners` child group with `qbtc_user: qbtc` and `qbtc_message: "mined by q"`.

`ansible/inventory.local.yml` targets `qubitcoin.finance` as user `qbtc` and demonstrates port overrides:

```text
qbtc_rpc_port: 3002
qbtc_p2p_port: 6002
qbtc_message: "mined by q"
```

Those overrides only change host-published ports. They do not change the container's internal `qbtcd` ports, which remain `3001` and `6001` under the role's current command.

### Deprecated Runner Playbook

`ansible/gha-runner.yml` is not part of miner deployment. Its first line marks it deprecated and points runner provisioning to `z/bootstrap/ansible/gha-runners.yml`.

Do not use that file as evidence for how qbtcd containers are launched. It is a pointer for GitHub Actions runner setup, not a node runtime playbook.

## Invariants and Edge Cases

### The Role Is Not Production Compose

The production backend service in `docker-compose.yml` uses `network_mode: host`, mounts `/home/qubitcoin/qbtc-snapshot.jsonl` read-only at `/snapshot.jsonl`, passes `--snapshot=/snapshot.jsonl`, sets `--port=3010`, and binds RPC to `127.0.0.1`.

The Ansible role uses Docker bridge networking with `-p`, lets `--full` manage the snapshot under `/data`, and health-checks whichever `qbtc_rpc_port` the inventory selects. Do not infer one topology from the other.

### Container Replacement Is Not Data Reset

Stopping and removing `qbtc_node_name` does not clear the node state in `qbtc_datadir`. That is usually desired: a refreshed container should resume from the same chain, wallet, peer anchors, bans, and snapshot file.

If an operator wants a clean node, deleting or replacing the data directory is a separate data-mutating action and is outside the role's current task list.

### Port Overrides Are Host-Side Only

Inventory overrides such as `qbtc_rpc_port: 3002` and `qbtc_p2p_port: 6002` change Docker's left-hand port numbers:

```text
host 3002 -> container 3001
host 6002 -> container 6001
```

The daemon still believes it is listening on its default internal ports because the role does not pass `--port` or `--p2p-port`.

### Snapshot Source Comes From qbtcd

The role does not mount a snapshot file. It relies on `qbtcd --full` to resolve the default snapshot location and download the snapshot into `/data` if missing.

That means a node launched by this role can spend startup time and network bandwidth fetching the snapshot. Production compose avoids that path by mounting a preexisting snapshot read-only and passing `--snapshot`.

### Health Success Means RPC Is Up

The final `uri` task proves that `/api/v1/status` responds on the host-published RPC port. It does not prove public nginx routing, website deployment, GitHub release tagging, or production compose health.

It also does not by itself prove the node is mining. `qbtcd` can start RPC before or around longer-running sync and mining gates. For mining-specific symptoms, inspect the status JSON and container logs together.

### Docker CLI Tasks Are Broadly Changed

The image pull, stop, remove, and run tasks use raw `command:` invocations with `changed_when: true` or failure suppression. This keeps the role simple, but it means Ansible change reporting is coarse.

A run can report changes even when the image digest is unchanged, and a missing old container is not a failure. Treat the final RPC health response as the role's real success signal.

### Coinbase Message Is Shell-Interpolated

The role appends `--message "{{ qbtc_message }}"` directly into the folded `docker run` command only when `qbtc_message` is non-empty.

Keep that value simple operator text. The current role does not use an argv-structured Docker module, so unusual quoting or shell metacharacters in the message can change command parsing.

## Cross-References

- [Deployment Surfaces](./DEPLOYMENT-SURFACES.md) for the active GitHub Actions and compose deployment, legacy scripts, and how Ansible fits among them.
- [qbtcd Runtime Lifecycle](./QBTCD-RUNTIME.md) for daemon flags, snapshot bootstrap, seed defaults, P2P/RPC startup, and mining gates.
- [Snapshot Pipeline](./SNAPSHOT-PIPELINE.md) for the snapshot file that `--full` downloads and loads.
- [Operator Tools](./OPERATOR-TOOLS.md) for snapshot conversion, activation, claim tooling, and monitoring scripts outside this Ansible role.
- [P2P Networking & Initial Block Download](./P2P-SYNC.md) for seed connections, anchor peers, sync, and mining refusal when seeded sync fails.
- [RPC Endpoint Surface](./RPC-ENDPOINTS.md) for the `/api/v1/status` endpoint the role uses as its health check.
