# Chain Work & Fork Choice

This doc explains how QubitCoin measures accumulated proof-of-work (`blockWork`, `cumulativeWork`) and uses it as the fork-choice rule and as a denial-of-service guard during sync. Read it when working on `blockWork`/`cumulativeWork`, debugging "Peer chain has less work — no reorg" or "Peer claims impossibly high cumulative work — banning" log lines, reasoning about why a longer-but-lighter chain did not win, or wiring the `cumulativeWork` field through the P2P handshake. It ties together `src/block.ts`, `src/chain.ts`, `src/p2p/server.ts`, and `src/node.ts`.

## Why it exists

A height counter is not a safe fork-choice rule. An attacker can mine many low-difficulty blocks faster than the honest network mines fewer high-difficulty blocks, producing a chain that is *taller* but represents *less* total computation. Bitcoin solves this by selecting the chain with the most cumulative proof-of-work, not the most blocks. QubitCoin follows the same rule: the active chain is the one with the greatest summed work, and reorganizations only happen toward strictly more work.

Cumulative work is also a cheap abuse signal during sync. A peer advertises its total work in the handshake before sending any blocks. If that claim is wildly larger than the work its announced headers could possibly justify, the node bans the peer instead of trying to download a fabricated chain.

## Key files

| Anchor | Role |
|--------|------|
| `src/block.ts:159` | `blockWork(target)` — converts a difficulty target into a work quantity |
| `src/block.ts:154` | `hashMeetsTarget(hash, target)` — the PoW predicate (`hash < target`) |
| `src/chain.ts:67` | `Blockchain.cumulativeWork: bigint` — running total of accepted work |
| `src/chain.ts:151` | `addBlock` — appends a block to the active chain |
| `src/chain.ts:198` | adds `blockWork(block.header.target)` on a successful append |
| `src/chain.ts:638` | `BlockUndo.blockWork` — per-block work captured for undo |
| `src/chain.ts:756` | subtracts `undo.blockWork` when a block is disconnected |
| `src/chain.ts:87` | recomputes `cumulativeWork` while replaying persisted blocks at startup |
| `src/chain.ts:529` | recomputes `cumulativeWork` on the slow-path full replay in `resetToHeight` |
| `src/chain.ts:487` | `resetToHeight(targetHeight)` — rewinds the active chain to a fork point |
| `src/p2p/protocol.ts:58` | `cumulativeWork?` field in the `version` handshake payload |
| `src/p2p/server.ts:459` | advertises local `cumulativeWork` in the outgoing `version` message |
| `src/p2p/server.ts:540` | parses and stores `peer.remoteCumulativeWork` from a peer's `version` |
| `src/p2p/server.ts:1028` | fork resolution: work sanity check, ban guard, and reorg decision |
| `src/node.ts:199` | exposes hex `cumulativeWork` in the node status payload |

## How work is computed

`blockWork(target)` returns `2^256 / (target + 1)` as a `bigint` (`src/block.ts:159`). The target is the same hex value that `hashMeetsTarget` compares the block hash against: a *smaller* target is *harder* to hit, so it yields a *larger* work value. A target of `0` returns `0n` to avoid division issues. Because the result is a plain integer, summing per-block work across a chain is exact — there is no floating point drift.

The target for each block lives in `block.header.target`. Difficulty is retargeted on a fixed interval (`adjustDifficulty`, `src/chain.ts:270`, clamped to 4x per adjustment like Bitcoin), so different segments of the chain contribute different amounts of work per block. This is exactly why height is insufficient and per-block work must be summed.

## How cumulative work is maintained

`Blockchain.cumulativeWork` is the single source of truth for the active chain's total work. It is mutated only in tandem with the block set, so it always reflects the current tip:

- **Append** — `addBlock` validates the block, applies its UTXO changes, then does `cumulativeWork += blockWork(block.header.target)` (`src/chain.ts:198`).
- **Disconnect** — when a block is rolled back during a reorg, `disconnectBlock` restores difficulty and does `cumulativeWork -= undo.blockWork` (`src/chain.ts:756`). The work value is captured in the `BlockUndo` record at apply time (`src/chain.ts:638`) so undo never has to recompute it.
- **Startup replay** — restoring from `BlockStorage`, the genesis work is seeded and each replayed block's work is added (`src/chain.ts:87`).
- **Full replay** — the slow path in `resetToHeight` rebuilds all in-memory indexes from genesis and re-sums work block by block (`src/chain.ts:529`).

This pairing is the core invariant: every mutation of `this.blocks` has a matching mutation of `cumulativeWork`. See [REORG-UNDO.md](./REORG-UNDO.md) for the undo journal and the fast-vs-slow reset paths that perform these adjustments.

## The fork-choice rule

`Blockchain.addBlock` only extends the *active* chain linearly — it appends a block whose `previousHash` matches the current tip and rejects anything else (`src/chain.ts:142`). It does not itself choose between competing chains. Fork choice happens one layer up, in the P2P fork-resolution path (`src/p2p/server.ts:1028`), after a peer's headers reveal a fork point.

The decision is:

