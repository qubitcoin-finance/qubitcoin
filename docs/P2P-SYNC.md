# P2P Networking & Initial Block Download (IBD)

This doc explains how QubitCoin nodes find each other, handshake, download the chain, resolve forks, and relay new blocks/transactions. Read it when working on `src/p2p/` (handshake, IBD, fork resolution, reorg, peer discovery, misbehavior banning) or when debugging "IBD timeout", "genesis hash mismatch", "Fork detected", "all blocks rejected", or peers that connect but never sync.

The transport is **length-prefixed JSON over TCP**: a 4-byte big-endian uint32 length followed by a JSON message body, capped at `MAX_MESSAGE_SIZE` (5 MB). Each connection is a `Peer` wrapping a socket; the `P2PServer` owns the peer set, the address book, the ban list, the orphan pool, and all message handlers. Sync uses a Bitcoin-style `getblocks`/`blocks` pull during IBD and `getheaders`/`headers` for fork resolution, choosing the winning chain by **cumulative PoW work** (falling back to height for legacy peers).

## Why it exists

A fresh node starts with only a hardcoded set of seed addresses (or a snapshot-derived genesis) and must (1) discover routable peers, (2) verify they are on the same network, (3) download potentially the entire chain without trusting the sender, and (4) converge on the most-work chain when peers disagree. Every step is adversarial: a peer can lie about its height, claim impossible cumulative work, flood the mempool with expensive ML-DSA-65 verifications, send junk blocks, or try to fill memory with orphans. The P2P layer answers each of these with validation, rate limits, and a misbehavior-scoring ban system rather than trusting any single peer.

## Key files

| Path:line | Symbol | Role |
|---|---|---|
| `src/p2p/protocol.ts:177` | `encodeMessage` | Frame a `Message` as length-prefixed JSON |
| `src/p2p/protocol.ts:193` | `decodeMessages` | Decode a buffer into complete messages + remainder |
| `src/p2p/protocol.ts:149` | `validateDecodedMessage` | Reject unknown types / malformed payloads at the wire |
| `src/p2p/peer.ts:30` | `class Peer` | Per-connection socket wrapper: framing, timers, scoring |
| `src/p2p/peer.ts:110` | `Peer.addMisbehavior` | Accumulate score; reject + disconnect at threshold 100 |
| `src/p2p/peer.ts:189` | `Peer.consumeToken` | Token-bucket rate limit (200 burst, 100/sec refill) |
| `src/p2p/peer.ts:220` | `Peer.startIBDTimer` | 30s timeout if a `getblocks` gets no `blocks` reply |
| `src/p2p/server.ts:113` | `class P2PServer` | Owns peers, address book, bans, orphans, handlers |
| `src/p2p/server.ts:509` | `handleVersion` | Validate + accept peer version, genesis, work |
| `src/p2p/server.ts:607` | `handleVerack` | Complete handshake; kick off IBD + `getaddr` |
| `src/p2p/server.ts:696` | `handleBlocks` | Apply downloaded blocks; detect forks/stalls |
| `src/p2p/server.ts:916` | `initiateForkResolution` | Send `getheaders` with a block locator |
| `src/p2p/server.ts:1004` | `handleHeaders` | Decide reorg by work, then `resetToHeight` + resync |
| `src/p2p/server.ts:1342` | `startDiscovery` | Periodic outbound dials with /16 subnet diversity |
| `src/p2p/server.ts:1384` | `addOrphan` | PoW-validate and cache parentless blocks |

## The handshake

When a TCP connection opens, `createPeer` (`server.ts:380`) constructs a `Peer` and starts a 10s `HANDSHAKE_TIMEOUT_MS` timer. The outbound side calls `sendVersion` (`server.ts:497`) immediately; the inbound side replies with its own version inside `handleVersion`.

`handleVersion` (`server.ts:509`) is the gate. It rejects, with escalating misbehavior penalties, any peer whose payload fails validation: non-integer/negative `height` (+25), malformed `genesisHash` (+25, must pass `isValidHash`), bad `version` (+25), oversized `userAgent` (+10), out-of-range `listenPort` (+10), or non-hex `cumulativeWork` (+10).

Two consensus-level checks follow:

- **Protocol version** must equal `PROTOCOL_VERSION` (currently `2`). A mismatch sends a `reject` and disconnects.
- **Genesis hash** must match ours — *unless* either side is "fresh" (`height === 0` and no `btcSnapshot`). A fresh node is allowed to adopt a peer's genesis during IBD; this is what lets a brand-new node bootstrap onto the network.

On success the peer's `remoteHeight`, `remoteGenesisHash`, `remoteListenPort`, and `remoteCumulativeWork` are recorded and a `verack` is sent. `handleVerack` (`server.ts:607`) calls `peer.completeHandshake()` (clearing the handshake timer), adds the peer to the address book, resets seed backoff, then decides whether to start IBD.

