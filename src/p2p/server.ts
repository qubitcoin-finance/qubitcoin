/**
 * P2P Server
 *
 * TCP server + outbound connections.
 * Handles handshake, IBD (initial block download), block/tx relay.
 * Ban list, max peers, genesis check.
 */
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { Peer } from './peer.js'
import {
  type Message,
  type VersionPayload,
  type GetBlocksPayload,
  type BlocksPayload,
  type TxPayload,
  type InvPayload,
  type GetDataPayload,
  PROTOCOL_VERSION,
} from './protocol.js'
import type { Node } from '../node.js'
import { sanitizeForStorage } from '../storage.js'
import { hexToBytes, bytesToHex } from '../crypto.js'
import type { Block } from '../block.js'
import type { Transaction, TransactionInput, ClaimData } from '../transaction.js'

const MAX_INBOUND = 25
const MAX_OUTBOUND = 25
const IBD_BATCH_SIZE = 50
const SEEN_CACHE_MAX = 10_000
const BAN_DURATION_MS = 24 * 60 * 60 * 1000 // 24h

/** Known Uint8Array fields that need deserialization from P2P messages */
const TX_INPUT_BINARY_FIELDS = ['publicKey', 'signature'] as const
const CLAIM_DATA_BINARY_FIELDS = ['ecdsaPublicKey', 'ecdsaSignature'] as const

function deserializeTransaction(raw: Record<string, unknown>): Transaction {
  const tx = raw as unknown as Transaction
  if (Array.isArray(raw.inputs)) {
    tx.inputs = raw.inputs.map((inp: Record<string, unknown>) => {
      const input = inp as unknown as TransactionInput
      for (const field of TX_INPUT_BINARY_FIELDS) {
        if (typeof inp[field] === 'string') {
          (input as Record<string, unknown>)[field] = hexToBytes(inp[field] as string)
        }
      }
      return input
    })
  }
  if (raw.claimData && typeof raw.claimData === 'object') {
    const cd = raw.claimData as Record<string, unknown>
    for (const field of CLAIM_DATA_BINARY_FIELDS) {
      if (typeof cd[field] === 'string') {
        (cd as Record<string, unknown>)[field] = hexToBytes(cd[field] as string)
      }
    }
    tx.claimData = cd as unknown as ClaimData
  }
  return tx
}

function deserializeBlock(raw: Record<string, unknown>): Block {
  const block = raw as unknown as Block
  if (Array.isArray(raw.transactions)) {
    block.transactions = raw.transactions.map((t: Record<string, unknown>) =>
      deserializeTransaction(t)
    )
  }
  return block
}

export class P2PServer {
  private server: net.Server
  private peers: Map<string, Peer> = new Map()
  private inboundCount = 0
  private outboundCount = 0
  private node: Node
  private banList: Map<string, number> = new Map() // IP -> expiry timestamp
  private banListPath: string | null = null
  private seenBlocks: Set<string> = new Set()
  private seenTxs: Set<string> = new Set()
  private port: number
  private syncResolvers: Array<() => void> = []
  private seeds: Array<{ host: string; port: number }> = []
  private reconnectTimer: ReturnType<typeof setInterval> | null = null

