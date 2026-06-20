# Peer Address Management & Gossip

How QubitCoin discovers, validates, gossips, persists, and bans peer addresses. Read this when working on `src/p2p/address-book.ts`, `src/p2p/anchors.ts`, `src/p2p/ban-list.ts`, the `addr`/`getaddr` handlers in `src/p2p/server.ts`, or when debugging "Skipping malformed anchor entry", "Oversized addr message", routability filtering, `/16` subnet diversity, or peers that get banned and never reconnect.

This page covers the address-book subsystem: the pure helper functions that validate and normalize IP addresses (`isRoutableAddress`, `getSubnet16`, `parseAddressEntry`, `upsertKnownAddress`), the `addr`/`getaddr` gossip protocol, the `anchors.json` persistence that survives restarts, and the `BanList` that times out misbehaving IPs. The end-to-end sync flow that consumes these peers lives in [P2P-SYNC](./P2P-SYNC.md); this page is the layer underneath — how the node decides which addresses to keep, share, and refuse.

## Why It Exists

A node that trusted every address a peer advertised could be flooded, eclipsed, or pointed at private/unroutable hosts. The address book has to answer four adversarial questions:

1. **Is this address even usable?** Reject malformed entries, private/loopback/link-local ranges, and out-of-range ports before they enter the book.
2. **Is one subnet dominating my outbound peers?** Cap outbound connections per `/16` subnet so a single attacker-controlled netblock cannot own the peer set (eclipse resistance).
3. **How do I keep the book bounded?** Evict the oldest address when the book exceeds its cap, and rate-limit incoming `addr` traffic.
4. **How does a restarted node find peers fast?** Persist the most-recently-seen addresses to `anchors.json` and reload them on startup, bypassing seeds.

The design splits **pure logic** (validation, normalization, eviction — `address-book.ts`) from **stateful wiring** (the `Map<string, KnownAddress>` and gossip handlers in `server.ts`). The pure functions take their state as parameters, which is why they are directly unit-testable without standing up a server.

## Key Files

| Path:line | Symbol | Role |
|---|---|---|
| `src/p2p/address-book.ts:16` | `getSubnet16` | Extract `/16` prefix (`"1.2"` from `"1.2.3.4"`) for subnet diversity |
| `src/p2p/address-book.ts:28` | `isRoutableAddress` | Reject loopback/private/link-local/unspecified ranges |
| `src/p2p/address-book.ts:49` | `normalizeIP` | Strip `::ffff:` IPv4-mapped-IPv6 prefix |
| `src/p2p/address-book.ts:59` | `parseAddressEntry` | Validate an untrusted `{host, port, lastSeen?}` entry to a typed shape or `null` |
| `src/p2p/address-book.ts:80` | `upsertKnownAddress` | Insert/refresh an address with routability gate, future-clamp, and oldest-eviction |
| `src/p2p/anchors.ts:14` | `readAnchors` | Load anchor entries from disk; `[]` on missing/corrupt file |
| `src/p2p/anchors.ts:38` | `writeAnchors` | Persist the `MAX_ANCHORS` (10) most-recently-seen addresses |
| `src/p2p/ban-list.ts:12` | `BanList` | Timed-expiry IP ban set, persisted to `banned.json` |
| `src/p2p/server.ts:1131` | `handleGetAddr` | Respond to `getaddr` with ≤100 shuffled known addresses (rate-limited) |
| `src/p2p/server.ts:1150` | `handleAddr` | Ingest an `addr` message, validate entries, relay new ones |
| `src/p2p/server.ts:1211` | `upsertKnownAddress` (method) | Server-side wrapper binding `localMode`/`MAX_ADDR_BOOK` |
| `src/p2p/server.ts:1298` | `loadAnchors` | Reload anchors on startup, bypassing the routability filter |
| `src/p2p/server.ts:1310` | `saveAnchors` | Persist current book to `anchors.json` |
| `src/p2p/server.ts:345` | `handleDisconnect` | Ban the peer IP if its misbehavior score reached 100 on disconnect |

## Address Validation Rules

`isRoutableAddress` (`address-book.ts:28`) is the gate that keeps non-routable hosts out of the book. It rejects:

