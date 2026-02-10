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

export type PeerEventHandler = (peer: Peer, msg: Message) => void
export type PeerDisconnectHandler = (peer: Peer, reason: string) => void

export class Peer {
  readonly id: string
  readonly address: string
  readonly inbound: boolean
  private socket: net.Socket
  private buffer: Buffer = Buffer.alloc(0)
  private onMessage: PeerEventHandler
  private onDisconnect: PeerDisconnectHandler

  handshakeComplete = false
  remoteHeight = 0
  remoteGenesisHash = ''

  private misbehaviorScore = 0
  private tokens: number = RATE_LIMIT_MAX
  private lastTokenRefill: number = Date.now()
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  constructor(
    socket: net.Socket,
    inbound: boolean,
    onMessage: PeerEventHandler,
    onDisconnect: PeerDisconnectHandler,
  ) {
    this.socket = socket
    this.inbound = inbound
    this.onMessage = onMessage
    this.onDisconnect = onDisconnect
    this.address = socket.remoteAddress ?? 'unknown'
    this.id = `${this.address}:${socket.remotePort}`

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
      this.socket.write(frame)
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
    this.misbehaviorScore += score
    if (this.misbehaviorScore >= MISBEHAVIOR_THRESHOLD) {
      this.disconnect(`misbehavior score ${this.misbehaviorScore}`)
    }
  }

  getMisbehaviorScore(): number {
    return this.misbehaviorScore
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

    this.buffer = Buffer.concat([this.buffer, data])

    // Guard against oversized accumulation
    if (this.buffer.length > MAX_MESSAGE_SIZE + 4) {
      this.disconnect('buffer overflow')
      return
    }

    try {
      const { messages, remainder } = decodeMessages(this.buffer)
      this.buffer = remainder

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
  }

  private clearTimers(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.handshakeTimer = null
    this.idleTimer = null
    this.pongTimer = null
  }
}
