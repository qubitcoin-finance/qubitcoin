# Test Harness Architecture

This doc covers the backend Vitest harness, shared fixtures, loopback TCP gates, deterministic mining helpers, and hardening helpers; read it when adding or debugging tests under `src/__tests__/`.

The test suite exercises consensus validation, chain mutation, mempool admission, RPC handlers, and P2P sockets without mocking cryptographic primitives. The harness keeps those tests fast by reusing ML-DSA wallets, lowering proof-of-work targets, binding HTTP and TCP servers to ephemeral loopback ports, and isolating persistent storage in temporary directories. Search terms that should land here include `describeLoopbackTcp`, `probeLoopbackTcpListen`, `mineOnChain`, `TEST_TARGET`, `startRpcTestServer`, `waitFor timeout`, and `LOG_LEVEL=silent`.

## Why It Exists

QubitCoin tests need real signatures and real serialization paths because most bugs occur at the boundaries: transaction IDs, block hashes, UTXO indexing, JSON storage, RPC payloads, and length-prefixed P2P frames. Mocking `ml-dsa`, `sha256`, or the wire protocol would hide the same failures the node must reject in production.

The cost of that realism is speed and flakiness risk. ML-DSA-65 key generation is expensive, PoW can become infeasible if a test accidentally inherits production difficulty, and loopback sockets can be unavailable in restricted environments. The harness addresses those constraints with process-shared fixtures, easy mining targets, explicit loopback probes, and temp-dir cleanup.

The result is not a separate test framework. It is a small set of reusable helpers that let each suite stay close to the subsystem it covers while preserving the same runtime assumptions as the node implementation.

## Key Files

| File | Anchor | Role |
|------|--------|------|
| `vitest.config.ts:3` | `defineConfig` | Global test timeout, include glob, silent logging, single worker, and non-isolated module cache. |
| `package.json:28` | `test` script | Runs the backend suite with `vitest run`. |
| `src/__tests__/fixtures.ts:7` | `walletA`, `walletB`, `walletC` | Process-shared ML-DSA wallets generated once per Vitest worker. |
| `src/__tests__/chain-test-helpers.ts:6` | `TEST_TARGET` | Easy consensus target used by chain tests. |
| `src/__tests__/chain-test-helpers.ts:8` | `mineOnChain` | Builds a valid block on the current tip with increasing timestamps. |
| `src/__tests__/claim-test-helpers.ts:15` | `DUMMY_GENESIS` | Standalone claim-test genesis hash placeholder. |
| `src/__tests__/mempool-test-helpers.ts:4` | `DEFAULT_FEE` | Fee high enough for ML-DSA-sized transactions. |
| `src/__tests__/mempool-test-helpers.ts:7` | `makeUtxoSet` | Minimal UTXO map for mempool admission tests. |
| `src/__tests__/network-test-utils.ts:3` | `isListenPermissionError` | Detects socket permission failures. |
| `src/__tests__/network-test-utils.ts:10` | `probeLoopbackTcpListen` | Runtime probe for ephemeral loopback TCP support. |
| `src/__tests__/rpc-test-helpers.ts:9` | `LOOPBACK_TCP_SUPPORTED` | Top-level await gate for RPC socket tests. |
| `src/__tests__/rpc-test-helpers.ts:13` | `listenOnLoopback` | Waits for an HTTP server and returns its bound address. |
| `src/__tests__/rpc-test-helpers.ts:24` | `startRpcTestServer` | Starts `startRpcServer` on `127.0.0.1` with an ephemeral port. |
| `src/__tests__/hardening-test-helpers.ts:11` | `waitFor` | Polling helper for async P2P and hardening assertions. |
| `src/__tests__/hardening-test-helpers.ts:38` | `makeUtxoSet` | Small hardening UTXO map with configurable amount. |

## How It Works

### Vitest Runtime

The root test command is `pnpm test`, which maps to `vitest run` in `package.json:28`. The config includes only `src/__tests__/**/*.test.ts`, silences logs with `LOG_LEVEL=silent`, and sets a 5 second per-test timeout in `vitest.config.ts:4`.

The harness intentionally runs with `pool: 'threads'`, `maxWorkers: 1`, and `isolate: false` in `vitest.config.ts:8`. That combination lets modules be cached across test files in the same worker. `fixtures.ts` uses that cache to generate `walletA`, `walletB`, and `walletC` once instead of repeating ML-DSA-65 key generation in every suite.

This layout means tests should avoid mutating shared fixture wallet objects. They are reusable identities, not per-test state. Chain state, mempool state, storage paths, RPC servers, and P2P servers still belong inside each test or its `beforeEach`.

```text
pnpm test
  -> vitest.config.ts
     -> one worker, module isolation disabled
        -> fixtures.ts generates walletA/B/C once
        -> each *.test.ts creates fresh chain/node/mempool/server state
```

