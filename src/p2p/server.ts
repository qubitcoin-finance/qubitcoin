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
  type RejectPayload,
  type GetBlocksPayload,
  type BlocksPayload,
  type TxPayload,
  type InvPayload,
  type GetDataPayload,
  type GetHeadersPayload,
  type HeadersPayload,
  type AddrPayload,
  PROTOCOL_VERSION,
  encodeMessage,
} from './protocol.js'
import type { Node } from '../node.js'
import { sanitizeForStorage } from '../storage.js'
import { hexToBytes, bytesToHex } from '../crypto.js'
import type { Block } from '../block.js'
import type { Transaction, TransactionInput, ClaimData } from '../transaction.js'
import { log } from '../log.js'

const MAX_INBOUND = 25
const MAX_OUTBOUND = 25
const IBD_BATCH_SIZE = 50
const SEEN_CACHE_MAX = 10_000
const BAN_DURATION_MS = 24 * 60 * 60 * 1000 // 24h
const MAX_REORG_DEPTH = 100
const MAX_HEADERS_RESPONSE = 500
const SEED_RECONNECT_BASE_MS = 5_000
const SEED_RECONNECT_MAX_MS = 60_000
const MAX_ADDR_BOOK = 1_000
const MAX_ADDR_RESPONSE = 100
const DISCOVERY_INTERVAL_MS = 60_000

