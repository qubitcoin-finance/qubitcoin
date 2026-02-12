/**
 * Streaming parser for Bitcoin Core's `dumptxoutset` v2 binary format.
 *
 * Usage:
 *   import { parseDumptxoutset } from './parse-utxoset.js'
 *   for await (const coin of parseDumptxoutset('/path/to/utxos.dat')) {
 *     console.log(coin.scriptType, coin.addressHash, coin.amount)
 *   }
 *
 * Binary format (v2):
 *   Header: 5B magic + 2B version + 4B network + 32B blockhash + 8B coin_count = 51 bytes
 *   Body: coins grouped by txid
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { bytesToHex } from '@noble/hashes/utils.js'

// --- Types ---

export interface SnapshotHeader {
  version: number
  networkMagic: Uint8Array
  blockHash: string       // 64-char hex (little-endian as stored)
  coinCount: bigint
}

export type ScriptType = 'p2pkh' | 'p2sh' | 'p2pk' | 'p2wpkh' | 'p2wsh' | 'p2tr' | 'multisig' | 'op_return' | 'other'

export interface ParsedCoin {
  txid: string            // 64-char hex
  vout: number
  height: number
  coinbase: boolean
  amount: bigint          // satoshis (decompressed)
  scriptType: ScriptType
  addressHash?: string    // hex of the 20-byte or 32-byte hash (if extractable)
  isGroupEnd: boolean     // true when this is the last coin in a txid group
}

export interface ResumeState {
  bytesRead: number       // byte offset in the file to resume from
  coinsRead: bigint       // number of coins already processed
}

// --- Constants ---

const MAGIC = new Uint8Array([0x75, 0x74, 0x78, 0x6f, 0xff]) // "utxo\xff"
const HEADER_SIZE = 51
const READ_CHUNK = 64 * 1024 * 1024 // 64 MB

// --- Buffered reader ---

class BufferedReader {
  private chunks: Buffer[] = []
  private totalLen = 0
  private consumed = 0
  private pos = 0 // position within logical buffer
  private stream: ReturnType<typeof createReadStream>
  private done = false
  private pendingRead: { resolve: () => void; reject: (e: Error) => void } | null = null

  bytesRead = 0

  constructor(path: string, start = 0) {
    this.bytesRead = start
    this.stream = createReadStream(path, { start, highWaterMark: READ_CHUNK })
    this.stream.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk)
      this.totalLen += chunk.length
      if (this.pendingRead && this.available() >= this.pendingRead.needed) {
        const pr = this.pendingRead
        this.pendingRead = null
        pr.resolve()
      }
    })
    this.stream.on('end', () => {
      this.done = true
      if (this.pendingRead) {
        const pr = this.pendingRead
        this.pendingRead = null
        pr.resolve()
      }
    })
    this.stream.on('error', (err) => {
      if (this.pendingRead) {
        const pr = this.pendingRead
        this.pendingRead = null
        pr.reject(err)
      }
    })
    // pause initially, we'll resume when we need data
    this.stream.pause()
  }

  private available(): number {
    return this.totalLen - this.consumed - this.pos
  }

  // Compact consumed chunks
  private compact() {
    if (this.consumed === 0) return
    let skip = this.consumed
    while (this.chunks.length > 0 && skip >= this.chunks[0].length) {
      skip -= this.chunks[0].length
      this.totalLen -= this.chunks[0].length
      this.chunks.shift()
    }
    if (skip > 0 && this.chunks.length > 0) {
      this.chunks[0] = this.chunks[0].subarray(skip)
      this.totalLen -= skip
    }
    this.consumed = 0
  }

  private async ensureAvailable(n: number): Promise<void> {
    if (this.available() >= n) return
    if (this.done) return // no more data
    this.compact()
    this.stream.resume()
    await new Promise<void>((resolve, reject) => {
      (this as any).pendingRead = { resolve, reject, needed: n }
    })
    this.stream.pause()
  }

  /** Read exactly n bytes */
  async readBytes(n: number): Promise<Buffer> {
    await this.ensureAvailable(n)
    const result = Buffer.alloc(n)
    let written = 0
    let offset = this.consumed + this.pos

    for (const chunk of this.chunks) {
      if (offset >= chunk.length) {
        offset -= chunk.length
        continue
      }
      const available = chunk.length - offset
      const toCopy = Math.min(available, n - written)
      chunk.copy(result, written, offset, offset + toCopy)
      written += toCopy
      offset = 0
      if (written >= n) break
    }

    this.pos += n
    this.bytesRead += n
    return result
  }

  /** Read a single byte */
  async readByte(): Promise<number> {
    const buf = await this.readBytes(1)
    return buf[0]
  }

  /** Consume all read bytes (advance the window) */
  advance() {
    this.consumed += this.pos
    this.pos = 0
    // Compact periodically
    if (this.consumed > READ_CHUNK) this.compact()
  }

  destroy() {
    this.stream.destroy()
  }
}