### Shared Wallet Fixtures

`src/__tests__/fixtures.ts:7` exports three generated native wallets. They are used across crypto, transaction, chain, mempool, miner, RPC, and P2P tests. This preserves real ML-DSA public keys, signatures, and addresses while avoiding repeated setup cost.

The fixture module has no reset function because wallets are immutable for test purposes. Tests that need balances or spendable outputs create those outputs through a `Blockchain`, a synthetic UTXO map, or a temporary storage-backed `Node`.

### Suite Layout

Most test files mirror one production module or one subsystem boundary. Examples include `block.test.ts`, `transaction.test.ts`, `storage.test.ts`, `miner.test.ts`, and the grouped chain suites (`chain-core.test.ts`, `chain-validation.test.ts`, `chain-reorg.test.ts`, `chain-claims.test.ts`).

Cross-boundary behavior gets its own suffix instead of being folded into a larger file. RPC route coverage is split across endpoint, edge-case, transaction, P2P, rate-limit, and proxy-trust suites. Mempool behavior is split across basic admission, claims, eviction, sorting, and revalidation suites. Hardening files use names like `hardening-rpc.test.ts` and `hardening-p2p-messages.test.ts` so DoS-oriented cases are discoverable without scanning every happy-path test.

Helper files live beside tests rather than under production `src/` modules. That keeps test-only constants such as `TEST_TARGET`, synthetic UTXO builders, and loopback gating out of runtime code.

### Easy Proof Of Work

Chain-oriented tests use `TEST_TARGET` from `src/__tests__/chain-test-helpers.ts:6` or `src/__tests__/rpc-test-helpers.ts:8`. The value is intentionally easy: it keeps block mining fast while still exercising `computeBlockHash`, `hashMeetsTarget`, merkle roots, block links, and `Blockchain.addBlock`.

`mineOnChain` in `src/__tests__/chain-test-helpers.ts:8` mutates the chain difficulty to the easy target, reads the current tip, creates a coinbase for the next height, appends optional transactions, computes the merkle root, and increments the nonce until the hash meets the target. It also sets `timestamp` to `tip.header.timestamp + 1`, which keeps median-time-past validation from rejecting otherwise valid test blocks.

The claim helper has a parallel `mineOnChain` in `src/__tests__/claim-test-helpers.ts:17`. It exists for standalone claim suites that also use `DUMMY_GENESIS` from `src/__tests__/claim-test-helpers.ts:15` when testing claim construction outside a full chain path.

### Mempool Inputs

Mempool suites avoid building a whole chain when they only need spendable outputs. `makeUtxoSet` in `src/__tests__/mempool-test-helpers.ts:7` returns a one-entry `Map<string, UTXO>` keyed with `utxoKey('a'.repeat(64), 0)`. The default amount is large enough for ordinary spend construction, and `DEFAULT_FEE` in `src/__tests__/mempool-test-helpers.ts:4` is high enough to clear the minimum fee check for ML-DSA-sized transactions.

This keeps tests such as revalidation, eviction, double-spend reservation, and fee-density sorting focused on `Mempool` behavior. When a test needs impossible or conflicting states, it uses public helper APIs or explicit test-only hooks such as `injectTransaction` instead of pretending those transactions came from a valid chain.

### Loopback TCP Gates

Socket tests are optional at runtime because some CI or sandboxed environments disallow `server.listen(0, '127.0.0.1')`. `probeLoopbackTcpListen` in `src/__tests__/network-test-utils.ts:10` creates a temporary TCP server, treats `EPERM` and `EACCES` as "unsupported", and rejects on unexpected errors.

RPC helpers expose `describeLoopbackTcp` and `itLoopbackTcp` from `src/__tests__/rpc-test-helpers.ts:10`. Hardening helpers expose their own `describeLoopbackTcp` at `src/__tests__/hardening-test-helpers.ts:8`. Suites wrap real socket tests in those aliases so local and CI runs execute them when possible, while restricted environments skip only the network-dependent groups.

`listenOnLoopback` in `src/__tests__/rpc-test-helpers.ts:13` waits for an HTTP server's `listening` event and verifies that `server.address()` is an `AddressInfo`. `startRpcTestServer` in `src/__tests__/rpc-test-helpers.ts:24` combines that with `startRpcServer(node, 0)` and returns a `baseUrl` for `fetch` assertions.

### Temporary Storage

Tests that need persistence use `fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-...'))` and pass the directory into `FileBlockStorage` or `P2PServer`. Representative P2P hardening tests allocate two temp dirs in `src/__tests__/hardening-p2p-messages.test.ts:22` and clean them in `afterEach` at `src/__tests__/hardening-p2p-messages.test.ts:39`.

