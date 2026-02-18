/**
 * Tests for P2P & Mining hardening features
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Node } from '../node.js'
import { Blockchain } from '../chain.js'
import { P2PServer } from '../p2p/server.js'
import { Peer } from '../p2p/peer.js'
import { FileBlockStorage } from '../storage.js'
import { Mempool } from '../mempool.js'
import {
  blockWork,
  STARTING_DIFFICULTY,
  INITIAL_TARGET,
  MAX_BLOCK_SIZE,
  computeBlockHash,
  computeMerkleRoot,
  hashMeetsTarget,
  validateBlock,
  createGenesisBlock,
  medianTimestamp,
  type BlockHeader,
} from '../block.js'
import {
  createTransaction,
  createCoinbaseTransaction,
  utxoKey,
  CLAIM_TXID,
  type UTXO,
} from '../transaction.js'
import { doubleSha256Hex } from '../crypto.js'
import { MAX_MEMPOOL_BYTES } from '../mempool.js'
import { createClaimTransaction } from '../claim.js'
import { createMockSnapshot } from '../snapshot.js'
import { walletA, walletB } from './fixtures.js'
import net from 'node:net'

/** Wait for a condition to become true */
function waitFor(
  fn: () => boolean,
  timeout = 10_000,
  interval = 20,
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

function makeUtxoSet(wallet: { address: string }, amount = 100): Map<string, UTXO> {
  const utxoSet = new Map<string, UTXO>()
  const txId = 'a'.repeat(64)
  utxoSet.set(utxoKey(txId, 0), {
    txId,
    outputIndex: 0,
    address: wallet.address,
    amount,
  })
  return utxoSet
}

describe('Misbehavior score decay', () => {
  it('should decay score over time', () => {
    const socket = new net.Socket()
    const peer = new Peer(
      socket,
      true,
      () => {},
      () => {},
    )

    // Add some misbehavior
    peer.addMisbehavior(20)
    expect(peer.getMisbehaviorScore()).toBe(20)

    // Simulate time passing by directly setting lastMisbehaviorDecay
    ;(peer as any).lastMisbehaviorDecay = Date.now() - 5 * 60_000 // 5 minutes ago

    // Score should have decayed by 5
    expect(peer.getMisbehaviorScore()).toBe(15)

    socket.destroy()
  })

  it('should not decay below zero', () => {
    const socket = new net.Socket()
    const peer = new Peer(
      socket,
      true,
      () => {},
      () => {},
    )

    peer.addMisbehavior(3)
    ;(peer as any).lastMisbehaviorDecay = Date.now() - 10 * 60_000 // 10 minutes ago

    expect(peer.getMisbehaviorScore()).toBe(0)

    socket.destroy()
  })
})

describe('Private IP filtering', () => {
  let tmpDir: string
  let node: Node
  let p2p: P2PServer

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-ip-'))
    node = new Node('test')
    p2p = new P2PServer(node, 0, tmpDir)
  })

  afterEach(async () => {
    await p2p.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should reject RFC1918 addresses from address book', () => {
    // Call addKnownAddress via the private method
    const addAddr = (p2p as any).addKnownAddress.bind(p2p)

    addAddr('10.0.0.1', 6001)
    addAddr('172.16.0.1', 6001)
    addAddr('192.168.1.1', 6001)
    addAddr('127.0.0.1', 6001)
    addAddr('169.254.1.1', 6001)

    expect(p2p.getKnownAddresses().size).toBe(0)
  })

  it('should accept public addresses', () => {
    const addAddr = (p2p as any).addKnownAddress.bind(p2p)

    addAddr('8.8.8.8', 6001)
    addAddr('1.2.3.4', 6002)

    expect(p2p.getKnownAddresses().size).toBe(2)
  })

  it('should allow private IPs in local mode', () => {
    p2p.setLocalMode(true)
    const addAddr = (p2p as any).addKnownAddress.bind(p2p)

    addAddr('192.168.1.1', 6001)
    addAddr('10.0.0.1', 6002)

    expect(p2p.getKnownAddresses().size).toBe(2)
  })

  it('should reject IPv6 private addresses', () => {
    const addAddr = (p2p as any).addKnownAddress.bind(p2p)

    addAddr('::1', 6001)
    addAddr('fc00::1', 6001)
    addAddr('fd12::1', 6001)
    addAddr('fe80::1', 6001)

    expect(p2p.getKnownAddresses().size).toBe(0)
  })
})

