# Developer Simulations & Traffic Tooling

This doc covers QubitCoin's three standalone developer entrypoints that exercise the full node stack outside of a real network: the in-process consensus demo (`blockchain` / `src/simulation.ts`), the Bitcoin-fork claim demo (`claim:demo` / `src/claim-simulation.ts`), and the live RPC traffic generator (`dev:tx` / `src/dev-tx.ts`). Read this when you want to reproduce end-to-end behavior — mining, propagation, claims, balance agreement, tamper detection — without standing up TCP peers, or when you need to drive a running `qbtcd` with random transactions for explorer/QA work. These tools use the **synchronous** node path (`Node.mine`, `Node.receiveBlock`), which is distinct from both the production async miner (`startMining` / `mineBlockAsync`) and the `--simulate` daemon flag.

## Why it exists

The production node is networked and asynchronous: peers exchange length-prefixed JSON over TCP, mining runs in a non-blocking nonce loop that yields to the event loop, and reorgs are driven by cumulative-work comparisons. That machinery is great for a real testnet but terrible for a deterministic, single-process demonstration you can run in CI or read top to bottom.

The simulation files solve a different problem: **show the consensus rules working, fast, in one terminal, with no sockets.** They construct several `Node` objects in the same process and "propagate" blocks by directly invoking `receiveBlock` on the other nodes — a function call, not a network message. This makes the data flow legible (you can see exactly which node mined and which received) and lets the demo assert that all nodes agree on balances without any sync protocol.

`dev:tx` solves yet another problem: a freshly mined chain has no user transactions, so the explorer and mempool views are empty. It generates a steady trickle of real, signed transfers against a live RPC node so there is something to look at and something for the mempool to admit, order, and evict.

## Key files

| Anchor | Role |
|--------|------|
| `src/simulation.ts:54` | `runSimulation`, the 10-phase consensus demo (`blockchain` script). |
| `src/simulation.ts:43` | `propagateBlock`, in-process fan-out via `receiveBlock`. |
| `src/claim-simulation.ts:28` | `runForkSimulation`, the 9-phase BTC→QBTC claim demo (`claim:demo` script). |
| `src/dev-tx.ts:34` | `main`, the RPC traffic loop (`dev:tx` script). |
| `src/dev-tx.ts:62` | `sendTx`, builds and POSTs one transfer per interval. |
| `src/node.ts:59` | `Node.mine`, synchronous blocking PoW used by both simulations. |
| `src/node.ts:89` | `Node.receiveBlock`, the propagation target. |
| `src/node.ts:42` | `Node.receiveTransaction`, mempool admission used to seed pending txs. |
| `src/miner.ts:87` | `mineBlock`, the blocking nonce search behind `Node.mine`. |
| `src/snapshot.ts:131` | `createMockSnapshot`, the fake 5-holder BTC ledger the claim demo forks from. |
| `src/utils.ts:19` | `banner` / `src/utils.ts:32` `timeIt`, terminal formatting + timing used throughout. |

## How it works

### Synchronous in-process path

Both simulations rely on `Node.mine(minerAddress)` (`src/node.ts:59`), which calls `assembleCandidateBlock` then the **blocking** `mineBlock` (`src/miner.ts:87`), adds the block to its own chain, drops the mined txs from its mempool, and returns the `Block`. Because the PoW search is synchronous, the demo proceeds in a strict, reproducible order — there is no event-loop yielding and no abort-on-new-tip.

Propagation is a plain loop: `propagateBlock(block, nodes, miner)` (`src/simulation.ts:43`) calls `node.receiveBlock(block)` on every node except the miner. `receiveBlock` (`src/node.ts:89`) runs the same `chain.addBlock` validation a peer block would, so the demo still exercises full block validation — it just skips the wire. Transactions are seeded the same way: each node gets `receiveTransaction(tx)` directly, which runs real mempool admission (`src/node.ts:42`).

This is the load-bearing distinction from production:

```text
Production node:   startMining → mineBlockAsync (yields) → onNewBlock → TCP broadcast → peer.receiveBlock
Simulation:        Node.mine   → mineBlock (blocks)      → propagateBlock loop          → node.receiveBlock
```

### The consensus demo (`blockchain`)

`runSimulation` (`src/simulation.ts:54`) walks ten phases against three plain `Node('Node-N')` instances (no snapshot, so a normal mined genesis):