// --- Varint / CompactSize decoders ---

/**
 * Read Bitcoin's MSB-128 varint.
 * Each byte: bit 7 = continuation, bits 0-6 = data.
 * Non-final bytes have their 7-bit value incremented by 1 during encoding.
 */
async function readVarint(reader: BufferedReader): Promise<bigint> {
  let n = 0n
  for (;;) {
    const byte = await reader.readByte()
    if ((byte & 0x80) !== 0) {
      n = (n << 7n) | BigInt(byte & 0x7f)
      n += 1n // undo the subtract-1 encoding
    } else {
      n = (n << 7n) | BigInt(byte & 0x7f)
      return n
    }
  }
}

/** Read Bitcoin's CompactSize encoding */
async function readCompactSize(reader: BufferedReader): Promise<number> {
  const first = await reader.readByte()
  if (first < 0xfd) return first
  if (first === 0xfd) {
    const buf = await reader.readBytes(2)
    return buf.readUInt16LE(0)
  }
  if (first === 0xfe) {
    const buf = await reader.readBytes(4)
    return buf.readUInt32LE(0)
  }
  // 0xff
  const buf = await reader.readBytes(8)
  return Number(buf.readBigUInt64LE(0))
}

// --- Amount decompression ---

/**
 * Decompress a Bitcoin compressed amount back to satoshis.
 * See Bitcoin Core compressor.cpp DecompressAmount()
 */
function decompressAmount(x: bigint): bigint {
  if (x === 0n) return 0n
  x -= 1n
  const e = Number(x % 10n)
  x = x / 10n
  let n: bigint
  if (e < 9) {
    const d = (x % 9n) + 1n
    x = x / 9n
    n = x * 10n + d
  } else {
    n = x + 1n
  }
  let result = n
  for (let i = 0; i < e; i++) {
    result *= 10n
  }
  return result
}

// --- Script decompression ---

interface DecompressedScript {
  scriptType: ScriptType
  addressHash?: string // hex of 20-byte or 32-byte hash
}

async function readCompressedScript(reader: BufferedReader): Promise<DecompressedScript> {
  const nSize = Number(await readVarint(reader))

  if (nSize === 0x00) {
    // P2PKH: 20-byte keyhash
    const hash = await reader.readBytes(20)
    return { scriptType: 'p2pkh', addressHash: hash.toString('hex') }
  }
  if (nSize === 0x01) {
    // P2SH: 20-byte scripthash
    const hash = await reader.readBytes(20)
    return { scriptType: 'p2sh', addressHash: hash.toString('hex') }
  }
  if (nSize === 0x02 || nSize === 0x03) {
    // P2PK compressed: nSize is the prefix byte, followed by 32-byte x-coord
    const xCoord = await reader.readBytes(32)
    const compressed = Buffer.concat([Buffer.from([nSize]), xCoord])
    const hash = bytesToHex(ripemd160(sha256(compressed)))
    return { scriptType: 'p2pk', addressHash: hash }
  }
  if (nSize === 0x04 || nSize === 0x05) {
    // P2PK uncompressed: recover compressed prefix (0x04→0x02 even y, 0x05→0x03 odd y)
    const xCoord = await reader.readBytes(32)
    const prefix = nSize === 0x04 ? 0x02 : 0x03
    const compressed = Buffer.concat([Buffer.from([prefix]), xCoord])
    const hash = bytesToHex(ripemd160(sha256(compressed)))
    return { scriptType: 'p2pk', addressHash: hash }
  }

  // Other scripts: nSize - 6 = actual script length
  const scriptLen = nSize - 6
  if (scriptLen <= 0) {
    return { scriptType: 'other' }
  }
  const script = await reader.readBytes(scriptLen)

  // Try to identify witness scripts from raw script
  // P2WPKH: OP_0 PUSH20 <20 bytes> = 22 bytes
  if (scriptLen === 22 && script[0] === 0x00 && script[1] === 0x14) {
    return { scriptType: 'p2wpkh', addressHash: script.subarray(2, 22).toString('hex') }
  }
  // P2WSH: OP_0 PUSH32 <32 bytes> = 34 bytes
  if (scriptLen === 34 && script[0] === 0x00 && script[1] === 0x20) {
    return { scriptType: 'p2wsh', addressHash: script.subarray(2, 34).toString('hex') }
  }
  // P2TR: OP_1 PUSH32 <32 bytes> = 34 bytes
  if (scriptLen === 34 && script[0] === 0x51 && script[1] === 0x20) {
    return { scriptType: 'p2tr', addressHash: script.subarray(2, 34).toString('hex') }
  }

  // OP_RETURN (nulldata / provably unspendable): OP_RETURN ...
  if (script[0] === 0x6a) {
    return { scriptType: 'op_return' }
  }

  // Bare multisig: <m> <pubkeys...> <n> OP_CHECKMULTISIG (0xae)
  if (script[scriptLen - 1] === 0xae) {
    return { scriptType: 'multisig' }
  }

  return { scriptType: 'other' }
}