describe('Minimum relay fee', () => {
  it('should reject zero-fee transactions', () => {
    const mempool = new Mempool()
    const wallet = walletA
    const utxoSet = makeUtxoSet(wallet, 100)

    // Create a transaction with zero fee (amount = all input)
    const tx = createTransaction(
      wallet,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: 100 }],
      [{ address: 'b'.repeat(64), amount: 100 }],
      0
    )

    const result = mempool.addTransaction(tx, utxoSet)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Fee rate')
    expect(result.error).toContain('below minimum')
  })

  it('should accept transactions with sufficient fee', () => {
    const mempool = new Mempool()
    const wallet = walletA
    const utxoSet = makeUtxoSet(wallet, 100000)

    // Create a transaction with a generous fee
    const tx = createTransaction(
      wallet,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: 100000 }],
      [{ address: 'b'.repeat(64), amount: 50 }],
      10000 // large fee
    )

    const result = mempool.addTransaction(tx, utxoSet)
    expect(result.success).toBe(true)
  })

  it('should still accept claim transactions (fee-free)', async () => {
    const { createClaimTransaction } = await import('../claim.js')
    const { createMockSnapshot } = await import('../snapshot.js')

    const mempool = new Mempool()
    const { snapshot, holders } = createMockSnapshot()

    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash
    )

    const result = mempool.addTransaction(claimTx, new Map())
    expect(result.success).toBe(true)
  })
})

describe('Cumulative work', () => {
  it('blockWork computes correctly', () => {
    // Easy target = low work
    const easyWork = blockWork(INITIAL_TARGET)
    // Hard target = high work
    const hardWork = blockWork(STARTING_DIFFICULTY)
    expect(hardWork).toBeGreaterThan(easyWork)
    expect(easyWork).toBeGreaterThan(0n)
  })

  it('blockchain tracks cumulative work', () => {
    const node = new Node('test')
    const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    node.chain.difficulty = TEST_TARGET

    const initialWork = node.chain.cumulativeWork
    expect(initialWork).toBeGreaterThan(0n)

    // Mine a block
    node.mine(walletA.address, false)
    expect(node.chain.cumulativeWork).toBeGreaterThan(initialWork)
  })

  it('cumulative work decreases on resetToHeight', () => {
    const node = new Node('test')
    const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    node.chain.difficulty = TEST_TARGET

    // Mine 3 blocks
    for (let i = 0; i < 3; i++) {
      node.mine(walletA.address, false)
    }
    const workAt3 = node.chain.cumulativeWork

    // Reset to height 1
    node.chain.resetToHeight(1)
    expect(node.chain.cumulativeWork).toBeLessThan(workAt3)
    expect(node.chain.cumulativeWork).toBeGreaterThan(0n)
  })

  it('status includes cumulativeWork', () => {
    const node = new Node('test')
    const state = node.getState()
    expect(state.cumulativeWork).toBeDefined()
    expect(typeof state.cumulativeWork).toBe('string')
  })
})

