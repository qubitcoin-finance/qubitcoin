# P2P Wire Protocol & Message Catalog

This doc is the byte-level and structural reference for QubitCoin's peer-to-peer wire format: the length-prefixed JSON framing, the 14 `MessageType` values, every payload interface, the multi-tier `validateDecodedMessage` validation, and the `encodeMessage` / `decodeMessages` codec. Read it when working on `src/p2p/protocol.ts`, debugging "Invalid message type", "Message too large", "Empty message (zero length)", or "message framing error" disconnects, adding a new message type or payload field, or reasoning about `PROTOCOL_VERSION` compatibility. For the *behavioral* side — handshake order, IBD, fork resolution, relay — read [P2P-SYNC](./P2P-SYNC.md) instead; this doc stops at the codec boundary and does not describe sync state machines.

## Why it exists

Peers exchange consensus-critical data (blocks, transactions, headers, addresses) over raw TCP. TCP is a byte stream with no message boundaries, so the protocol needs its own framing to know where one message ends and the next begins. It also needs strict, fail-closed validation: an untrusted peer can send arbitrary bytes, so the decoder must reject malformed framing, unknown message types, and structurally-wrong payloads *before* any handler touches the data.

`src/p2p/protocol.ts` solves both problems with one design: a 4-byte big-endian length prefix followed by a UTF-8 JSON body, plus a `validateDecodedMessage` gate that every inbound message passes through. JSON (rather than a custom binary encoding) keeps the implementation small and debuggable; the binary-heavy fields inside blocks and transactions are already hex-encoded via `sanitize` before they reach the wire, so the JSON body stays printable.

## Key files

| Path:line | Symbol | Role |
|---|---|---|
| `src/p2p/protocol.ts:8` | `MAX_MESSAGE_SIZE` | 5 MB hard cap on a single framed message body |
| `src/p2p/protocol.ts:9` | `PROTOCOL_VERSION` | Wire protocol version (`2`), advertised in `version` |
| `src/p2p/protocol.ts:11` | `MessageType` | Union of the 14 valid message type strings |
| `src/p2p/protocol.ts:48` | `isValidMessageType` | O(1) membership check against `VALID_MESSAGE_TYPES` |
| `src/p2p/protocol.ts:52` | `VersionPayload` | Handshake payload interface |
| `src/p2p/protocol.ts:108` | `validateStructuredPayload` | Per-type shape checks (arrays / objects present) |
| `src/p2p/protocol.ts:149` | `validateDecodedMessage` | Top-level inbound validation gate |
| `src/p2p/protocol.ts:177` | `encodeMessage` | Serialize a `Message` to a length-prefixed `Buffer` |
| `src/p2p/protocol.ts:193` | `decodeMessages` | Stream decoder: returns complete messages + remainder |
| `src/p2p/peer.ts:87` | `Peer.send` | Frame + write a message; disconnect on backpressure |
| `src/p2p/peer.ts:149` | `Peer.handleData` | Accumulate TCP chunks, decode, rate-limit, dispatch |
| `src/p2p/server.ts:401` | message dispatch switch | Route each validated `Message` to its handler |

## Frame format

Every message on the wire is a single frame:

```text
+--------------------+-------------------------------+
| length (4 bytes)   | body (length bytes)           |
| uint32, big-endian | UTF-8 JSON of the Message      |
+--------------------+-------------------------------+
```

The `length` field counts only the JSON body, not the 4 prefix bytes. `encodeMessage` (`protocol.ts:177`) builds the frame: it `JSON.stringify`s the `Message`, encodes to a UTF-8 `Buffer`, throws `Message too large: <n> bytes` if the body exceeds `MAX_MESSAGE_SIZE`, then allocates `4 + body.length` bytes, writes the length with `writeUInt32BE`, and copies the body in after it.

The JSON body is always a `Message` object — `{ "type": "...", "payload": ... }` — never a bare value. The `payload` key is omitted entirely for payloadless types (see below).

## The Message envelope

```ts
interface Message {
  type: MessageType
  payload?: unknown
}
```

`type` is required and must be one of the 14 strings. `payload` is optional: control messages that carry no data (`verack`, `getaddr`, `ping`, `pong`) serialize with no `payload` key at all. `encodeMessage` does not special-case this — callers simply construct `{ type: 'ping' }` and `JSON.stringify` drops the absent field.