- IPv6 loopback/unspecified (`::1`, `::`) and unique-local (`fc`/`fd` prefix) and link-local (`fe80`).
- IPv4 `127.0.0.0/8` (loopback), `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC 1918 private), `169.254.0.0/16` (link-local), and `0.0.0.0/8`.

`parseAddressEntry` (`address-book.ts:59`) is the structural gate for untrusted wire and disk data. It returns `null` unless `host` is a syntactically valid IP (`net.isIP` via `isValidIPAddress`), `port` is an integer in `1..65535`, and `lastSeen` (if present) is a finite number. It does **not** check routability — that decision is deferred to `upsertKnownAddress` so anchors loaded from disk can bypass it.

`getSubnet16` and `normalizeIP` exist because the same logical peer can appear as `1.2.3.4` and `::ffff:1.2.3.4`; normalization prevents an attacker from counting twice against subnet/ban logic. `peerMatchesHost` (`address-book.ts:54`) uses the same normalization to match a connected peer against a host:port pair.

## Insertion, Future-Clamp, and Eviction

`upsertKnownAddress` (`address-book.ts:80`) is the single mutation path into the book:

- If `enforceRoutability` is set and the node is not in `localMode`, a non-routable host is silently dropped.
- `lastSeen` is clamped to at most `now + 2h` (`maxFuture`). A peer cannot advertise a far-future timestamp to make its address un-evictable.
- An existing entry is only updated when the new `lastSeen` is strictly newer — stale gossip cannot rewind an address's recency.
- When the book exceeds `maxAddresses` (`MAX_ADDR_BOOK` = 1000 in `server.ts`), the entry with the **oldest** `lastSeen` is evicted. This keeps the book recency-biased so anchors and active peers survive churn.

The server-side method wrapper (`server.ts:1211`) binds `localMode`, `enforceRoutability`, and `MAX_ADDR_BOOK`; `addKnownAddress` (`server.ts:1219`) is the public entry that always enforces routability.

## The addr / getaddr Gossip Protocol

`handleGetAddr` (`server.ts:1131`) answers a peer's `getaddr` request. It is rate-limited to **one response per peer per 60 seconds** (`lastGetaddrResponse`); excess requests are silently ignored. The response is a Fisher–Yates shuffle of the book truncated to `MAX_ADDR_RESPONSE` (100) — randomization prevents a peer from learning the full topology by polling.

`handleAddr` (`server.ts:1150`) ingests advertised addresses with layered abuse defenses:

- A non-array payload scores `+10` misbehavior and returns.
- More than one `addr` message per **30 seconds** scores `+5` and drops the message (`lastAddrReceived`).
- A payload longer than `MAX_ADDR_RESPONSE` (100) scores `+25`, logs "Oversized addr message", and is truncated.
- Each entry passes through `parseAddressEntry`; a non-null-but-malformed object sets a flag that scores `+5` once for the whole message. Valid entries go through `addKnownAddress`.
- **Relay:** addresses that were new to this node are forwarded to up to 2 random handshake-complete peers (excluding the sender). This is the gossip-propagation step; nothing is relayed if no address was new.

Misbehavior accumulates on the `Peer` (`peer.ts:110`); reaching `MISBEHAVIOR_THRESHOLD` (100) disconnects the peer, and the score decays by 1 point per good-behavior minute (`peer.ts:132`). See [DOS-HARDENING](./DOS-HARDENING.md) for the full scoring table.

## Anchors: Restart Persistence

Seeds alone make a restarted node slow to rejoin. `saveAnchors` (`server.ts:1310`) → `writeAnchors` (`anchors.ts:38`) persists the `MAX_ANCHORS` (10) most-recently-seen addresses (sorted by `lastSeen` descending) to `anchors.json` in the data dir. Anchors are written on graceful shutdown and during discovery ticks.

On startup, `loadAnchors` (`server.ts:1298`) → `readAnchors` (`anchors.ts:14`) reloads them and re-inserts each via `upsertKnownAddress` with `enforceRoutability = false`. The bypass is deliberate: an operator's trusted anchor on a private/VPN address would otherwise be filtered out as non-routable. `readAnchors` parses every entry through `parseAddressEntry`, logging "Skipping malformed anchor entry" for bad rows and returning `[]` on a missing or unparseable file — a corrupt anchor file degrades to "start from seeds," never a crash.

## The Ban List

`BanList` (`ban-list.ts:12`) maps a normalized IP to an expiry timestamp. `ban` (`ban-list.ts:32`) sets expiry to `now + 24h` (`BAN_DURATION_MS`) and immediately persists to `banned.json`. `isBanned` (`ban-list.ts:21`) lazily prunes: if an IP's expiry has passed, it is deleted and reported not-banned, so the file self-cleans without a sweeper. Construction with a path triggers `load`, which only restores bans whose expiry is still in the future.

Bans are applied from two directions: `handleDisconnect` (`server.ts:345`) bans a peer whose misbehavior score reached 100, and incoming/outbound connection attempts consult `isBanned` (`server.ts:276`, `server.ts:306`) before completing a handshake. A null path (the default `BanList()`) keeps bans in-memory only — used in tests and ephemeral nodes.

## Discovery's Use of Subnet Diversity

`startDiscovery` (`server.ts:1223`) periodically dials a random known address, but filters candidates by `getSubnet16` so no more than `MAX_OUTBOUND_PER_SUBNET` (2) outbound peers share a `/16`. Banned and seed-duplicate addresses are excluded. This is the runtime payoff of tracking subnets in the book: an attacker who floods the book with addresses from one netblock still cannot capture more than two outbound slots.

## Invariants and Edge Cases

- **`localMode` bypasses routability.** A loopback/private node-to-node test setup would otherwise have an empty book. Production nodes run with `localMode` off.
- **`lastSeen` is monotonic per address.** Older gossip never overwrites a newer timestamp, and future timestamps are clamped to `+2h`, so eviction ordering cannot be gamed.
- **Eviction is by oldest `lastSeen`, not insertion order.** Refreshing an address resets its recency and protects it from eviction.
- **Corrupt persistence is non-fatal.** Both `readAnchors` and `BanList.load` swallow parse errors and start empty; a hand-edited or truncated `anchors.json`/`banned.json` degrades gracefully.
- **Relay only fans out *new* addresses.** Re-advertising a known address does not re-trigger gossip, bounding propagation amplification.
- **Ban expiry is lazy.** An entry past expiry is treated as unbanned on the next `isBanned` check and removed then — there is no background timer.

## Cross-References

- [P2P-SYNC](./P2P-SYNC.md) — handshake, IBD, fork resolution, and how discovery consumes the address book.
- [DOS-HARDENING](./DOS-HARDENING.md) — the full misbehavior-scoring table and the other ingress limits this subsystem participates in.
- [SECURITY-MODEL](./SECURITY-MODEL.md) — eclipse/Sybil threat analysis and the trust boundaries around `anchors.json` and `banned.json`.
- [NODE-ORCHESTRATION](./NODE-ORCHESTRATION.md) — how the `Node` wires the `P2PServer` lifecycle that owns this state.