1. **Wallet generation** — three ML-DSA-65 keypairs via `generateWallet`, timed with `timeIt`, and a printed size comparison vs ECDSA (33B → 1,952B pubkey, 72B → 3,309B sig).
2. **Network setup** — three nodes, asserting all genesis hashes match.
3. **Coinbase mining** — Node-1 mines 3 blocks to Alice, propagated to the others; balances printed via `printBalances`, which flags any cross-node mismatch.
4. **Transactions** — Alice→Bob and Alice→Charlie, each built with `createTransaction`; the second deliberately filters out the UTXO already spent by the first (the mempool hasn't been mined yet).
5. **Transaction block** — Node-2 mines the pending txs.
6. **Balance verification** — every node's `getBalance` is compared.
7–9. **UTXO set / chain state / PQC size analysis** — iterates `chain.blocks` and `chain.utxoSet`, sums signature + pubkey bytes, and contrasts the total witness footprint against the equivalent ECDSA size.
10. **Tamper detection** — mutates a transaction amount, a block hash, and a `previousHash` link, calling `chain.validateChain` after each and then restoring, proving the hash-chain / merkle / signature checks catch every edit.

### The claim demo (`claim:demo`)

`runForkSimulation` (`src/claim-simulation.ts:28`) forks from a **mock** Bitcoin snapshot instead of mining a fresh genesis:

1. **Snapshot** — `createMockSnapshot` (`src/snapshot.ts:131`) returns `{ snapshot, holders }`: a tiny commitment-only ledger plus the ECDSA secret/public keys of five named holders.
2. **Fork genesis** — `new Node('QBTC-N', snapshot)` builds the fork genesis that embeds only the snapshot's `merkleRoot`; the demo prints how tiny that block is (no UTXO data on-chain).
3. **PQC wallets** — each holder generates a fresh ML-DSA-65 wallet to receive claimed coins.
4. **Claims** — three holders call `createClaimTransaction` (`src/claim.ts:53`) proving ECDSA ownership of their snapshot entry; the claim txs are admitted and mined.
5. **Post-claim transfers** — claimed coins are pure ML-DSA-65 from then on; Alice→Bob and Bob→Charlie spend them.
6. **Claim stats** — `chain.getClaimStats()` reports claimed/unclaimed counts and amounts and a migration percentage.
7. **Late claimer** — a fourth holder claims later, showing claims have no deadline.
8. **Double-claim prevention** — re-claiming Alice's already-claimed address is rejected; the demo names the three guard layers (chain `claimedBtcAddresses`, mempool `pendingBtcClaims`, block-level structural validation).
9. **Summary** — final stats, an ECDSA-vs-ML-DSA witness-size table, and a full `validateChain` re-run.

### The RPC traffic generator (`dev:tx`)

`dev-tx.ts` is the only one of the three that talks to a **real running node** over HTTP. `main` (`src/dev-tx.ts:34`) loads the miner wallet from `data/node/wallet.json` (path overridable as `argv[3]`; RPC base as `argv[2]`, default `http://127.0.0.1:3001`), then every `INTERVAL_MS` (3s) calls `sendTx` (`src/dev-tx.ts:62`):

- Fetch the wallet's UTXOs via `/address/:addr/utxos`, dropping any already spent this round (`pendingSpent` set).
- Pick one UTXO, choose a random fee (5,000–99,000 sat), split ~0.1% of the value across up to 5 random recipient outputs (the rest returns as change).
- Build with `createTransaction`, `sanitize` it, and POST to `/tx`.
- Classify errors: `already claimed` marks the UTXO spent locally; `not mature` prints a one-time "waiting for maturity" notice (coinbase outputs are locked for `COINBASE_MATURITY` blocks); anything else is logged.

It deliberately uses tiny amounts and high output fan-out so the explorer mempool and address views fill up quickly without draining the wallet.

## Invariants and edge cases

- **Demos mutate in-memory chain state directly.** The tamper-detection phase writes into `chain.blocks[...]` and restores afterward. This is acceptable *only* because these are throwaway single-process scripts — never replicate that pattern in `src/` node, RPC, mempool, chain, or P2P code, which must go through `BlockStorage` and validated `addBlock`.
- **Console output is intentional.** Per the project conventions, `src/*-simulation.ts` and `src/simulation.ts` may use `console.log` for terminal UX; long-running paths may not. `dev-tx.ts` is a one-off tool and likewise prints to the console.
- **`createMockSnapshot` is not the real snapshot pipeline.** It fabricates holders with known ECDSA keys so the demo can sign claims; production snapshots come from `dumptxoutset` via the converter. Do not import `createMockSnapshot` into production paths.
- **`dev:tx` requires `--mine` first.** If the wallet file is missing it exits with a hint to run `qbtcd --mine`. It also depends on coinbase maturity — until the first mined coins mature it will only print "waiting for maturity."
- **Synchronous mining can be slow at real difficulty.** `Node.mine` blocks the process on the nonce search; the demos run at the default starting difficulty and small block counts so they finish quickly. They are not a substitute for the async miner under production difficulty.
- **No reorgs.** Because propagation is a deterministic loop with one miner per phase, the simulations never exercise fork resolution or undo — see the reorg doc for that path.

## Cross-references

- [QBTCD-RUNTIME](./QBTCD-RUNTIME.md) — the real daemon, including the separate `--simulate` flag (pinned easy difficulty + fake txs) that these standalone scripts are *not*.
- [MINING-LIFECYCLE](./MINING-LIFECYCLE.md) — `assembleCandidateBlock`, blocking `mineBlock` vs non-blocking `mineBlockAsync`, and difficulty retargeting.
- [NODE-ORCHESTRATION](./NODE-ORCHESTRATION.md) — the `Node` class methods (`mine`, `receiveBlock`, `receiveTransaction`) these demos call.
- [CLAIM-FLOW](./CLAIM-FLOW.md) — `createClaimTransaction`, ECDSA ownership proofs, and double-claim prevention exercised by the claim demo.
- [SNAPSHOT-PIPELINE](./SNAPSHOT-PIPELINE.md) — real snapshot loading vs `createMockSnapshot`, and fork genesis construction.
- [OPERATOR-TOOLS](./OPERATOR-TOOLS.md) — production-facing CLI tools (`convert-snapshot`, `claim:generate`, `q`), as opposed to these developer demos.
- [TRANSACTION-ANATOMY](./TRANSACTION-ANATOMY.md) — `createTransaction`, fee/dust math, and signing used by all three tools.
- [RPC-ENDPOINTS](./RPC-ENDPOINTS.md) — the `/address/:addr/utxos` and `/tx` routes `dev:tx` drives.