## Message catalog

There are 14 message types in the `MessageType` union (`protocol.ts:11`). Each row lists its payload interface (if any) and what it is for. Payload interfaces live in `protocol.ts` immediately below the union.

| Type | Payload interface | Purpose |
|---|---|---|
| `version` | `VersionPayload` | Opening handshake: advertise height, genesis, work, listen port |
| `verack` | *(none)* | Acknowledge a `version`; completes the handshake |
| `reject` | `RejectPayload` | Tell a peer why it is being rejected before disconnect |
| `getblocks` | `GetBlocksPayload` | Request blocks starting at `fromHeight` (IBD) |
| `blocks` | `BlocksPayload` | Deliver a batch of sanitized blocks |
| `tx` | `TxPayload` | Relay a single sanitized transaction |
| `inv` | `InvPayload` | Announce availability of one block or tx by hash |
| `getdata` | `GetDataPayload` | Request the full object named in an `inv` |
| `getheaders` | `GetHeadersPayload` | Request headers using a locator (fork resolution) |
| `headers` | `HeadersPayload` | Deliver lightweight `{hash,height,previousHash}` headers |
| `ping` | *(none)* | Liveness probe |
| `pong` | *(none)* | Liveness reply |
| `addr` | `AddrPayload` | Gossip known peer addresses |
| `getaddr` | *(none)* | Ask a peer for addresses |

### Payload shapes

The structured payloads, verbatim from `protocol.ts`:

- `VersionPayload` (`:52`) — `version: number`, `height: number`, `genesisHash: string`, `userAgent: string`, optional `listenPort?: number` (so an inbound peer learns the dialable port), optional `cumulativeWork?: string` (hex-encoded PoW; optional for backwards compatibility with older nodes).
- `AddrPayload` (`:61`) — `addresses: Array<{ host; port; lastSeen }>`.
- `GetBlocksPayload` (`:65`) — `fromHeight: number`.
- `BlocksPayload` (`:69`) — `blocks: unknown[]`, each a *sanitized* block (hex fields already stringified upstream).
- `TxPayload` (`:73`) — `tx: unknown`, a sanitized transaction object.
- `InvPayload` / `GetDataPayload` (`:77`, `:82`) — `type: 'block' | 'tx'` plus `hash: string`.
- `GetHeadersPayload` (`:87`) — `locatorHashes: string[]`, a block locator newest-first.
- `HeadersPayload` (`:91`) — `headers: Array<{ hash; height; previousHash }>`.
- `RejectPayload` (`:95`) — `reason: string`.

The `blocks` and `tx` payloads carry `unknown` because the block/transaction objects are deserialized and consensus-validated downstream, not at the wire layer. The wire layer only checks that the container shape is right (an array for `blocks`, an object for `tx`).

## Inbound validation

`validateDecodedMessage` (`protocol.ts:149`) is the single gate every inbound message passes through after JSON parsing. It runs three tiers, each fail-closed:

1. **Envelope check.** The parsed value must be a non-null, non-array object (`isMessageObject`). Otherwise: `Invalid message: expected object`.
2. **Type check.** `type` must be a non-empty string and a member of `VALID_MESSAGE_TYPES` via `isValidMessageType`. A missing type throws `Invalid message: missing type`; an unknown one throws `Invalid message type: <type>`.
3. **Payload shape check.** If the type is in `OBJECT_PAYLOAD_TYPES` (`protocol.ts:34`), the payload must be an object, and `validateStructuredPayload` (`protocol.ts:108`) asserts the specific shape — e.g. `blocks` requires an array at `payload.blocks`, `tx` requires an object at `payload.tx`, `inv`/`getdata` require string `type` and `hash`. Types *not* in `OBJECT_PAYLOAD_TYPES` (the payloadless control messages `verack`, `ping`, `pong`, `getaddr`) skip this tier.

`OBJECT_PAYLOAD_TYPES` is deliberately a subset of `VALID_MESSAGE_TYPES`: it lists exactly the types that *must* carry an object payload. This is why `verack`/`ping`/`pong`/`getaddr` validate even though they have no payload — they are absent from the object-payload set, so tier 3 is skipped for them.

Validation only confirms *structure*, never *content*: a `blocks` message with a non-empty array passes the wire gate regardless of whether the blocks are consensus-valid. Semantic validation happens later in the server handlers and `validateBlock` — see [BLOCK-VALIDATION](./BLOCK-VALIDATION.md).