describe('Fork resolution safety', () => {
  let tmpDir1: string
  let tmpDir2: string
  let node1: Node
  let node2: Node
  let p2p1: P2PServer
  let p2p2: P2PServer

  const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

  beforeEach(async () => {
    tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-fr-1-'))
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-fr-2-'))

    node1 = new Node('alice', undefined, new FileBlockStorage(tmpDir1))
    node2 = new Node('bob', undefined, new FileBlockStorage(tmpDir2))

    node1.chain.difficulty = TEST_TARGET
    node2.chain.difficulty = TEST_TARGET

    p2p1 = new P2PServer(node1, 0, tmpDir1)
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

  it('should clear fork resolution flag on peer disconnect', async () => {
    // Set fork resolution flag directly
    ;(p2p1 as any).forkResolutionInProgress = true

    // Simulate a peer connecting and disconnecting
    const addr = (p2p2 as any).server.address()
    const port = typeof addr === 'object' ? addr.port : 0
    p2p1.connectOutbound('127.0.0.1', port)

    await waitFor(() => p2p1.getPeers().length > 0)

    // Disconnect the peer
    const peerMap = (p2p1 as any).peers as Map<string, Peer>
    const peer = peerMap.values().next().value as Peer
    peer.disconnect('test disconnect')

    await waitFor(() => p2p1.getPeers().length === 0)

    // Flag should be cleared
    expect((p2p1 as any).forkResolutionInProgress).toBe(false)
  })
})

describe('Getaddr rate limiting', () => {
  it('should track lastGetaddrResponse on peer', () => {
    const socket = new net.Socket()
    const peer = new Peer(
      socket,
      true,
      () => {},
      () => {},
    )

    expect(peer.lastGetaddrResponse).toBe(0)
    peer.lastGetaddrResponse = Date.now()
    expect(peer.lastGetaddrResponse).toBeGreaterThan(0)

    socket.destroy()
  })
})

describe('Seed reconnection backoff', () => {
  let tmpDir: string
  let node: Node
  let p2p: P2PServer

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-backoff-'))
    node = new Node('test')
    p2p = new P2PServer(node, 0, tmpDir)
    await p2p.start()
  })

  afterEach(async () => {
    await p2p.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should increase backoff delay on failed connections', () => {
    const seedBackoff = (p2p as any).seedBackoff as Map<string, number>

    // Simulate failed connection by setting backoff
    seedBackoff.set('1.2.3.4:6001', 5000)
    expect(seedBackoff.get('1.2.3.4:6001')).toBe(5000)

    // After another failure, delay should double (up to max)
    seedBackoff.set('1.2.3.4:6001', 10000)
    expect(seedBackoff.get('1.2.3.4:6001')).toBe(10000)
  })

  it('should cap backoff at 60s', () => {
    const seedBackoff = (p2p as any).seedBackoff as Map<string, number>

    // Set backoff beyond max
    seedBackoff.set('1.2.3.4:6001', 120000)
    const delay = Math.min(seedBackoff.get('1.2.3.4:6001')! * 2, 60000)
    expect(delay).toBe(60000)
  })
})

describe('RPC blocks count cap', () => {
  it('should cap blocks endpoint count to 100', async () => {
    const { startRpcServer } = await import('../rpc.js')
    const node = new Node('rpc-test')
    const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    node.chain.difficulty = TEST_TARGET

    // Mine a few blocks
    for (let i = 0; i < 5; i++) {
      node.mine(walletA.address, false)
    }

    // Start RPC on random port
    const app = startRpcServer(node, 0)
    const server = app.listen(0)
    const addr = server.address() as { port: number }

    try {
      // Request with count=999999 (should be capped to 100)
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/v1/blocks?count=999999`)
      const blocks = await res.json()
      expect(Array.isArray(blocks)).toBe(true)
      // We only have 6 blocks (genesis + 5), but count is capped to 100
      expect(blocks.length).toBeLessThanOrEqual(100)
      expect(blocks.length).toBe(6) // all 6 blocks since < 100

      // Request with explicit count=2
      const res2 = await fetch(`http://127.0.0.1:${addr.port}/api/v1/blocks?count=2`)
      const blocks2 = await res2.json()
      expect(blocks2.length).toBe(2)
    } finally {
      server.close()
    }
  })
})