This pattern matters because block storage is append-only JSONL plus metadata, address books and anchor peers live beside P2P data, and reusing a directory would leak chain tips or peer state across tests. Cleanup belongs in `finally` or `afterEach` so a failing assertion does not leave stale state for the next test run.

### Async P2P Assertions

P2P tests cannot assume that `connectOutbound`, message parsing, handshakes, or disconnect callbacks complete synchronously. `waitFor` in `src/__tests__/hardening-test-helpers.ts:11` polls a predicate until it succeeds or throws `Error('waitFor timeout')`.

Use `waitFor` for state that is updated by socket events: peer counts, misbehavior-driven disconnects, fork-resolution flags, and relayed messages. Direct assertions are still appropriate for pure protocol helpers such as `decodeMessages`, address parsing, or orphan pool methods that return synchronously.

### RPC Harness

RPC tests create an in-memory `Node`, lower its chain difficulty, mine a few blocks, then start an ephemeral loopback server. `src/__tests__/rpc-endpoints.test.ts:12` sets up that flow in `beforeEach`; `src/__tests__/rpc-endpoints.test.ts:24` closes the server in `afterEach`.

The tests call real HTTP endpoints with `fetch`, so route ordering, Express request parsing, parameter validation, response status codes, and JSON serialization are exercised together. Edge-case suites such as `src/__tests__/rpc-edge-cases.test.ts:95` intentionally send malformed numeric strings like `1abc` to catch regressions where `parseInt` would silently accept partial input.

## Invariants And Edge Cases

### Real Crypto Stays Real

Do not mock ML-DSA signing, hashing, transaction IDs, or block hashes. Shared wallets exist to make real crypto cheap enough for tests. If a test needs an invalid signature or malformed binary field, construct that malformed input explicitly and assert the production validation path rejects it.

### Difficulty Must Be Explicit

Tests that mine blocks must set an easy target before mining or use a helper that does it. Repeated fast mining can trigger difficulty adjustment paths, and production-like targets can make a unit test hang. RPC edge-case tests reset an easy target in tight loops for this reason, as shown in `src/__tests__/rpc-edge-cases.test.ts:53`.

### Timestamps Must Move Forward

Blocks built by helpers use `tip.header.timestamp + 1`. If a test hand-builds blocks with repeated or old timestamps, median-time-past validation may reject the block before the rule under test is reached.

### Loopback Skips Are Environment Checks

`describeLoopbackTcp` is for environments that cannot bind loopback sockets, not for avoiding slow or flaky tests. If a test does not open a TCP or HTTP listener, keep it in a normal `describe`.

### Server Lifetimes Must Be Closed

Every `startRpcTestServer`, `app.listen`, `P2PServer.start`, or raw TCP server needs a matching close or stop path. Use `afterEach` for suite-owned servers and `try`/`finally` for servers created inside a single `it`.

### Temp Directories Are Test State

Any test that uses `FileBlockStorage`, address-book persistence, anchor peers, or P2P data directories should allocate a unique temp dir. Never point tests at `data/`, deployment bind mounts, or checked-in fixtures that can be mutated by the node.

### Shared Fixtures Are Identities, Not Ledgers

`walletA`, `walletB`, and `walletC` can appear in many tests because balances are not stored on the wallet objects. Balances live in the chain, mempool UTXO maps, or synthetic fixtures created by each test.

### Hardening Tests Prefer Boundary Payloads

Hardening suites should place malformed data at the boundary being tested: raw P2P frames for protocol decoding, HTTP requests for RPC validation, persisted JSON for storage recovery, or explicit transaction objects for mempool validation. That keeps failures attributable to the intended boundary instead of a helper that normalized the bad input away.

## Cross-References

- [TRANSACTION-ANATOMY](./TRANSACTION-ANATOMY.md) for transaction construction, signing, fees, and dust rules covered by transaction and mempool tests.
- [BLOCK-VALIDATION](./BLOCK-VALIDATION.md) for consensus checks that `mineOnChain` intentionally satisfies before targeted assertions run.
- [REORG-UNDO](./REORG-UNDO.md) for reset and undo behavior exercised by chain reorg tests.
- [MEMPOOL-LIFECYCLE](./MEMPOOL-LIFECYCLE.md) for the admission, eviction, and revalidation paths tested with synthetic UTXO maps.
- [RPC-ENDPOINTS](./RPC-ENDPOINTS.md) for route validation and response behavior exercised through `startRpcTestServer`.
- [P2P-SYNC](./P2P-SYNC.md) for handshake, relay, fork resolution, and misbehavior behavior covered by loopback P2P tests.
- [BLOCK-STORAGE](./BLOCK-STORAGE.md) for the temp-dir-backed storage paths used by persistence and P2P tests.
- [CRYPTO-PRIMITIVES](./CRYPTO-PRIMITIVES.md) for why tests use real ML-DSA, ECDSA, Schnorr, and hash primitives instead of mocks.
