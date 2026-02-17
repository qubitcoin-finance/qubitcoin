/**
 * Peer connection handler
 *
 * Wraps a TCP socket with:
 * - Length-prefixed framing
 * - Rate limiting (token bucket)
 * - Misbehavior scoring
 * - Handshake / idle timeouts
 * - Ping/pong keepalive
 */
import type net from 'node:net'
import {
  type Message,
  encodeMessage,
  decodeMessages,
  MAX_MESSAGE_SIZE,
} from './protocol.js'

const RATE_LIMIT_MAX = 200    // token bucket capacity (burst)
const RATE_LIMIT_REFILL = 100 // tokens/sec
const HANDSHAKE_TIMEOUT_MS = 10_000
const IDLE_TIMEOUT_MS = 120_000
const PONG_TIMEOUT_MS = 30_000
const MISBEHAVIOR_THRESHOLD = 100
const IBD_TIMEOUT_MS = 30_000

export type PeerEventHandler = (peer: Peer, msg: Message) => void
export type PeerDisconnectHandler = (peer: Peer, reason: string) => void

export class Peer {
  readonly id: string
  readonly address: string
  readonly inbound: boolean
  private socket: net.Socket
  private buffers: Buffer[] = []
  private bufferedBytes = 0
  private onMessage: PeerEventHandler
  private onDisconnect: PeerDisconnectHandler

  handshakeComplete = false
  remoteHeight = 0
  remoteGenesisHash = ''
  remoteListenPort = 0
  remoteCumulativeWork = 0n
  lastGetaddrResponse = 0

  private misbehaviorScore = 0
  private lastMisbehaviorDecay: number = Date.now()
  private tokens: number = RATE_LIMIT_MAX
  private lastTokenRefill: number = Date.now()
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private ibdTimer: ReturnType<typeof setTimeout> | null = null
  ibdPending = false
  private destroyed = false

  constructor(
    socket: net.Socket,
    inbound: boolean,
    onMessage: PeerEventHandler,
    onDisconnect: PeerDisconnectHandler,
    label?: string,
  ) {
    this.socket = socket
    this.inbound = inbound
    this.onMessage = onMessage
    this.onDisconnect = onDisconnect
    this.address = socket.remoteAddress ?? 'unknown'
    this.id = label ?? `${this.address}:${socket.remotePort}`

    socket.on('data', (data: Buffer) => this.handleData(data))
    socket.on('error', (err) => this.disconnect(`socket error: ${err.message}`))
    socket.on('close', () => this.disconnect('connection closed'))

    // Start handshake timeout
    this.handshakeTimer = setTimeout(() => {
      if (!this.handshakeComplete) {
        this.disconnect('handshake timeout')
      }
    }, HANDSHAKE_TIMEOUT_MS)

    this.resetIdleTimer()
  }

  send(msg: Message): void {
    if (this.destroyed) return
    try {
      const frame = encodeMessage(msg)
      const ok = this.socket.write(frame)
      if (!ok) {
        // Slow peer: kernel buffer full — disconnect immediately (Bitcoin Core behavior)
        this.disconnect('write backpressure')
      }
    } catch {
      this.disconnect('send error')
    }
  }

  disconnect(reason: string): void {
    if (this.destroyed) return
    this.destroyed = true
    this.clearTimers()
    this.socket.destroy()
    this.onDisconnect(this, reason)
  }

  addMisbehavior(score: number): void {
    // Decay: reduce by 1 point per minute of good behavior since last check
    this.decayMisbehavior()
    this.misbehaviorScore += score
    if (this.misbehaviorScore >= MISBEHAVIOR_THRESHOLD) {
      // Send reject before disconnecting so peer knows why
      this.send({ type: 'reject', payload: { reason: `misbehavior score ${this.misbehaviorScore}` } })
      this.disconnect(`misbehavior score ${this.misbehaviorScore}`)
    }
  }

  getMisbehaviorScore(): number {
    this.decayMisbehavior()
    return this.misbehaviorScore
  }

  /** Decay misbehavior score by 1 point per minute of good behavior */
  private decayMisbehavior(): void {
    const now = Date.now()
    const elapsedMinutes = (now - this.lastMisbehaviorDecay) / 60_000
    if (elapsedMinutes >= 1) {
      this.misbehaviorScore = Math.max(0, this.misbehaviorScore - Math.floor(elapsedMinutes))
      this.lastMisbehaviorDecay = now
    }
  }

  completeHandshake(): void {
    this.handshakeComplete = true
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
  }

  private handleData(data: Buffer): void {
    this.resetIdleTimer()

    this.buffers.push(data)
    this.bufferedBytes += data.length

    // Guard against oversized accumulation
    if (this.bufferedBytes > MAX_MESSAGE_SIZE + 4) {
      this.disconnect('buffer overflow')
      return
    }

    // Concat only when we need to parse
    const buffer = this.buffers.length === 1 ? this.buffers[0] : Buffer.concat(this.buffers)

    try {
      const { messages, remainder } = decodeMessages(buffer)
      if (remainder.length > 0) {
        this.buffers = [remainder]
        this.bufferedBytes = remainder.length
      } else {
        this.buffers = []
        this.bufferedBytes = 0
      }

      for (const msg of messages) {
        if (!this.consumeToken()) {
          this.disconnect('rate limit exceeded')
          return
        }
        this.onMessage(this, msg)
      }
    } catch (err) {
      this.addMisbehavior(25)
    }
  }

  private consumeToken(): boolean {
    const now = Date.now()
    const elapsed = (now - this.lastTokenRefill) / 1000
    this.tokens = Math.min(RATE_LIMIT_MAX, this.tokens + elapsed * RATE_LIMIT_REFILL)
    this.lastTokenRefill = now

    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      // Send ping, wait for pong
      this.send({ type: 'ping' })
      this.pongTimer = setTimeout(() => {
        this.disconnect('pong timeout')
      }, PONG_TIMEOUT_MS)
    }, IDLE_TIMEOUT_MS)
  }

  receivedPong(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
    this.resetIdleTimer()
  }

  /** Start IBD timeout — fires onIBDTimeout callback if no blocks arrive */
  startIBDTimer(onTimeout: () => void): void {
    this.clearIBDTimer()
    this.ibdPending = true
    this.ibdTimer = setTimeout(() => {
      this.ibdPending = false
      this.ibdTimer = null
      onTimeout()
    }, IBD_TIMEOUT_MS)
  }

  /** Clear IBD timeout (blocks arrived) */
  clearIBDTimer(): void {
    this.ibdPending = false
    if (this.ibdTimer) {
      clearTimeout(this.ibdTimer)
      this.ibdTimer = null
    }
  }

  private clearTimers(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.pongTimer) clearTimeout(this.pongTimer)
    if (this.ibdTimer) clearTimeout(this.ibdTimer)
    this.handshakeTimer = null
    this.idleTimer = null
    this.pongTimer = null
    this.ibdTimer = null
  }
}