/** Check if an IP address is publicly routable (not private/loopback/link-local) */
function isRoutableAddress(host: string): boolean {
  // IPv6 loopback and private
  if (host === '::1' || host === '::') return false
  if (host.startsWith('fc') || host.startsWith('fd')) return false // fc00::/7 (ULA)
  if (host.startsWith('fe80')) return false // link-local

  // IPv4 (may be plain or IPv6-mapped like ::ffff:127.0.0.1)
  const ipv4Match = host.match(/(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/i)
  if (ipv4Match) {
    const parts = ipv4Match[1].split('.').map(Number)
    const [a, b] = parts
    if (a === 127) return false                          // 127.0.0.0/8
    if (a === 10) return false                           // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return false    // 172.16.0.0/12
    if (a === 192 && b === 168) return false              // 192.168.0.0/16
    if (a === 169 && b === 254) return false              // 169.254.0.0/16
    if (a === 0) return false                             // 0.0.0.0/8
  }

  return true
}
const FORK_RESOLUTION_TIMEOUT_MS = 60_000
const MAX_ORPHAN_BLOCKS = 50
const ORPHAN_EXPIRY_MS = 10 * 60_000

interface OrphanBlock {
  block: Block
  receivedAt: number
}

/** Known Uint8Array fields that need deserialization from P2P messages */
const TX_INPUT_BINARY_FIELDS = ['publicKey', 'signature'] as const
const CLAIM_DATA_BINARY_FIELDS = ['ecdsaPublicKey', 'ecdsaSignature', 'schnorrPublicKey', 'schnorrSignature'] as const

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
  private discoveryTimer: ReturnType<typeof setInterval> | null = null
  private forkResolutionInProgress = false
  private forkResolutionTimer: ReturnType<typeof setTimeout> | null = null
  private knownAddresses: Map<string, { host: string; port: number; lastSeen: number }> = new Map()
  private seedBackoff: Map<string, number> = new Map() // seed key -> current delay ms
  private orphanBlocks: Map<string, OrphanBlock> = new Map() // parentHash -> orphan

  private localMode = false

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
        log.info({ component: 'p2p', port: this.port }, 'P2P server listening')
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer)
      this.discoveryTimer = null
    }
    this.clearForkResolution()
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

    // Start peer discovery
    this.startDiscovery()

    // Reconnect to disconnected seeds every 30s
    if (!this.reconnectTimer && this.seeds.length > 0) {
      this.reconnectTimer = setInterval(() => {
        for (const seed of this.seeds) {
          if (!this.isConnectedToSeed(seed.host, seed.port)) {
            log.debug({ component: 'p2p', seed: `${seed.host}:${seed.port}` }, 'Reconnecting to seed')
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

    const label = `${host}:${port}`
    const socket = net.createConnection({ host, port }, () => {
      const peer = this.createPeer(socket, false, label)
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

  getPeers(): Array<{ address: string; inbound: boolean; height: number }> {
    const cleanAddr = (addr: string) => addr.replace(/^::ffff:/, '')
    return Array.from(this.peers.values())
      .filter((p) => p.handshakeComplete)
      .map((p) => ({
        address: cleanAddr(p.address),
        inbound: p.inbound,
        height: p.remoteHeight,
      }))
  }

  private handleInbound(socket: net.Socket): void {
    const addr = socket.remoteAddress ?? ''
    if (this.isBanned(addr)) {
      log.info({ component: 'p2p', ip: addr }, 'Rejected banned peer')
      const frame = encodeMessage({ type: 'reject', payload: { reason: 'banned' } as RejectPayload })
      socket.end(frame)
      return
    }
    if (this.inboundCount >= MAX_INBOUND) {
      socket.destroy()
      return
    }
    this.createPeer(socket, true)
  }

  private createPeer(socket: net.Socket, inbound: boolean, label?: string): Peer | null {
    const peer = new Peer(
      socket,
      inbound,
      (p, msg) => this.handleMessage(p, msg),
      (p, reason) => this.handleDisconnect(p, reason),
      label,
    )

    this.peers.set(peer.id, peer)
    if (inbound) this.inboundCount++
    else this.outboundCount++

    return peer
  }

  private handleDisconnect(peer: Peer, reason: string): void {
    log.info({ component: 'p2p', peer: peer.id, reason }, 'Peer disconnected')

    // Ban if misbehavior was the cause
    if (peer.getMisbehaviorScore() >= 100) {
      this.ban(peer.address)
    }

    // Clear fork resolution flag if this peer was involved
    if (this.forkResolutionInProgress) {
      this.clearForkResolution()
    }

    this.peers.delete(peer.id)
    if (peer.inbound) this.inboundCount--
    else this.outboundCount--

    // Schedule reconnect with exponential backoff if it was a seed
    if (!peer.inbound) {
      for (const seed of this.seeds) {
        if (peer.id === `${seed.host}:${seed.port}` || peer.address.includes(seed.host)) {
          const seedKey = `${seed.host}:${seed.port}`
          const currentDelay = this.seedBackoff.get(seedKey) ?? SEED_RECONNECT_BASE_MS
          const nextDelay = Math.min(currentDelay * 2, SEED_RECONNECT_MAX_MS)
          this.seedBackoff.set(seedKey, nextDelay)
          log.debug({ component: 'p2p', seed: seedKey, delayMs: currentDelay }, 'Scheduling seed reconnect')
          setTimeout(() => {
            if (!this.isConnectedToSeed(seed.host, seed.port)) {
              this.connectOutbound(seed.host, seed.port)
            }
          }, currentDelay)
          break
        }
      }
    }
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
        case 'reject':
          this.handleReject(peer, msg.payload as RejectPayload)
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
        case 'getheaders':
          this.handleGetHeaders(peer, msg.payload as GetHeadersPayload)
          break
        case 'headers':
          this.handleHeaders(peer, msg.payload as HeadersPayload)
          break
        case 'addr':
          this.handleAddr(peer, msg.payload as AddrPayload)
          break
        case 'getaddr':
          this.handleGetAddr(peer)
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
    } catch (err) {
      log.warn({ component: 'p2p', peer: peer.id, msgType: msg.type, error: err instanceof Error ? err.message : String(err) }, 'Error handling message')
      peer.addMisbehavior(10)
    }
  }

  private sendVersion(peer: Peer): void {
    const payload: VersionPayload = {
      version: PROTOCOL_VERSION,
      height: this.node.chain.getHeight(),
      genesisHash: this.node.chain.blocks[0].hash,
      userAgent: `qubitcoin/${PROTOCOL_VERSION}`,
      listenPort: this.port,
      cumulativeWork: this.node.chain.cumulativeWork.toString(16),
    }
    peer.send({ type: 'version', payload })
  }

  private handleVersion(peer: Peer, payload: VersionPayload): void {
    if (!payload || typeof payload.height !== 'number' || typeof payload.genesisHash !== 'string') {
      peer.addMisbehavior(25)
      return
    }

    // Genesis check: reject peers on wrong network
    // Exception: fresh peers (height 0) without snapshot are allowed — they'll adopt our genesis during IBD
    const ourGenesis = this.node.chain.blocks[0].hash
    const weAreFresh = this.node.chain.getHeight() === 0 && !this.node.chain.btcSnapshot
    const peerIsFresh = payload.height === 0 && !this.node.chain.btcSnapshot
    if (payload.genesisHash !== ourGenesis && !weAreFresh && !peerIsFresh) {
      peer.send({
        type: 'reject',
        payload: {
          reason: `genesis hash mismatch: expected ${ourGenesis.slice(0, 16)}…, got ${payload.genesisHash.slice(0, 16)}…`,
        } as RejectPayload,
      })
      peer.disconnect('genesis hash mismatch')
      return
    }

    peer.remoteHeight = payload.height
    peer.remoteGenesisHash = payload.genesisHash
    if (payload.listenPort) {
      peer.remoteListenPort = payload.listenPort
    }
    if (payload.cumulativeWork) {
      try { peer.remoteCumulativeWork = BigInt('0x' + payload.cumulativeWork) } catch { /* ignore */ }
    }

    // If inbound, send our version back
    if (peer.inbound) {
      this.sendVersion(peer)
    }

    peer.send({ type: 'verack' })
  }

  private handleReject(peer: Peer, payload: RejectPayload): void {
    const reason = payload?.reason ?? 'unknown'
    log.warn({ component: 'p2p', peer: peer.id, reason }, 'Peer rejected us')
  }

  private handleVerack(peer: Peer): void {
    peer.completeHandshake()
    log.debug({ component: 'p2p', peer: peer.id, remoteHeight: peer.remoteHeight }, 'Handshake complete')

    // Add peer to address book
    if (peer.remoteListenPort && peer.address !== 'unknown') {
      this.addKnownAddress(peer.address, peer.remoteListenPort)
    }

    // Reset backoff on successful handshake (outbound seeds)
    if (!peer.inbound) {
      for (const seed of this.seeds) {
        if (peer.id === `${seed.host}:${seed.port}` || peer.address.includes(seed.host)) {
          this.seedBackoff.delete(`${seed.host}:${seed.port}`)
          break
        }
      }
    }

    // IBD: if peer is ahead, request blocks
    const ourHeight = this.node.chain.getHeight()
    const needsGenesis = ourHeight === 0 && peer.remoteGenesisHash !== this.node.chain.blocks[0].hash
    if (peer.remoteHeight > ourHeight || needsGenesis) {
      this.sendGetBlocks(peer, needsGenesis ? 0 : ourHeight + 1)
    } else {
      // Already caught up with this peer
      this.notifySynced()
    }

    // Request peer addresses for discovery
    peer.send({ type: 'getaddr' })
  }

  /** Send getblocks with IBD timeout */
  private sendGetBlocks(peer: Peer, fromHeight: number): void {
    peer.send({
      type: 'getblocks',
      payload: { fromHeight } as GetBlocksPayload,
    })
    peer.startIBDTimer(() => {
      log.warn({ component: 'p2p', peer: peer.id }, 'IBD timeout — disconnecting')
      peer.disconnect('IBD timeout')
      // Try another connected peer with higher height
      this.tryIBDWithAnotherPeer()
    })
  }

  /** Find another connected peer with a higher chain and request blocks */
  private tryIBDWithAnotherPeer(): void {
    const ourHeight = this.node.chain.getHeight()
    let bestPeer: Peer | null = null
    let bestHeight = ourHeight
    for (const peer of this.peers.values()) {
      if (peer.handshakeComplete && !peer.ibdPending && peer.remoteHeight > bestHeight) {
        bestPeer = peer
        bestHeight = peer.remoteHeight
      }
    }
    if (bestPeer) {
      log.info({ component: 'p2p', peer: bestPeer.id, height: bestHeight }, 'Trying IBD with another peer')
      this.sendGetBlocks(bestPeer, ourHeight + 1)
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

    const from = Math.max(0, payload.fromHeight) // include genesis if requested
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

    // Clear IBD timeout — we got a response
    peer.clearIBDTimer()

    let added = 0
    let forkDetected = false
    for (const raw of payload.blocks) {
      const block = deserializeBlock(raw as Record<string, unknown>)
      if (this.seenBlocks.has(block.hash)) continue

      // Genesis adoption: fresh node (no snapshot) receives peer's genesis block
      if (block.height === 0 && block.hash !== this.node.chain.blocks[0].hash) {
        if (this.node.chain.replaceGenesis(block)) {
          log.info({ component: 'p2p', peer: peer.id, genesis: block.hash.slice(0, 16) }, 'Adopted peer genesis')
          this.addSeen(this.seenBlocks, block.hash)
          added++
          continue
        } else {
          log.warn({ component: 'p2p', peer: peer.id, theirGenesis: block.hash.slice(0, 16), ourGenesis: this.node.chain.blocks[0].hash.slice(0, 16) }, 'Rejected genesis replacement')
        }
      }

      const result = this.node.receiveBlock(block)
      if (result.success) {
        this.addSeen(this.seenBlocks, block.hash)
        added++
        // Try to connect any orphans that were waiting for this block
        added += this.processOrphans(block.hash)
      } else if (result.error?.includes('Previous hash') && !this.forkResolutionInProgress) {
        // During IBD (batch of blocks), "Previous hash" mismatch means fork
        // For single blocks (relay/getdata), check if it's an orphan (parent unknown)
        if (payload.blocks.length === 1) {
          const parentInChain = this.node.chain.blocks.some(b => b.hash === block.header.previousHash)
          if (!parentInChain) {
            // Orphan: parent not in our chain yet — cache it
            this.addOrphan(block)
            continue
          }
        }
        // Fork detected — peer has a different chain at this height
        log.warn({ component: 'p2p', peer: peer.id, height: block.height, error: result.error }, 'Fork detected — initiating resolution')
        forkDetected = true
        break
      } else {
        log.warn({ component: 'p2p', peer: peer.id, height: block.height, hash: block.hash?.slice(0, 16), error: result.error }, 'Rejected block from peer')
        peer.send({ type: 'reject', payload: { reason: `block ${block.height} rejected: ${result.error}` } as RejectPayload })
      }
    }

    if (forkDetected) {
      this.initiateForkResolution(peer)
      return
    }

    if (added > 0) {
      log.info({ component: 'p2p', peer: peer.id, added, height: this.node.chain.getHeight(), peerHeight: peer.remoteHeight }, 'Syncing blocks')
    }

    // Request more if we got a full batch and peer is still ahead
    if (added > 0 && payload.blocks.length === IBD_BATCH_SIZE) {
      this.sendGetBlocks(peer, this.node.chain.getHeight() + 1)
    } else if (added > 0) {
      // Got a partial batch — IBD complete
      log.info({ component: 'p2p', height: this.node.chain.getHeight() }, 'Sync complete')
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
      log.warn({ component: 'p2p', peer: peer.id, txid: tx.id?.slice(0, 16), error: result.error }, 'Rejected tx from peer')
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

  /** Build block locator: tip, tip-1, tip-2, tip-4, tip-8, ..., genesis */
  private buildBlockLocator(): string[] {
    const chain = this.node.chain
    const height = chain.getHeight()
    const locator: string[] = []
    let step = 1
    let h = height

    while (h > 0) {
      locator.push(chain.blocks[h].hash)
      if (locator.length >= 2) step *= 2
      h -= step
    }

    // Always include genesis
    locator.push(chain.blocks[0].hash)
    return locator
  }

  /** Initiate fork resolution by sending getheaders with a block locator */
  private initiateForkResolution(peer: Peer): void {
    if (this.forkResolutionInProgress) return
    this.forkResolutionInProgress = true

    // Auto-clear after timeout to prevent permanent deadlock
    this.forkResolutionTimer = setTimeout(() => {
      if (this.forkResolutionInProgress) {
        log.warn({ component: 'p2p' }, 'Fork resolution timeout — clearing flag')
        this.clearForkResolution()
      }
    }, FORK_RESOLUTION_TIMEOUT_MS)

    try {
      const locator = this.buildBlockLocator()
      log.info({ component: 'p2p', peer: peer.id, locatorLen: locator.length }, 'Sending getheaders for fork resolution')
      peer.send({
        type: 'getheaders',
        payload: { locatorHashes: locator } as GetHeadersPayload,
      })
    } catch (err) {
      log.warn({ component: 'p2p', peer: peer.id, error: err instanceof Error ? err.message : String(err) }, 'Fork resolution failed')
      this.clearForkResolution()
    }
  }

  private clearForkResolution(): void {
    this.forkResolutionInProgress = false
    if (this.forkResolutionTimer) {
      clearTimeout(this.forkResolutionTimer)
      this.forkResolutionTimer = null
    }
  }

  /** Handle getheaders: find common ancestor from locator, respond with headers */
  private handleGetHeaders(peer: Peer, payload: GetHeadersPayload): void {
    if (!peer.handshakeComplete) {
      peer.addMisbehavior(10)
      return
    }
    if (!payload || !Array.isArray(payload.locatorHashes)) {
      peer.addMisbehavior(10)
      return
    }

    const chain = this.node.chain

    // Find the first locator hash that matches a block in our chain
    let forkPoint = 0 // default to genesis
    for (const hash of payload.locatorHashes) {
      const block = chain.blocks.find((b) => b.hash === hash)
      if (block) {
        forkPoint = block.height
        break
      }
    }

    // Send headers from forkPoint+1 to our tip (capped)
    const from = forkPoint + 1
    const to = Math.min(from + MAX_HEADERS_RESPONSE, chain.blocks.length)
    const headers = chain.blocks.slice(from, to).map((b) => ({
      hash: b.hash,
      height: b.height,
      previousHash: b.header.previousHash,
    }))

    peer.send({
      type: 'headers',
      payload: { headers } as HeadersPayload,
    })
  }

  /** Handle headers response: determine if peer chain is longer, reorg if so */
  private handleHeaders(peer: Peer, payload: HeadersPayload): void {
    if (!peer.handshakeComplete) {
      peer.addMisbehavior(10)
      return
    }
    if (!payload || !Array.isArray(payload.headers)) {
      peer.addMisbehavior(10)
      this.clearForkResolution()
      return
    }

    if (payload.headers.length === 0) {
      log.info({ component: 'p2p', peer: peer.id }, 'No headers from peer — no reorg needed')
      this.clearForkResolution()
      return
    }

    const chain = this.node.chain
    const firstHeader = payload.headers[0]
    const lastHeader = payload.headers[payload.headers.length - 1]

    // Find the fork point: the block whose hash matches firstHeader.previousHash
    let forkPoint = -1
    for (let i = chain.blocks.length - 1; i >= 0; i--) {
      if (chain.blocks[i].hash === firstHeader.previousHash) {
        forkPoint = i
        break
      }
    }

    if (forkPoint === -1) {
      log.warn({ component: 'p2p', peer: peer.id }, 'Cannot find fork point from headers — no common ancestor')
      peer.addMisbehavior(10)
      this.clearForkResolution()
      return
    }

    // Check reorg depth
    const reorgDepth = chain.getHeight() - forkPoint
    if (reorgDepth > MAX_REORG_DEPTH) {
      log.warn({ component: 'p2p', peer: peer.id, depth: reorgDepth, max: MAX_REORG_DEPTH }, 'Reorg too deep — refusing')
      this.clearForkResolution()
      return
    }

    // Decide whether to reorg: prefer cumulative work, fall back to height
    const peerHeight = forkPoint + payload.headers.length
    const effectivePeerHeight = Math.max(peerHeight, peer.remoteHeight)

    if (peer.remoteCumulativeWork > 0n) {
      // Use cumulative work comparison (more accurate)
      if (peer.remoteCumulativeWork <= chain.cumulativeWork) {
        log.info({ component: 'p2p', peer: peer.id, ourWork: chain.cumulativeWork.toString(16).slice(0, 16), peerWork: peer.remoteCumulativeWork.toString(16).slice(0, 16) }, 'Peer chain has less work — no reorg')
        this.clearForkResolution()
        return
      }
    } else {
      // Legacy: fall back to height comparison
      if (effectivePeerHeight <= chain.getHeight()) {
        log.info({ component: 'p2p', peer: peer.id, ourHeight: chain.getHeight(), peerHeight: effectivePeerHeight }, 'Peer chain not longer — no reorg')
        this.clearForkResolution()
        return
      }
    }

    // Perform reorg
    log.warn({ component: 'p2p', peer: peer.id, forkPoint, ourHeight: chain.getHeight(), peerHeight: effectivePeerHeight, peerWork: peer.remoteCumulativeWork.toString(16).slice(0, 16) }, 'Reorging to chain with more work')
    this.node.resetToHeight(forkPoint)

    // Clear seen blocks cache since we've rewound
    this.seenBlocks.clear()
    // Re-add blocks we still have
    for (const b of chain.blocks) {
      this.addSeen(this.seenBlocks, b.hash)
    }

    this.clearForkResolution()

    // Request blocks from the fork point
    this.sendGetBlocks(peer, forkPoint + 1)
  }

  /** Check if we have an active connection to a specific seed */
  private isConnectedToSeed(host: string, port: number): boolean {
    const label = `${host}:${port}`
    for (const peer of this.peers.values()) {
      if (!peer.inbound && (peer.id === label || peer.address.includes(host))) {
        return true
      }
    }
    return false
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
    log.warn({ component: 'p2p', ip }, 'Banning peer for 24h')
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

  private handleGetAddr(peer: Peer): void {
    if (!peer.handshakeComplete) {
      peer.addMisbehavior(10)
      return
    }

    // Rate limit: max 1 getaddr response per peer per 60 seconds
    const now = Date.now()
    if (now - peer.lastGetaddrResponse < 60_000) {
      return // silently ignore
    }
    peer.lastGetaddrResponse = now

    // Respond with up to MAX_ADDR_RESPONSE random known addresses
    const all = Array.from(this.knownAddresses.values())
    // Shuffle and take up to limit
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[all[i], all[j]] = [all[j], all[i]]
    }
    const addresses = all.slice(0, MAX_ADDR_RESPONSE)
    peer.send({ type: 'addr', payload: { addresses } as AddrPayload })
  }

  private handleAddr(peer: Peer, payload: AddrPayload): void {
    if (!peer.handshakeComplete) {
      peer.addMisbehavior(10)
      return
    }
    if (!payload || !Array.isArray(payload.addresses)) {
      peer.addMisbehavior(10)
      return
    }

    for (const entry of payload.addresses) {
      if (!entry.host || typeof entry.port !== 'number' || entry.port <= 0 || entry.port > 65535) continue
      this.addKnownAddress(entry.host, entry.port, entry.lastSeen)
    }
  }

  private addKnownAddress(host: string, port: number, lastSeen?: number): void {
    // Filter private IPs unless in local mode
    if (!this.localMode && !isRoutableAddress(host)) return

    const key = `${host}:${port}`
    const existing = this.knownAddresses.get(key)
    const now = lastSeen ?? Date.now()
    if (existing && existing.lastSeen >= now) return
    this.knownAddresses.set(key, { host, port, lastSeen: now })

    // Cap address book size — evict oldest
    if (this.knownAddresses.size > MAX_ADDR_BOOK) {
      let oldestKey = ''
      let oldestTime = Infinity
      for (const [k, v] of this.knownAddresses) {
        if (v.lastSeen < oldestTime) {
          oldestTime = v.lastSeen
          oldestKey = k
        }
      }
      if (oldestKey) this.knownAddresses.delete(oldestKey)
    }
  }

  /** Start periodic peer discovery — connect to random known addresses */
  startDiscovery(): void {
    if (this.discoveryTimer) return
    this.discoveryTimer = setInterval(() => {
      if (this.outboundCount >= MAX_OUTBOUND) return

      // Pick a random known address we're not already connected to
      const candidates = Array.from(this.knownAddresses.values()).filter(
        (a) => !this.isConnectedToSeed(a.host, a.port) && !this.isBanned(a.host)
      )
      if (candidates.length === 0) return

      const pick = candidates[Math.floor(Math.random() * candidates.length)]
      log.debug({ component: 'p2p', addr: `${pick.host}:${pick.port}` }, 'Discovering peer')
      this.connectOutbound(pick.host, pick.port)
    }, DISCOVERY_INTERVAL_MS)
  }

  /** Enable local mode — allows private IPs in address book */
  setLocalMode(enabled: boolean): void {
    this.localMode = enabled
  }

  /** Get the known address book (for testing) */
  getKnownAddresses(): Map<string, { host: string; port: number; lastSeen: number }> {
    return this.knownAddresses
  }

  /** Add a block to the orphan pool */
  private addOrphan(block: Block): void {
    // Expire old orphans first
    this.expireOrphans()

    if (this.orphanBlocks.size >= MAX_ORPHAN_BLOCKS) {
      // Evict oldest orphan
      let oldestKey = ''
      let oldestTime = Infinity
      for (const [key, orphan] of this.orphanBlocks) {
        if (orphan.receivedAt < oldestTime) {
          oldestTime = orphan.receivedAt
          oldestKey = key
        }
      }
      if (oldestKey) this.orphanBlocks.delete(oldestKey)
    }

    const parentHash = block.header.previousHash
    if (!this.orphanBlocks.has(parentHash)) {
      this.orphanBlocks.set(parentHash, { block, receivedAt: Date.now() })
      log.debug({ component: 'p2p', hash: block.hash.slice(0, 16), parent: parentHash.slice(0, 16) }, 'Cached orphan block')
    }
  }

  /** Try to connect orphan blocks after a new block was accepted */
  private processOrphans(parentHash: string): number {
    let added = 0
    let currentHash = parentHash

    while (this.orphanBlocks.has(currentHash)) {
      const orphan = this.orphanBlocks.get(currentHash)!
      this.orphanBlocks.delete(currentHash)

      const result = this.node.receiveBlock(orphan.block)
      if (result.success) {
        this.addSeen(this.seenBlocks, orphan.block.hash)
        added++
        currentHash = orphan.block.hash
      } else {
        break
      }
    }

    if (added > 0) {
      log.info({ component: 'p2p', connected: added }, 'Connected orphan blocks')
    }
    return added
  }

  /** Remove expired orphan blocks */
  private expireOrphans(): void {
    const cutoff = Date.now() - ORPHAN_EXPIRY_MS
    for (const [key, orphan] of this.orphanBlocks) {
      if (orphan.receivedAt < cutoff) {
        this.orphanBlocks.delete(key)
      }
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