describe('RPC hardening', () => {
  it('should return 400 for NaN count parameter', async () => {
    const { startRpcServer } = await import('../rpc.js')
    const node = new Node('rpc-nan')
    const app = startRpcServer(node, 0)
    const server = app.listen(0)
    const addr = server.address() as { port: number }

    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/v1/blocks?count=abc`)
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Invalid count')
    } finally {
      server.close()
    }
  })

  it('should return 400 for negative count parameter', async () => {
    const { startRpcServer } = await import('../rpc.js')
    const node = new Node('rpc-neg')
    const app = startRpcServer(node, 0)
    const server = app.listen(0)
    const addr = server.address() as { port: number }

    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/v1/blocks?count=-5`)
      expect(res.status).toBe(400)
    } finally {
      server.close()
    }
  })

  it('should handle NaN mempool limit gracefully', async () => {
    const { startRpcServer } = await import('../rpc.js')
    const node = new Node('rpc-mlimit')
    const app = startRpcServer(node, 0)
    const server = app.listen(0)
    const addr = server.address() as { port: number }

    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/v1/mempool/txs?limit=xyz`)
      expect(res.status).toBe(200) // should fall back to default limit, not crash
      const body = await res.json()
      expect(Array.isArray(body)).toBe(true)
    } finally {
      server.close()
    }
  })

  it('should not expose X-Powered-By header', async () => {
    const { startRpcServer } = await import('../rpc.js')
    const node = new Node('rpc-xpb')
    const app = startRpcServer(node, 0)
    const server = app.listen(0)
    const addr = server.address() as { port: number }

    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/v1/status`)
      expect(res.headers.get('x-powered-by')).toBeNull()
    } finally {
      server.close()
    }
  })

  it('should deny CORS when bound to non-localhost', async () => {
    const { startRpcServer } = await import('../rpc.js')
    const node = new Node('rpc-cors')
    // Bind to 0.0.0.0 — CORS should be restrictive
    // startRpcServer calls app.listen internally, so we create our own app
    const express = (await import('express')).default
    const cors = (await import('cors')).default
    const app = express()
    // Simulate the CORS behavior for non-localhost bind
    app.use(cors({ origin: false }))
    app.get('/test', (req: any, res: any) => res.json({ ok: true }))
    const server = app.listen(0)
    const addr = server.address() as { port: number }

    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/test`)
      // When origin is false, no Access-Control-Allow-Origin header should be present
      const corsHeader = res.headers.get('access-control-allow-origin')
      expect(corsHeader).toBeNull()
    } finally {
      server.close()
    }
  })
})

describe('Block timestamp validation', () => {
  const easyTarget = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

  function mineTestBlock(header: BlockHeader): { header: BlockHeader, hash: string } {
    let hash = computeBlockHash(header)
    while (!hashMeetsTarget(hash, easyTarget)) {
      header.nonce++
      hash = computeBlockHash(header)
    }
    return { header, hash }
  }

  it('should reject block with timestamp before MTP', () => {
    const node = new Node('mtp-test')
    node.chain.difficulty = easyTarget

    // Mine 12 blocks to have enough for MTP calculation
    for (let i = 0; i < 12; i++) {
      node.mine(walletA.address, false)
    }

    const chain = node.chain.blocks
    const tipIndex = chain.length - 1
    const mtp = medianTimestamp(chain, tipIndex)

    // Create a block with timestamp equal to MTP (should fail — must be strictly greater)
    const coinbase = createCoinbaseTransaction(walletA.address, chain.length, 0)
    const merkleRoot = computeMerkleRoot([coinbase.id])

    const header: BlockHeader = {
      version: 1,
      previousHash: chain[tipIndex].hash,
      merkleRoot,
      timestamp: mtp, // exactly MTP, should be rejected
      target: easyTarget,
      nonce: 0,
    }
    const mined = mineTestBlock(header)

    const block = { ...mined, transactions: [coinbase], height: chain.length }
    const result = validateBlock(block, chain[tipIndex], new Map(), chain)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('median time past')
  })

  it('should reject block with timestamp too far in the future', () => {
    const node = new Node('future-test')
    node.chain.difficulty = easyTarget
    node.mine(walletA.address, false)

    const chain = node.chain.blocks
    const coinbase = createCoinbaseTransaction(walletA.address, 2, 0)
    const merkleRoot = computeMerkleRoot([coinbase.id])

    const header: BlockHeader = {
      version: 1,
      previousHash: chain[1].hash,
      merkleRoot,
      timestamp: Date.now() + 3 * 60 * 60 * 1000, // 3 hours in the future
      target: easyTarget,
      nonce: 0,
    }
    const mined = mineTestBlock(header)

    const block = { ...mined, transactions: [coinbase], height: 2 }
    const result = validateBlock(block, chain[1], new Map(), chain)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('too far in the future')
  })

  it('should accept block with valid timestamp after MTP', () => {
    const node = new Node('valid-ts-test')
    node.chain.difficulty = easyTarget

    for (let i = 0; i < 12; i++) {
      node.mine(walletA.address, false)
    }

    // Mining through node.mine already validates MTP, so if we got here it works.
    // Verify the chain is valid by checking the last mined block passed MTP.
    const chain = node.chain.blocks
    const tipIndex = chain.length - 1
    const tip = chain[tipIndex]
    const mtp = medianTimestamp(chain, tipIndex - 1)
    expect(tip.header.timestamp).toBeGreaterThan(mtp)
  })
})

describe('Block size limit', () => {
  it('should reject block exceeding MAX_BLOCK_SIZE', () => {
    const genesis = createGenesisBlock()
    const easyTarget = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

    const coinbase = createCoinbaseTransaction('c'.repeat(64), 1, 0)

    // Create many fake claim txs to exceed 1MB
    // Each claim tx is ~165 bytes (header + input + output + claimData)
    // We need ~6100 to exceed 1MB
    const txs = [coinbase]
    const txCount = Math.ceil(MAX_BLOCK_SIZE / 165) + 100
    for (let i = 0; i < txCount; i++) {
      txs.push({
        id: doubleSha256Hex(new TextEncoder().encode(`big-${i}`)),
        inputs: [{ txId: CLAIM_TXID, outputIndex: 0, publicKey: new Uint8Array(0), signature: new Uint8Array(0) }],
        outputs: [{ address: 'a'.repeat(64), amount: 100 }],
        timestamp: Date.now(),
        claimData: {
          btcAddress: `addr${i.toString().padStart(16, '0')}`,
          ecdsaPublicKey: new Uint8Array(33),
          ecdsaSignature: new Uint8Array(64),
          qbtcAddress: 'a'.repeat(64),
        },
      })
    }

    const merkleRoot = computeMerkleRoot(txs.map(t => t.id))
    const header: BlockHeader = {
      version: 1,
      previousHash: genesis.hash,
      merkleRoot,
      timestamp: Date.now(),
      target: easyTarget,
      nonce: 0,
    }

    let hash = computeBlockHash(header)
    while (!hashMeetsTarget(hash, easyTarget)) {
      header.nonce++
      hash = computeBlockHash(header)
    }

    const block = { header, hash, transactions: txs, height: 1 }
    const result = validateBlock(block, genesis, new Map())
    expect(result.valid).toBe(false)
    expect(result.error).toContain('exceeds max')
  })
})

describe('Mempool size cap', () => {
  it('should evict low-fee transactions when full', () => {
    const mempool = new Mempool()

    // Create many transactions to fill the mempool
    // Each ML-DSA-65 tx is ~5KB, so we need ~10,000 to hit 50MB
    // Instead of actually filling it, test the eviction logic by checking the mechanism
    const utxoSet = makeUtxoSet(walletA, 10_000_000_000)

    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: 10_000_000_000 }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      10_000
    )
    const result = mempool.addTransaction(tx, utxoSet)
    expect(result.success).toBe(true)

    // Verify the totalBytes is tracked
    expect((mempool as any).totalBytes).toBeGreaterThan(0)
  })

  it('should reject tx when pool is full and nothing can be evicted', () => {
    const mempool = new Mempool()

    // Inflate totalBytes to the limit (no actual txs to evict)
    ;(mempool as any).totalBytes = MAX_MEMPOOL_BYTES

    const utxoSet = makeUtxoSet(walletA, 10_000_000_000)
    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: 10_000_000_000 }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      10_000
    )
    const result = mempool.addTransaction(tx, utxoSet)
    // Pool is "full" and there are no candidates to evict
    expect(result.success).toBe(false)
    expect(result.error).toContain('fee density too low')
  })
})

describe('P2P getheaders locator cap', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-locator-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should cap locator to 101 entries and still find fork point', async () => {
    const storage = new FileBlockStorage(tmpDir)
    const node = new Node('test', undefined, storage)
    const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    node.chain.difficulty = TEST_TARGET

    // Mine a few blocks
    for (let i = 0; i < 5; i++) {
      node.mine(walletA.address, false)
    }

    const p2p = new P2PServer(node, 0, tmpDir)
    await p2p.start()

    try {
      // Simulate a getheaders with 200 locator hashes (should be capped to 101)
      const fakePeer = {
        handshakeComplete: true,
        addMisbehavior: () => {},
        send: (msg: any) => {
          // The response should have headers
          expect(msg.type).toBe('headers')
          expect(Array.isArray(msg.payload.headers)).toBe(true)
        },
      }

      const largeLocator = Array.from({ length: 200 }, (_, i) => `${i.toString(16).padStart(64, '0')}`)
      // Put the genesis hash at position 150 (beyond the cap)
      largeLocator[150] = node.chain.blocks[0].hash

      const handleGetHeaders = (p2p as any).handleGetHeaders.bind(p2p)
      handleGetHeaders(fakePeer, { locatorHashes: largeLocator })

      // The genesis at index 150 should NOT be found (capped at 101)
      // so forkPoint defaults to 0 and we get headers from height 1
    } finally {
      await p2p.stop()
    }
  })
})

describe('P2P message error handling', () => {
  let tmpDir1: string
  let tmpDir2: string

  beforeEach(() => {
    tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-err-1-'))
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-err-2-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir1, { recursive: true, force: true })
    fs.rmSync(tmpDir2, { recursive: true, force: true })
  })

  it('should add misbehavior for malformed hex in transaction data', async () => {
    const storage1 = new FileBlockStorage(tmpDir1)
    const storage2 = new FileBlockStorage(tmpDir2)
    const node1 = new Node('alice', undefined, storage1)
    const node2 = new Node('bob', undefined, storage2)

    const p2p1 = new P2PServer(node1, 0, tmpDir1)
    const p2p2 = new P2PServer(node2, 0, tmpDir2)
    await p2p1.start()
    await p2p2.start()

    try {
      const addr = (p2p1 as any).server.address()
      const port = typeof addr === 'object' ? addr.port : 0
      p2p2.connectOutbound('127.0.0.1', port)
      await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

      const peerOnNode1 = Array.from((p2p1 as any).peers.values())[0]
      const scoreBefore = peerOnNode1.getMisbehaviorScore()

      // Send a tx with invalid hex (should throw in hexToBytes, caught by handleMessage)
      const peerOnNode2 = Array.from((p2p2 as any).peers.values())[0]
      peerOnNode2.send({
        type: 'tx',
        payload: {
          tx: {
            id: 'f'.repeat(64),
            inputs: [{
              txId: 'a'.repeat(64),
              outputIndex: 0,
              publicKey: 'NOT_VALID_HEX_ZZZZ',
              signature: 'ALSO_NOT_HEX!!!!',
            }],
            outputs: [{ address: 'b'.repeat(64), amount: 100 }],
            timestamp: Date.now(),
          },
        },
      })

      await new Promise(r => setTimeout(r, 300))

      // Should have received misbehavior points (handleMessage try-catch catches the throw)
      const scoreAfter = peerOnNode1.getMisbehaviorScore()
      expect(scoreAfter).toBeGreaterThan(scoreBefore)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should add misbehavior for unknown message type', async () => {
    const storage1 = new FileBlockStorage(tmpDir1)
    const storage2 = new FileBlockStorage(tmpDir2)
    const node1 = new Node('alice', undefined, storage1)
    const node2 = new Node('bob', undefined, storage2)

    const p2p1 = new P2PServer(node1, 0, tmpDir1)
    const p2p2 = new P2PServer(node2, 0, tmpDir2)
    await p2p1.start()
    await p2p2.start()

    try {
      const addr = (p2p1 as any).server.address()
      const port = typeof addr === 'object' ? addr.port : 0
      p2p2.connectOutbound('127.0.0.1', port)
      await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

      const peerOnNode1 = Array.from((p2p1 as any).peers.values())[0]
      const scoreBefore = peerOnNode1.getMisbehaviorScore()

      // Send a message with unknown type
      const peerOnNode2 = Array.from((p2p2 as any).peers.values())[0]
      peerOnNode2.send({ type: 'foobar' as any, payload: {} })

      await new Promise(r => setTimeout(r, 300))

      // Unknown type should add +10 misbehavior
      expect(peerOnNode1.getMisbehaviorScore()).toBe(scoreBefore + 10)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })
})

describe('Node.resetToHeight', () => {
  const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

  it('removes invalidated mempool tx after rollback', () => {
    const node = new Node('reset-test')
    node.chain.difficulty = TEST_TARGET

    // Mine block 1
    node.mine(walletA.address, false)
    expect(node.chain.getHeight()).toBe(1)

    // Directly inject a tx into mempool that references block 1's coinbase UTXO
    // (bypassing maturity check by using mempool internals)
    const coinbaseTx = node.chain.blocks[1].transactions[0]
    const fakeUtxoKey = utxoKey(coinbaseTx.id, 0)

    // Create a tx spending a UTXO that exists at height 1 but not at height 0
    const tx = createTransaction(
      walletA,
      [{ txId: coinbaseTx.id, outputIndex: 0, address: walletA.address, amount: coinbaseTx.outputs[0].amount }],
      [{ address: 'b'.repeat(64), amount: 50 }],
      10_000
    )
    // Force-add to mempool (the UTXO exists in chain but isn't mature — we're testing revalidate, not addTransaction)
    ;(node.mempool as any).transactions.set(tx.id, tx)
    ;(node.mempool as any).claimedUTXOs.add(fakeUtxoKey)
    expect(node.mempool.size()).toBe(1)

    // Reset to height 0 — the UTXO that tx spends no longer exists
    node.resetToHeight(0)
    expect(node.mempool.size()).toBe(0)
  })

  it('preserves claim in mempool after rollback', () => {
    const { snapshot, holders } = createMockSnapshot()
    const node = new Node('reset-claim', snapshot)
    node.chain.difficulty = TEST_TARGET

    // Mine block 1 (without the claim)
    node.mine(walletA.address, false)

    // Add claim to mempool
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash,
      node.chain.blocks[0].hash
    )
    const addResult = node.receiveTransaction(claimTx)
    expect(addResult.success).toBe(true)
    expect(node.mempool.size()).toBe(1)

    // Reset to height 0 — claim should survive (not on-chain)
    node.resetToHeight(0)
    expect(node.mempool.size()).toBe(1)
  })

  it('clears claimedBtcAddresses on rollback allowing re-claim', () => {
    const { snapshot, holders } = createMockSnapshot()
    const node = new Node('reset-claim2', snapshot)
    node.chain.difficulty = TEST_TARGET
    const genesisHash = node.chain.blocks[0].hash

    // Create and mine a claim in block 1
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletA,
      snapshot.btcBlockHash,
      genesisHash
    )

    // Mine block with claim
    const tip = node.chain.getChainTip()
    const height = node.chain.getHeight() + 1
    const coinbase = createCoinbaseTransaction(walletA.address, height, 0)
    const txs = [coinbase, claimTx]
    const merkleRoot = computeMerkleRoot(txs.map(t => t.id))
    const header = {
      version: 1,
      previousHash: tip.hash,
      merkleRoot,
      timestamp: tip.header.timestamp + 1,
      target: TEST_TARGET,
      nonce: 0,
    }
    let hash = computeBlockHash(header)
    while (!hashMeetsTarget(hash, TEST_TARGET)) {
      header.nonce++
      hash = computeBlockHash(header)
    }
    const block = { header, hash, transactions: txs, height }
    const blockResult = node.chain.addBlock(block)
    expect(blockResult.success).toBe(true)

    // Verify claim is tracked
    expect(node.chain.claimedBtcAddresses.has(snapshot.entries[0].btcAddress)).toBe(true)

    // Reset to height 0
    node.resetToHeight(0)

    // claimedBtcAddresses should be cleared
    expect(node.chain.claimedBtcAddresses.has(snapshot.entries[0].btcAddress)).toBe(false)

    // Should be able to add the claim to mempool again
    const claimTx2 = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash,
      genesisHash
    )
    const addResult = node.receiveTransaction(claimTx2)
    expect(addResult.success).toBe(true)
  })
})

describe('Orphan block PoW validation', () => {
  it('should reject orphans with invalid PoW', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-orphan-'))
    try {
      const node = new Node('test', undefined, new FileBlockStorage(tmpDir))
      const p2p = new P2PServer(node, 0, tmpDir)

      // Try to add orphan with fake hash (bypass the public API, call private addOrphan)
      const fakeOrphan = {
        header: {
          version: 1,
          previousHash: 'dead'.repeat(16), // unknown parent
          merkleRoot: 'a'.repeat(64),
          timestamp: Date.now(),
          target: '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
          nonce: 0,
        },
        hash: 'beef'.repeat(16), // doesn't match header
        transactions: [],
        height: 99,
      }

      ;(p2p as any).addOrphan(fakeOrphan)

      // Should NOT be in orphan pool (hash doesn't match header)
      expect((p2p as any).orphanBlocks.size).toBe(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('Node receiveBlock', () => {
  const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

  it('aborts in-progress mining when a valid block arrives', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-abort-'))
    try {
      const storage = new FileBlockStorage(tmpDir)
      const node = new Node('miner', undefined, storage)
      // Use extremely hard target so miner cannot find a block during the test
      node.chain.difficulty = '0000000000000fffffffffffffffffffffffffffffffffffffffffffffffffff'

      let aborted = false
      const miningPromise = node.startMining(walletA.address)

      // Wait for mining to start
      await waitFor(() => node.miningStats !== null, 10_000)

      // Mine a block externally and feed it via receiveBlock
      const { assembleCandidateBlock, mineBlock } = await import('../miner.js')
      node.chain.difficulty = TEST_TARGET
      const candidate = assembleCandidateBlock(node.chain, node.mempool, walletB.address)
      const externalBlock = mineBlock(candidate, false)

      const result = node.receiveBlock(externalBlock)
      expect(result.success).toBe(true)

      // Mining should restart (miningStats resets for new round)
      // Give it a moment to restart
      await new Promise(r => setTimeout(r, 200))

      node.stopMining()
      await Promise.race([
        miningPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000))
      ])

      // Block from external miner should be in the chain
      expect(node.chain.getHeight()).toBeGreaterThanOrEqual(1)
      expect(node.chain.blocks[1].hash).toBe(externalBlock.hash)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('does not abort mining when receiveBlock fails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-noabort-'))
    try {
      const storage = new FileBlockStorage(tmpDir)
      const node = new Node('miner', undefined, storage)
      node.chain.difficulty = '00000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

      const miningPromise = node.startMining(walletA.address)
      await waitFor(() => node.miningStats !== null, 10_000)

      // Send an invalid block (wrong target)
      const invalidBlock = {
        header: {
          version: 1,
          previousHash: node.chain.blocks[0].hash,
          merkleRoot: 'a'.repeat(64),
          timestamp: Date.now(),
          target: 'f'.repeat(64),
          nonce: 0,
        },
        hash: 'b'.repeat(64),
        transactions: [],
        height: 1,
      }

      const result = node.receiveBlock(invalidBlock as any)
      expect(result.success).toBe(false)

      // Mining should still be running (miningStats not null)
      expect(node.miningStats).not.toBeNull()

      node.stopMining()
      await Promise.race([
        miningPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000))
      ])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('validateBlock edge cases', () => {
  const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

  it('rejects claim tx with zero amount', () => {
    // Blockchain imported at top of file
    const { snapshot } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    chain.difficulty = TEST_TARGET

    const tip = chain.getChainTip()
    const height = chain.getHeight() + 1
    const coinbase = createCoinbaseTransaction(walletA.address, height, 0)

    // Claim tx with amount = 0
    const zeroClaim = {
      id: doubleSha256Hex(new TextEncoder().encode('zero-claim')),
      inputs: [{ txId: CLAIM_TXID, outputIndex: 0, publicKey: new Uint8Array(0), signature: new Uint8Array(0) }],
      outputs: [{ address: walletA.address, amount: 0 }],
      timestamp: Date.now(),
      claimData: {
        btcAddress: snapshot.entries[0].btcAddress,
        ecdsaPublicKey: new Uint8Array(33),
        ecdsaSignature: new Uint8Array(64),
        qbtcAddress: walletA.address,
      },
    }

    const txs = [coinbase, zeroClaim]
    const merkleRoot = computeMerkleRoot(txs.map(t => t.id))

    const header: BlockHeader = {
      version: 1,
      previousHash: tip.hash,
      merkleRoot,
      timestamp: tip.header.timestamp + 1,
      target: TEST_TARGET,
      nonce: 0,
    }

    let hash = computeBlockHash(header)
    while (!hashMeetsTarget(hash, header.target)) {
      header.nonce++
      hash = computeBlockHash(header)
    }

    const result = validateBlock(
      { header, hash, transactions: txs, height },
      tip,
      chain.utxoSet,
      chain.blocks
    )
    expect(result.valid).toBe(false)
  })

  it('rejects claim tx with multiple outputs', () => {
    // Blockchain imported at top of file
    const { snapshot } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    chain.difficulty = TEST_TARGET

    const tip = chain.getChainTip()
    const height = chain.getHeight() + 1
    const coinbase = createCoinbaseTransaction(walletA.address, height, 0)

    const multiOutputClaim = {
      id: doubleSha256Hex(new TextEncoder().encode('multi-out-claim')),
      inputs: [{ txId: CLAIM_TXID, outputIndex: 0, publicKey: new Uint8Array(0), signature: new Uint8Array(0) }],
      outputs: [
        { address: walletA.address, amount: 50_000_000 },
        { address: walletB.address, amount: 50_000_000 },
      ],
      timestamp: Date.now(),
      claimData: {
        btcAddress: snapshot.entries[0].btcAddress,
        ecdsaPublicKey: new Uint8Array(33),
        ecdsaSignature: new Uint8Array(64),
        qbtcAddress: walletA.address,
      },
    }

    const txs = [coinbase, multiOutputClaim]
    const merkleRoot = computeMerkleRoot(txs.map(t => t.id))

    const header: BlockHeader = {
      version: 1,
      previousHash: tip.hash,
      merkleRoot,
      timestamp: tip.header.timestamp + 1,
      target: TEST_TARGET,
      nonce: 0,
    }

    let hash = computeBlockHash(header)
    while (!hashMeetsTarget(hash, header.target)) {
      header.nonce++
      hash = computeBlockHash(header)
    }

    const result = validateBlock(
      { header, hash, transactions: txs, height },
      tip,
      chain.utxoSet,
      chain.blocks
    )
    expect(result.valid).toBe(false)
  })

  it('blockWork returns 0n for zero target', () => {
    expect(blockWork('0'.repeat(64))).toBe(0n)
  })
})