## The stream decoder

TCP delivers bytes in arbitrary chunks, so `decodeMessages` (`protocol.ts:193`) is a resumable frame decoder, not a one-shot parser. Given an accumulated `Buffer` it loops:

- While at least 4 bytes remain, read the length prefix with `readUInt32BE`.
- A zero length throws `Empty message (zero length)` — a deliberate framing error, never valid.
- A length above `MAX_MESSAGE_SIZE` throws `Message size <n> exceeds max <max>` before any body bytes are read, so an attacker cannot force a huge allocation by lying about length.
- If the full body has not arrived yet (`offset + 4 + length > buffer.length`), it **breaks** and leaves those bytes for next time.
- Otherwise it slices the body, `JSON.parse`s it, runs `validateDecodedMessage`, pushes the result, and advances past the frame.

It returns `{ messages, remainder }`, where `remainder` is the trailing bytes of a partial frame. This contract is what lets `Peer.handleData` (`peer.ts:149`) feed in TCP chunks of any size.

### How Peer drives the decoder

`Peer.handleData` accumulates inbound chunks in a `buffers` array and tracks `bufferedBytes`. Before parsing it enforces a hard ceiling: if `bufferedBytes > MAX_MESSAGE_SIZE + 4` it disconnects with `buffer overflow` (`peer.ts:156`), so a peer cannot starve memory by sending a long stream that never completes a frame. It then concatenates (only when more than one chunk is buffered), calls `decodeMessages`, stashes the `remainder` back into `buffers` for the next chunk, and dispatches each decoded message through `consumeToken` (token-bucket rate limit) into `onMessage`. Any throw from `decodeMessages` — bad length, bad JSON, failed validation — triggers an immediate `message framing error` disconnect, because once framing is corrupt the byte stream can no longer be trusted for partial-penalty scoring.

On the outbound side, `Peer.send` (`peer.ts:87`) frames with `encodeMessage` and writes the frame; if `socket.write` returns `false` (kernel send buffer full) it disconnects with `write backpressure`, matching Bitcoin Core's treatment of slow peers.

## Invariants and edge cases

- **Length counts the body only.** The 4 prefix bytes are never included in the advertised length. Off-by-four bugs surface as `Empty message` or `Message size ... exceeds max`.
- **Big-endian, always.** Both `writeUInt32BE` and `readUInt32BE` are big-endian; a little-endian writer would be misread as a multi-gigabyte length and rejected.
- **Zero length is illegal.** There is no valid empty frame; even payloadless messages serialize to a non-empty JSON object like `{"type":"ping"}`.
- **Validation is fail-closed.** Anything the gate cannot positively confirm is rejected, and a framing-level rejection disconnects the peer rather than scoring it — see misbehavior scoring in [P2P-SYNC](./P2P-SYNC.md) and [DOS-HARDENING](./DOS-HARDENING.md).
- **`MAX_MESSAGE_SIZE` is checked twice.** `encodeMessage` refuses to *send* an oversized frame, and `decodeMessages` refuses to *allocate* for one. Block-batch sizing upstream must respect the 5 MB ceiling or large `blocks` batches will throw on encode.
- **`PROTOCOL_VERSION` is advisory, not enforced at the codec.** The wire layer accepts any `version` integer; compatibility decisions (e.g. tolerating a missing `cumulativeWork`) live in the `handleVersion` handler, not in `protocol.ts`. Optional fields exist precisely so a v2 node can still talk to an older peer.

## Cross-references

- [P2P-SYNC](./P2P-SYNC.md) — handshake order, IBD, fork resolution, relay, and misbehavior scoring that consume these messages.
- [PEER-ADDRESS-MANAGEMENT](./PEER-ADDRESS-MANAGEMENT.md) — how `addr` / `getaddr` payloads feed the address book, gossip, and bans.
- [DOS-HARDENING](./DOS-HARDENING.md) — the resource limits (message size, buffer overflow, rate limiting) framed as DoS boundaries.
- [BLOCK-STORAGE](./BLOCK-STORAGE.md) — the `sanitize` / deserialize boundary that prepares blocks and transactions before they become `blocks` / `tx` payloads.
- [BLOCK-VALIDATION](./BLOCK-VALIDATION.md) — the consensus checks applied to blocks after they clear the wire gate.