```text
peer advertised remoteCumulativeWork in version handshake?
├── yes → compare work
│        peer.remoteCumulativeWork <= chain.cumulativeWork ?
│        ├── yes → "Peer chain has less work — no reorg", stop
│        └── no  → reorg toward the heavier chain
└── no (legacy peer) → fall back to height comparison
                       effectivePeerHeight <= chain.getHeight() ? stop : reorg
```

When a reorg is warranted, the node calls `resetToHeight(forkPoint)` (`src/p2p/server.ts:1063` → `src/node.ts:145` → `src/chain.ts:487`), clears and rebuilds the seen-blocks cache, then requests blocks from `forkPoint + 1` to build the heavier chain forward. The comparison is strict (`<=` means "do nothing"), so an equal-work peer never triggers a reorg — ties keep the chain already in hand, which avoids reorg churn between two equally heavy tips.

## The work-based DoS guard

Before trusting `remoteCumulativeWork`, the resolver bounds it against what the peer's headers could plausibly represent (`src/p2p/server.ts:1031`). It sums the real work of our own chain up to the fork point, then adds an estimate for the peer's post-fork headers using the local difficulty (`blockWork(chain.getDifficulty()) * header count`, `src/p2p/server.ts:1037`). Headers carry only hash/height/previousHash, so this is a sanity bound, not a full verification — actual per-block work is checked when the blocks themselves arrive and pass `validateBlock`.

If the peer's claimed work exceeds `verifiedPeerWork * 3 / 2` (`src/p2p/server.ts:1039`), the claim is treated as fabricated: the peer gets `addMisbehavior(100)` (an immediate ban) and fork resolution is cleared. The 1.5x slack tolerates honest difficulty differences across the fork while still rejecting impossibly inflated claims. See [P2P-SYNC.md](./P2P-SYNC.md) for the surrounding handshake, IBD, and header-exchange flow, and [DOS-HARDENING.md](./DOS-HARDENING.md) for the broader misbehavior-scoring model.

## Wire and status exposure

`cumulativeWork` is hex-encoded (`bigint.toString(16)`) wherever it crosses a boundary:

- **Handshake** — sent in the outgoing `version` payload (`src/p2p/server.ts:459`) and read back into `peer.remoteCumulativeWork` from an incoming `version` (`src/p2p/server.ts:540`). The field is optional in the `version` schema (`src/p2p/protocol.ts:58`) for backward compatibility; absent it, the resolver uses the legacy height fallback above.
- **Status RPC** — surfaced as a hex string in the node status object (`src/node.ts:199`), letting operators and the explorer compare tip work across nodes.

Parsing of the incoming hex is defensive: an unparsable or over-length value is rejected and logged as `Invalid cumulativeWork in version message` rather than crashing the handshake. See [P2P-WIRE-PROTOCOL.md](./P2P-WIRE-PROTOCOL.md) for the byte-level framing and the full message catalog.

## Invariants and edge cases

- **Work and blocks move together.** `cumulativeWork` must equal the sum of `blockWork` over `this.blocks`. Any code path that adds or removes a block without adjusting work corrupts fork choice; the apply/disconnect and replay paths above are the only sanctioned mutators.
- **Targets, not heights, decide.** Two chains of equal height can have different work. Never substitute `getHeight()` comparisons for work comparisons except in the explicit legacy fallback for peers that omit the field.
- **Strict inequality.** Reorgs require strictly more work (`>`); equal work is a no-op. This prevents ping-ponging between equally heavy tips.
- **Header work is an estimate.** The pre-download work check uses local difficulty as a proxy and is only a DoS bound — final correctness comes from `validateBlock` / `hashMeetsTarget` on the real blocks.
- **Hex is the only serialized form.** Persisted metadata, status, and wire messages all carry work as base-16 strings; keep `toString(16)` / `BigInt('0x' + …)` symmetric and validate untrusted hex before parsing.

## Cross-references

- [BLOCK-HEADER-FORMAT.md](./BLOCK-HEADER-FORMAT.md) — the `target` field's byte layout and how the header hash is computed for the PoW predicate.
- [BLOCK-VALIDATION.md](./BLOCK-VALIDATION.md) — where `hashMeetsTarget` is enforced during block acceptance.
- [CONSENSUS-PARAMETERS.md](./CONSENSUS-PARAMETERS.md) — `STARTING_DIFFICULTY`, `DIFFICULTY_ADJUSTMENT_INTERVAL`, `MAX_REORG_DEPTH`, and related constants.
- [MINING-LIFECYCLE.md](./MINING-LIFECYCLE.md) — how the miner picks a target and restarts on a new heaviest tip.
- [REORG-UNDO.md](./REORG-UNDO.md) — the undo journal and reset paths that adjust `cumulativeWork`.
- [P2P-SYNC.md](./P2P-SYNC.md) — handshake, IBD, fork detection, and the reorg request flow.
- [P2P-WIRE-PROTOCOL.md](./P2P-WIRE-PROTOCOL.md) — framing and the `version` message schema carrying `cumulativeWork`.
- [DOS-HARDENING.md](./DOS-HARDENING.md) — misbehavior scoring and resource bounds that the work guard feeds into.
