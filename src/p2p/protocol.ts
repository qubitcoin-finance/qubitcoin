/**
 * P2P wire protocol
 *
 * Length-prefixed JSON over TCP.
 * 4-byte big-endian uint32 length prefix + JSON payload.
 */

export const MAX_MESSAGE_SIZE = 5 * 1024 * 1024 // 5 MB
export const PROTOCOL_VERSION = 2

export type MessageType =
  | 'version'
  | 'verack'
  | 'reject'
  | 'getblocks'
  | 'blocks'
  | 'tx'
  | 'inv'
  | 'getdata'
  | 'getheaders'
  | 'headers'
  | 'ping'
  | 'pong'
  | 'addr'
  | 'getaddr'

export interface VersionPayload {
  version: number
  height: number
  genesisHash: string
  userAgent: string
  listenPort?: number // P2P listen port so peers know how to connect back
  cumulativeWork?: string // hex-encoded cumulative PoW (optional for backwards compat)
}

export interface AddrPayload {
  addresses: Array<{ host: string; port: number; lastSeen: number }>
}

export interface GetBlocksPayload {
  fromHeight: number
}

export interface BlocksPayload {
  blocks: unknown[] // sanitized blocks
}

export interface TxPayload {
  tx: unknown // sanitized transaction
}

export interface InvPayload {
  type: 'block' | 'tx'
  hash: string
}

export interface GetDataPayload {
  type: 'block' | 'tx'
  hash: string
}

export interface GetHeadersPayload {
  locatorHashes: string[]
}

export interface HeadersPayload {
  headers: Array<{ hash: string; height: number; previousHash: string }>
}

export interface RejectPayload {
  reason: string
}

export interface Message {
  type: MessageType
  payload?: unknown
}

/** Encode a message to a length-prefixed buffer */
export function encodeMessage(msg: Message): Buffer {
  const json = JSON.stringify(msg)
  const body = Buffer.from(json, 'utf-8')
  if (body.length > MAX_MESSAGE_SIZE) {
    throw new Error(`Message too large: ${body.length} bytes`)
  }
  const frame = Buffer.alloc(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

/**
 * Frame decoder: accumulates data, yields complete messages.
 * Returns { messages, remainder } where remainder is leftover bytes.
 */
export function decodeMessages(
  buffer: Buffer
): { messages: Message[]; remainder: Buffer } {
  const messages: Message[] = []
  let offset = 0

  while (offset + 4 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)

    if (length > MAX_MESSAGE_SIZE) {
      throw new Error(`Message size ${length} exceeds max ${MAX_MESSAGE_SIZE}`)
    }

    if (offset + 4 + length > buffer.length) {
      break // incomplete message
    }

    const json = buffer.toString('utf-8', offset + 4, offset + 4 + length)
    const msg = JSON.parse(json) as Message

    if (!msg.type || typeof msg.type !== 'string') {
      throw new Error('Invalid message: missing type')
    }

    messages.push(msg)
    offset += 4 + length
  }

  return {
    messages,
    remainder: buffer.subarray(offset),
  }
}