Before the handshake completes, only `PRE_HANDSHAKE_TYPES` (`version`, `verack`, `reject`, `ping`, `pong`) are accepted; any other message type pre-handshake costs +10 misbehavior (`handleMessage`, `server.ts:440`).

## Initial Block Download (IBD)

IBD is a pull loop driven by the syncing node. In `handleVerack`, if `peer.remoteHeight > ourHeight` (or we need to adopt the peer's genesis), the node calls `sendGetBlocks` (`server.ts:641`) starting at `ourHeight + 1`.

`sendGetBlocks` sends a `getblocks{fromHeight}` and arms `peer.startIBDTimer`. If no `blocks` message arrives within `IBD_TIMEOUT_MS` (30s), the peer is disconnected and `tryIBDWithAnotherPeer` (`server.ts:655`) picks the connected peer with the highest `remoteHeight` and retries — so a single stalled peer doesn't deadlock sync.

The serving side, `handleGetBlocks` (`server.ts:671`), returns up to `IBD_BATCH_SIZE` (200) blocks starting at the requested height, each run through `sanitizeForStorage`. Rapid repeated `getblocks` (< 100ms apart) earns +5 misbehavior to discourage amplification, but the request is still served because legitimate fork resolution can be bursty.

### Applying a batch

`handleBlocks` (`server.ts:696`) is where downloaded blocks land:

1. A batch larger than `IBD_BATCH_SIZE` is rejected (+25) — senders must respect the cap.
2. The IBD timer is cleared (a response arrived).
3. Each raw block is `deserializeBlock`-ed; failures cost +10 and are skipped.
4. Blocks already in `seenBlocks` count as `alreadyKnown`; blocks in `rejectedBlocks` are skipped without re-validation.
5. A `height === 0` block that differs from our genesis triggers `chain.replaceGenesis` (genesis adoption for fresh nodes).
6. Otherwise the block goes through `node.receiveBlock`, which runs full consensus validation.

After the loop, `handleBlocks` requests the next batch with `sendGetBlocks(ourHeight + 1)` **only if** the batch was full (200) and blocks were added. A partial batch with `added > 0` means sync is complete and `notifySynced()` fires, resolving any `waitForSync` promises.

### IBD stall detection

If a batch had blocks but `added === 0` and `alreadyKnown === 0` (every block rejected, none duplicates), the peer is feeding junk: +25 misbehavior and immediate disconnect ("all blocks rejected"). This prevents a malicious peer from holding a syncing node hostage with an endless stream of invalid blocks.

## Fork detection and resolution

During a batch, a block whose parent isn't our current tip produces a `result.error` containing `"Previous hash"`. The handling splits by context (`server.ts:749`):

- **Single-block relay** (batch length 1): if the parent isn't in `blocksByHash`, the block is an **orphan** and gets cached via `addOrphan`.
- **IBD batch** while not already resolving a fork: this is a genuine fork. `forkDetected` is set, the loop breaks, and `initiateForkResolution` runs.

`initiateForkResolution` (`server.ts:916`) sets `forkResolutionInProgress`, arms a `FORK_RESOLUTION_TIMEOUT_MS` (60s) auto-clear, builds a **block locator** (`buildBlockLocator`, `server.ts:897` — tip, tip-1, tip-2, tip-4, tip-8, … genesis, exponential backoff), and sends `getheaders{locatorHashes}`.

The serving side, `handleGetHeaders` (`server.ts:950`), caps the locator to 101 hashes, validates each, finds the first locator hash present in its chain as the fork point, and returns up to `MAX_HEADERS_RESPONSE` (500) headers (`{hash, height, previousHash}` only) from `forkPoint + 1` onward.

### Choosing the winning chain

`handleHeaders` (`server.ts:1004`) validates that the headers form a contiguous chain (each `height === prev.height + 1` and `previousHash === prev.hash`; a break costs +50 and clears resolution). It locates the fork point by scanning backward for the block matching `firstHeader.previousHash`, then enforces `MAX_REORG_DEPTH` (100) — a deeper reorg is refused outright.

The reorg decision prefers **cumulative work** over height:

- If the peer advertised `remoteCumulativeWork`, the node computes a lower-bound `verifiedPeerWork` from its own chain up to the fork point plus an estimate per peer header. A peer claiming more than `verifiedPeerWork * 3/2` is lying about its work and is banned (+100). If the peer's work is `<=` ours, no reorg.
- For legacy peers (no work field), it falls back to comparing `effectivePeerHeight` against our height.

If the peer wins, the node calls `node.resetToHeight(forkPoint)`, clears and rebuilds `seenBlocks`, clears the fork flag, and issues a fresh `sendGetBlocks(forkPoint + 1)` to download the winning branch.

## Block and transaction relay

Once synced, new objects are pushed via inventory announcements. The node wires two hooks at construction (`server.ts:161`): `node.onNewBlock → broadcastBlock` and `node.onNewTransaction → broadcastTx`. Both send an `inv{type, hash}` to every handshake-complete peer.

A peer receiving `inv` for an unseen object replies with `getdata` (`handleInv`, `server.ts:852`). `handleGetData` (`server.ts:871`) serves the block from `chain.blocksByHash` or the tx from `mempool`. Received transactions go through `handleTx` (`server.ts:803`), which rate-limits to ~10 tx/sec/peer (+5 over the limit, since ML-DSA-65 verification is expensive), validates via `node.receiveTransaction`, and re-broadcasts accepted txs to other peers with `broadcastExcept`.

## Peer discovery, anchors, and address book

After the handshake, each node sends `getaddr`. `handleGetAddr` (`server.ts:1211`) replies (at most once per 60s per peer) with up to `MAX_ADDR_RESPONSE` (100) shuffled known addresses. `handleAddr` (`server.ts:1251`) ingests addresses (at most once per 30s per peer; +5 otherwise), validates each via `parseAddressEntry`, adds routable ones to `knownAddresses` (capped at `MAX_ADDR_BOOK` = 1000, oldest evicted), and gossips genuinely-new addresses to up to 2 random peers.

`startDiscovery` (`server.ts:1342`) periodically (`DISCOVERY_INTERVAL_MS` = 60s) dials a random known address while honoring `MAX_OUTBOUND` (25) and `/16` subnet diversity (`MAX_OUTBOUND_PER_SUBNET` = 2) — so an attacker can't dominate the outbound set from one subnet. Every tick also persists the most-recently-seen addresses via `saveAnchors` to `anchors.json`. On startup `loadAnchors` reloads them (bypassing the routability filter so trusted persisted peers survive) and `connectToAnchors` dials them — giving a restarted node working peers without waiting on seeds.

`isRoutableAddress` (`server.ts:64`) rejects loopback, RFC1918 private ranges, link-local, and ULA addresses unless `localMode` is enabled (set for multi-node local dev where all peers are `127.0.0.1`).

## Misbehavior scoring and banning

`Peer.addMisbehavior` (`peer.ts:110`) accumulates a score that **decays 1 point per minute** of good behavior (`decayMisbehavior`). At `MISBEHAVIOR_THRESHOLD` (100) the peer is sent a `reject` and disconnected. `handleDisconnect` (`server.ts:396`) then bans the peer's IP for `BAN_DURATION_MS` (24h) if its score reached 100, persisting the ban to disk. Typical penalties: invalid block +25, invalid tx +10, oversized `addr`/`blocks` +25, impossible cumulative work +100, broken header chain +50, rapid `getblocks` +5.

## Invariants and edge cases

- **Framing trust**: a malformed frame (bad length prefix, oversized message, unparseable JSON) disconnects immediately rather than penalizing, because the byte stream can no longer be trusted (`peer.ts:177`).
- **Backpressure**: if `socket.write` returns false (kernel buffer full), the peer is disconnected — slow peers are dropped, matching Bitcoin Core behavior (`peer.ts:92`).
- **Seen caches** (`seenBlocks`, `seenTxs`, `rejectedBlocks`, `rejectedTxs`) are each capped at `SEEN_CACHE_MAX` (10,000) with oldest-eviction, so they bound memory while still suppressing re-validation and relay loops.
- **Orphan PoW gate**: `addOrphan` recomputes the block hash and checks `hashMeetsTarget` *before* caching, so the orphan pool (capped `MAX_ORPHAN_BLOCKS` = 50, expired after 10 min) can't be filled with junk. `processOrphans` walks the chain of cached children after each accepted block.
- **Fresh-node genesis adoption** only happens when *both* the local node and the block are at height 0 with no snapshot; a node with real chain history never replaces its genesis.
- **Reorg depth cap**: reorgs deeper than `MAX_REORG_DEPTH` (100) are refused, bounding the cost of a malicious deep-reorg attempt.
- **Seed reconnect** uses exponential backoff from `SEED_RECONNECT_BASE_MS` (5s) to `SEED_RECONNECT_MAX_MS` (60s), reset to base on a successful handshake.

## Cross-references

- [CLAIM-FLOW.md](./CLAIM-FLOW.md) — how BTC→QBTC claim transactions are validated before they enter blocks that this layer relays.
- [RPC.md](./RPC.md) — the other inbound surface; proxy-trust and client-IP rate-limiting for the HTTP RPC server.
- [BRIDGE.md](./BRIDGE.md) — design for wrapping QBTC as an ERC-20 on Base, downstream of the synced chain state this layer produces.