// --- Main parser ---

export async function parseHeader(path: string): Promise<SnapshotHeader> {
  const reader = new BufferedReader(path)
  try {
    const magic = await reader.readBytes(5)
    for (let i = 0; i < 5; i++) {
      if (magic[i] !== MAGIC[i]) {
        throw new Error(`Invalid magic bytes at position ${i}: expected 0x${MAGIC[i].toString(16)}, got 0x${magic[i].toString(16)}`)
      }
    }

    const versionBuf = await reader.readBytes(2)
    const version = versionBuf.readUInt16LE(0)
    if (version !== 2) {
      throw new Error(`Unsupported version: ${version} (expected 2)`)
    }

    const networkMagic = new Uint8Array(await reader.readBytes(4))
    const blockHashBuf = await reader.readBytes(32)
    const blockHash = blockHashBuf.toString('hex')
    const coinCountBuf = await reader.readBytes(8)
    const coinCount = coinCountBuf.readBigUInt64LE(0)

    return { version, networkMagic, blockHash, coinCount }
  } finally {
    reader.destroy()
  }
}

/**
 * Async generator that streams all coins from a dumptxoutset v2 file.
 * Yields one ParsedCoin per UTXO entry.
 *
 * When `resumeFrom` is provided, skips the header and seeks directly to the
 * byte offset, continuing from `coinsRead`. The caller must ensure the offset
 * falls on a txid-group boundary (i.e. after the last coin of a group).
 */
export async function* parseDumptxoutset(
  path: string,
  onProgress?: (bytesRead: number, coinsRead: bigint) => void,
  resumeFrom?: ResumeState,
): AsyncGenerator<ParsedCoin> {
  // Always read header to get coinCount
  const header = await parseHeader(path)
  const coinCount = header.coinCount

  const startOffset = resumeFrom ? resumeFrom.bytesRead : HEADER_SIZE
  const reader = new BufferedReader(path, startOffset)

  try {
    let coinsRead = resumeFrom ? resumeFrom.coinsRead : 0n
    let remainingInGroup = 0
    let currentTxid = ''

    while (coinsRead < coinCount) {
      // Start new txid group if needed
      if (remainingInGroup === 0) {
        const txidBuf = await reader.readBytes(32)
        currentTxid = txidBuf.toString('hex')
        remainingInGroup = await readCompactSize(reader)
      }

      // Read one coin
      const vout = await readCompactSize(reader)
      const nCode = await readVarint(reader)
      const height = Number(nCode >> 1n)
      const coinbase = (nCode & 1n) === 1n

      const compressedAmount = await readVarint(reader)
      const amount = decompressAmount(compressedAmount)

      const script = await readCompressedScript(reader)

      remainingInGroup--
      coinsRead++

      const isGroupEnd = remainingInGroup === 0

      reader.advance()

      yield {
        txid: currentTxid,
        vout,
        height,
        coinbase,
        amount,
        scriptType: script.scriptType,
        addressHash: script.addressHash,
        isGroupEnd,
      }

      // Progress callback every 100k coins
      if (onProgress && coinsRead % 100_000n === 0n) {
        onProgress(reader.bytesRead, coinsRead)
      }
    }

    if (onProgress) {
      onProgress(reader.bytesRead, coinsRead)
    }
  } finally {
    reader.destroy()
  }
}
