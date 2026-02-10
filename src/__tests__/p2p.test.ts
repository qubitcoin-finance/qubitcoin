import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Node } from '../node.js'
import { P2PServer } from '../p2p/server.js'
import { FileBlockStorage } from '../storage.js'
import { generateWallet } from '../crypto.js'
import {
  encodeMessage,
  decodeMessages,
  type Message,
  MAX_MESSAGE_SIZE,
} from '../p2p/protocol.js'

/** Wait for a condition to become true, polling every `interval` ms */
function waitFor(
  fn: () => boolean,
  timeout = 10_000,
  interval = 100,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      if (fn()) return resolve()
      if (Date.now() - start > timeout) return reject(new Error('waitFor timeout'))
      setTimeout(check, interval)
    }
    check()
  })
}

describe('protocol encoding', () => {
  it('should encode and decode a message', () => {
    const msg: Message = { type: 'ping' }
    const buf = encodeMessage(msg)

    const { messages, remainder } = decodeMessages(buf)
    expect(messages).toHaveLength(1)
    expect(messages[0].type).toBe('ping')
    expect(remainder.length).toBe(0)
  })

  it('should handle partial data (incomplete frame)', () => {
    const msg: Message = { type: 'version', payload: { version: 1, height: 10, genesisHash: 'a'.repeat(64), userAgent: 'test' } }
    const buf = encodeMessage(msg)
    const partial = buf.subarray(0, buf.length - 5)

    const { messages, remainder } = decodeMessages(partial)
    expect(messages).toHaveLength(0)
    expect(remainder.length).toBe(partial.length)
  })

  it('should decode multiple concatenated messages', () => {
    const msg1 = encodeMessage({ type: 'ping' })
    const msg2 = encodeMessage({ type: 'pong' })
    const combined = Buffer.concat([msg1, msg2])

    const { messages, remainder } = decodeMessages(combined)
    expect(messages).toHaveLength(2)
    expect(messages[0].type).toBe('ping')
    expect(messages[1].type).toBe('pong')
    expect(remainder.length).toBe(0)
  })

  it('should reject oversized messages', () => {
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(MAX_MESSAGE_SIZE + 1, 0)

    expect(() => decodeMessages(buf)).toThrow('exceeds max')
  })
})

describe('P2P server integration', () => {
  let tmpDir1: string
  let tmpDir2: string
  let node1: Node
  let node2: Node
  let p2p1: P2PServer
  let p2p2: P2PServer

  const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

  beforeEach(async () => {
    tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'qtc-p2p-1-'))
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qtc-p2p-2-'))

    const storage1 = new FileBlockStorage(tmpDir1)
    const storage2 = new FileBlockStorage(tmpDir2)

    node1 = new Node('alice', undefined, storage1)
    node2 = new Node('bob', undefined, storage2)

    p2p1 = new P2PServer(node1, 0, tmpDir1) // port 0 = random
    p2p2 = new P2PServer(node2, 0, tmpDir2)

    await p2p1.start()
    await p2p2.start()
  })

  afterEach(async () => {
    await p2p1.stop()
    await p2p2.stop()
    fs.rmSync(tmpDir1, { recursive: true, force: true })
    fs.rmSync(tmpDir2, { recursive: true, force: true })
  })

  it('should complete handshake between two nodes', async () => {
    // Get the actual port p2p1 is listening on
    const addr = (p2p1 as any).server.address()
    const port = typeof addr === 'object' ? addr.port : 0

    p2p2.connectOutbound('127.0.0.1', port)

    await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

    expect(p2p1.getPeers().length).toBeGreaterThanOrEqual(1)
    expect(p2p2.getPeers().length).toBeGreaterThanOrEqual(1)
  })

  it('should sync blocks via IBD', async () => {
    const wallet = generateWallet()

    // Mine blocks on node1
    node1.chain.difficulty = TEST_TARGET
    for (let i = 0; i < 3; i++) {
      node1.mine(wallet.address, false)
    }
    expect(node1.chain.getHeight()).toBe(3)

    // Connect node2 to node1
    const addr = (p2p1 as any).server.address()
    const port = typeof addr === 'object' ? addr.port : 0
    p2p2.connectOutbound('127.0.0.1', port)

    // Wait for node2 to sync
    await waitFor(() => node2.chain.getHeight() >= 3, 15_000)
    expect(node2.chain.getHeight()).toBe(3)
  })

  it('should propagate new blocks between connected peers', async () => {
    const wallet = generateWallet()

    // Connect first
    const addr = (p2p1 as any).server.address()
    const port = typeof addr === 'object' ? addr.port : 0
    p2p2.connectOutbound('127.0.0.1', port)

    await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

    // Mine on node1 — should propagate to node2
    node1.chain.difficulty = TEST_TARGET
    node1.mine(wallet.address, false)

    await waitFor(() => node2.chain.getHeight() >= 1, 10_000)
    expect(node2.chain.getHeight()).toBe(1)
    expect(node2.chain.blocks[1].hash).toBe(node1.chain.blocks[1].hash)
  })

  it('should relay transactions between peers', async () => {
    const wallet = generateWallet()

    // Mine a block on node1 to create a coinbase UTXO
    node1.chain.difficulty = TEST_TARGET
    node1.mine(wallet.address, false)

    // Connect
    const addr = (p2p1 as any).server.address()
    const port = typeof addr === 'object' ? addr.port : 0
    p2p2.connectOutbound('127.0.0.1', port)

    // Wait for sync
    await waitFor(() => node2.chain.getHeight() >= 1, 10_000)

    // Create a transaction on node1
    const { createTransaction } = await import('../transaction.js')
    const wallet2 = generateWallet()
    const utxos = node1.chain.findUTXOs(wallet.address, 1)
    const tx = createTransaction(wallet, utxos, [{ address: wallet2.address, amount: 1 }], 0.125)

    node1.receiveTransaction(tx)

    // Wait for it to appear in node2's mempool
    await waitFor(() => node2.mempool.size() > 0, 10_000)
    expect(node2.mempool.getTransaction(tx.id)).toBeDefined()
  })
})