  constructor(node: Node, port: number, dataDir?: string) {
    this.node = node
    this.port = port
    this.server = net.createServer((socket) => this.handleInbound(socket))

    if (dataDir) {
      this.banListPath = path.join(dataDir, 'banned.json')
      this.loadBanList()
    }

    // Wire up node broadcast hooks
    node.onNewBlock = (block) => this.broadcastBlock(block)
    node.onNewTransaction = (tx) => this.broadcastTx(tx)
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`P2P server listening on port ${this.port}`)
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer)
      this.reconnectTimer = null
    }
    return new Promise((resolve) => {
      for (const peer of this.peers.values()) {
        peer.disconnect('server shutdown')
      }
      this.server.close(() => resolve())
    })
  }

  connectToSeeds(seeds: string[]): void {
    this.seeds = []
    for (const seed of seeds) {
      const [host, portStr] = seed.split(':')
      const port = parseInt(portStr, 10)
      if (!host || isNaN(port)) continue
      this.seeds.push({ host, port })
      this.connectOutbound(host, port)
    }

    // Reconnect to seeds every 30s if we have no outbound peers
    if (!this.reconnectTimer && this.seeds.length > 0) {
      this.reconnectTimer = setInterval(() => {
        if (this.outboundCount === 0) {
          console.log('P2P: No outbound peers — reconnecting to seeds...')
          for (const seed of this.seeds) {
            this.connectOutbound(seed.host, seed.port)
          }
        }
      }, 30_000)
    }
  }

  /**
   * Wait for IBD to complete or timeout.
   * Resolves when we've caught up with peers, or after timeout if no peers respond.
   */
  waitForSync(timeoutMs = 15_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.syncResolvers = this.syncResolvers.filter((r) => r !== resolve)
        reject(new Error('Could not sync with any seed node — check network/firewall'))
      }, timeoutMs)

      this.syncResolvers.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private notifySynced(): void {
    const resolvers = this.syncResolvers
    this.syncResolvers = []
    for (const resolve of resolvers) resolve()
  }

  connectOutbound(host: string, port: number): void {
    if (this.outboundCount >= MAX_OUTBOUND) return
    if (this.isBanned(host)) return

    const socket = net.createConnection({ host, port }, () => {
      const peer = this.createPeer(socket, false)
      if (!peer) {
        socket.destroy()
        return
      }
      this.sendVersion(peer)
    })

    socket.on('error', () => {
      // Connection failed, ignore
    })
  }

  getPeers(): Array<{ id: string; address: string; inbound: boolean; height: number }> {
    return Array.from(this.peers.values()).map((p) => ({
      id: p.id,
      address: p.address,
      inbound: p.inbound,
      height: p.remoteHeight,
    }))
  }

  private handleInbound(socket: net.Socket): void {
    const addr = socket.remoteAddress ?? ''
    if (this.isBanned(addr)) {
      socket.destroy()
      return
    }
    if (this.inboundCount >= MAX_INBOUND) {
      socket.destroy()
      return
    }
    this.createPeer(socket, true)
  }

  private createPeer(socket: net.Socket, inbound: boolean): Peer | null {
    const peer = new Peer(
      socket,
      inbound,
      (p, msg) => this.handleMessage(p, msg),
      (p, reason) => this.handleDisconnect(p, reason),
    )

    this.peers.set(peer.id, peer)
    if (inbound) this.inboundCount++
    else this.outboundCount++

    return peer
  }

  private handleDisconnect(peer: Peer, reason: string): void {
    console.log(`P2P: ${peer.id} disconnected: ${reason}`)

    // Ban if misbehavior was the cause
    if (peer.getMisbehaviorScore() >= 100) {
      this.ban(peer.address)
    }

    this.peers.delete(peer.id)
    if (peer.inbound) this.inboundCount--
    else this.outboundCount--
  }

  private handleMessage(peer: Peer, msg: Message): void {
    try {
      switch (msg.type) {
        case 'version':
          this.handleVersion(peer, msg.payload as VersionPayload)
          break
        case 'verack':
          this.handleVerack(peer)
          break
        case 'getblocks':
          this.handleGetBlocks(peer, msg.payload as GetBlocksPayload)
          break
        case 'blocks':
          this.handleBlocks(peer, msg.payload as BlocksPayload)
          break
        case 'tx':
          this.handleTx(peer, msg.payload as TxPayload)
          break
        case 'inv':
          this.handleInv(peer, msg.payload as InvPayload)
          break
        case 'getdata':
          this.handleGetData(peer, msg.payload as GetDataPayload)
          break
        case 'ping':
          peer.send({ type: 'pong' })
          break
        case 'pong':
          peer.receivedPong()
          break
        default:
          peer.addMisbehavior(10)
      }
    } catch {
      peer.addMisbehavior(10)
    }
  }

  private sendVersion(peer: Peer): void {
    const payload: VersionPayload = {
      version: PROTOCOL_VERSION,
      height: this.node.chain.getHeight(),
      genesisHash: this.node.chain.blocks[0].hash,
      userAgent: `qubitcoin/${PROTOCOL_VERSION}`,
    }
    peer.send({ type: 'version', payload })
  }

  private handleVersion(peer: Peer, payload: VersionPayload): void {
    if (!payload || typeof payload.height !== 'number' || typeof payload.genesisHash !== 'string') {
      peer.addMisbehavior(25)
      return
    }

    // Genesis check: reject peers on wrong network
    const ourGenesis = this.node.chain.blocks[0].hash
    if (payload.genesisHash !== ourGenesis) {
      peer.disconnect('genesis hash mismatch')
      return
    }

    peer.remoteHeight = payload.height
    peer.remoteGenesisHash = payload.genesisHash

    // If inbound, send our version back
    if (peer.inbound) {
      this.sendVersion(peer)
    }

    peer.send({ type: 'verack' })
  }

  private handleVerack(peer: Peer): void {
    peer.completeHandshake()
    console.log(`P2P: Handshake complete with ${peer.id} (height=${peer.remoteHeight})`)

    // IBD: if peer is ahead, request blocks
    const ourHeight = this.node.chain.getHeight()
    if (peer.remoteHeight > ourHeight) {
      peer.send({
        type: 'getblocks',
        payload: { fromHeight: ourHeight + 1 } as GetBlocksPayload,
      })
    } else {
      // Already caught up with this peer
      this.notifySynced()
    }
  }

  private handleGetBlocks(peer: Peer, payload: GetBlocksPayload): void {
    if (!peer.handshakeComplete) {
      peer.addMisbehavior(10)
      return
    }
    if (!payload || typeof payload.fromHeight !== 'number') {
      peer.addMisbehavior(10)
      return
    }

    const from = Math.max(1, payload.fromHeight) // never send genesis
    const to = Math.min(from + IBD_BATCH_SIZE, this.node.chain.blocks.length)
    const blocks = this.node.chain.blocks.slice(from, to)

    peer.send({
      type: 'blocks',
      payload: { blocks: blocks.map((b) => sanitizeForStorage(b)) } as BlocksPayload,
    })
  }

  private handleBlocks(peer: Peer, payload: BlocksPayload): void {
    if (!peer.handshakeComplete) {
      peer.addMisbehavior(10)
      return
    }
    if (!payload || !Array.isArray(payload.blocks)) {
      peer.addMisbehavior(10)
      return
    }

    let added = 0
    for (const raw of payload.blocks) {
      const block = deserializeBlock(raw as Record<string, unknown>)
      if (this.seenBlocks.has(block.hash)) continue

      const result = this.node.receiveBlock(block)
      if (result.success) {
        this.addSeen(this.seenBlocks, block.hash)
        added++
      } else {
        peer.addMisbehavior(5)
      }
    }

    // Request more if we got a full batch and peer is still ahead
    if (added > 0 && payload.blocks.length === IBD_BATCH_SIZE) {
      peer.send({
        type: 'getblocks',
        payload: { fromHeight: this.node.chain.getHeight() + 1 } as GetBlocksPayload,
      })
    } else if (added > 0) {
      // Got a partial batch — IBD complete
      console.log(`P2P: Sync complete at height ${this.node.chain.getHeight()}`)
      this.notifySynced()
    }
  }

  private handleTx(peer: Peer, payload: TxPayload): void {
    if (!peer.handshakeComplete) {
      peer.addMisbehavior(10)
      return
    }
    if (!payload || !payload.tx) {
      peer.addMisbehavior(10)
      return
    }

    const tx = deserializeTransaction(payload.tx as Record<string, unknown>)
    if (this.seenTxs.has(tx.id)) return

    const result = this.node.receiveTransaction(tx)
    if (result.success) {
      this.addSeen(this.seenTxs, tx.id)
      // Re-broadcast to other peers
      this.broadcastExcept(peer.id, {
        type: 'inv',
        payload: { type: 'tx', hash: tx.id } as InvPayload,
      })
    } else {
      peer.addMisbehavior(2)
    }
  }

  private handleInv(peer: Peer, payload: InvPayload): void {
    if (!peer.handshakeComplete) {
      peer.addMisbehavior(10)
      return
    }
    if (!payload || !payload.type || !payload.hash) {
      peer.addMisbehavior(10)
      return
    }

    if (payload.type === 'block' && !this.seenBlocks.has(payload.hash)) {
      peer.send({
        type: 'getdata',
        payload: { type: 'block', hash: payload.hash } as GetDataPayload,
      })
    } else if (payload.type === 'tx' && !this.seenTxs.has(payload.hash)) {
      peer.send({
        type: 'getdata',
        payload: { type: 'tx', hash: payload.hash } as GetDataPayload,
      })
    }
  }

  private handleGetData(peer: Peer, payload: GetDataPayload): void {
    if (!peer.handshakeComplete) {
      peer.addMisbehavior(10)
      return
    }
    if (!payload || !payload.type || !payload.hash) {
      peer.addMisbehavior(10)
      return
    }

    if (payload.type === 'block') {
      const block = this.node.chain.blocks.find((b) => b.hash === payload.hash)
      if (block) {
        peer.send({
          type: 'blocks',
          payload: { blocks: [sanitizeForStorage(block)] } as BlocksPayload,
        })
      }
    } else if (payload.type === 'tx') {
      const tx = this.node.mempool.getTransaction(payload.hash)
      if (tx) {
        peer.send({
          type: 'tx',
          payload: { tx: sanitizeForStorage(tx) } as TxPayload,
        })
      }
    }
  }

  private broadcastBlock(block: Block): void {
    this.addSeen(this.seenBlocks, block.hash)
    const msg: Message = {
      type: 'inv',
      payload: { type: 'block', hash: block.hash } as InvPayload,
    }
    for (const peer of this.peers.values()) {
      if (peer.handshakeComplete) {
        peer.send(msg)
      }
    }
  }

  private broadcastTx(tx: Transaction): void {
    this.addSeen(this.seenTxs, tx.id)
    const msg: Message = {
      type: 'inv',
      payload: { type: 'tx', hash: tx.id } as InvPayload,
    }
    for (const peer of this.peers.values()) {
      if (peer.handshakeComplete) {
        peer.send(msg)
      }
    }
  }

  private broadcastExcept(excludeId: string, msg: Message): void {
    for (const peer of this.peers.values()) {
      if (peer.id !== excludeId && peer.handshakeComplete) {
        peer.send(msg)
      }
    }
  }

  private addSeen(cache: Set<string>, hash: string): void {
    cache.add(hash)
    if (cache.size > SEEN_CACHE_MAX) {
      const first = cache.values().next().value
      if (first) cache.delete(first)
    }
  }

  private isBanned(ip: string): boolean {
    const expiry = this.banList.get(ip)
    if (expiry === undefined) return false
    if (Date.now() > expiry) {
      this.banList.delete(ip)
      return false
    }
    return true
  }

  private ban(ip: string): void {
    console.log(`P2P: Banning ${ip} for 24h`)
    this.banList.set(ip, Date.now() + BAN_DURATION_MS)
    this.saveBanList()
  }

  private loadBanList(): void {
    if (!this.banListPath) return
    try {
      if (fs.existsSync(this.banListPath)) {
        const raw = JSON.parse(fs.readFileSync(this.banListPath, 'utf-8'))
        const now = Date.now()
        for (const [ip, expiry] of Object.entries(raw)) {
          if (typeof expiry === 'number' && expiry > now) {
            this.banList.set(ip, expiry)
          }
        }
      }
    } catch {
      // Ignore corrupt ban list
    }
  }

  private saveBanList(): void {
    if (!this.banListPath) return
    const obj: Record<string, number> = {}
    for (const [ip, expiry] of this.banList) {
      obj[ip] = expiry
    }
    fs.writeFileSync(this.banListPath, JSON.stringify(obj, null, 2) + '\n')
  }
}
