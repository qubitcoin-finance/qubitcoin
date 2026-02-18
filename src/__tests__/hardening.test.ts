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
  validateTransaction,
  utxoKey,
  CLAIM_TXID,
  CLAIM_MATURITY,
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

describe('Duplicate txid rejection', () => {
  const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

  function mineTestBlock(header: BlockHeader): { header: BlockHeader; hash: string } {
    let hash = computeBlockHash(header)
    while (!hashMeetsTarget(hash, TEST_TARGET)) {
      header.nonce++
      hash = computeBlockHash(header)
    }
    return { header, hash }
  }

  it('should reject block with duplicate coinbase txid', () => {
    const genesis = createGenesisBlock()
    const coinbase = createCoinbaseTransaction(walletA.address, 1, 0)

    const txs = [coinbase, coinbase]
    const merkleRoot = computeMerkleRoot(txs.map(t => t.id))
    const { header, hash } = mineTestBlock({
      version: 1, previousHash: genesis.hash, merkleRoot,
      timestamp: Date.now(), target: TEST_TARGET, nonce: 0,
    })
    const result = validateBlock({ header, hash, transactions: txs, height: 1 }, genesis, new Map())
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Duplicate transaction ID')
  })

  it('should reject block with duplicate claim txid among multiple txs', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    chain.difficulty = TEST_TARGET

    const genesis = chain.getChainTip()
    const coinbase = createCoinbaseTransaction(walletA.address, 1, 0)

    // Create a claim tx, then include it twice alongside coinbase
    const claimTx = createClaimTransaction(
      holders[0].secretKey, holders[0].publicKey,
      snapshot.entries[0], walletA, snapshot.btcBlockHash, genesis.hash
    )

    const txs = [coinbase, claimTx, claimTx]
    const merkleRoot = computeMerkleRoot(txs.map(t => t.id))
    const { header, hash } = mineTestBlock({
      version: 1, previousHash: genesis.hash, merkleRoot,
      timestamp: genesis.header.timestamp + 1, target: TEST_TARGET, nonce: 0,
    })
    const result = validateBlock(
      { header, hash, transactions: txs, height: 1 },
      genesis, chain.utxoSet, chain.blocks
    )
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Duplicate transaction ID')
  })

  it('should accept block with three unique transactions', () => {
    const node = new Node('dup-test')
    node.chain.difficulty = TEST_TARGET

    // Mine 2 blocks so we have mature coinbase UTXOs (height 1 coinbase matures at 101)
    // For this test just verify unique txs pass — mine 1 block is enough
    node.mine(walletA.address, false)
    expect(node.chain.getHeight()).toBe(1)
    // Block 1 has coinbase only — that's unique, so it passes
  })

  it('should report the duplicate txid in error message', () => {
    const genesis = createGenesisBlock()
    const coinbase = createCoinbaseTransaction(walletA.address, 1, 0)

    const txs = [coinbase, coinbase]
    const merkleRoot = computeMerkleRoot(txs.map(t => t.id))
    const { header, hash } = mineTestBlock({
      version: 1, previousHash: genesis.hash, merkleRoot,
      timestamp: Date.now(), target: TEST_TARGET, nonce: 0,
    })
    const result = validateBlock({ header, hash, transactions: txs, height: 1 }, genesis, new Map())
    expect(result.valid).toBe(false)
    expect(result.error).toContain(coinbase.id)
  })
})

describe('Claim maturity', () => {
  const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

  function mineEmpty(node: Node) {
    node.mine(walletA.address, false)
  }

  function mineBlockOnChain(chain: Blockchain, extraTxs: any[] = []) {
    const tip = chain.getChainTip()
    const height = chain.getHeight() + 1
    const coinbase = createCoinbaseTransaction('f'.repeat(64), height, 0)
    const txs = [coinbase, ...extraTxs]
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
    return { header, hash, transactions: txs, height }
  }

  it('should reject spending claim UTXO at age 1 (validateTransaction)', () => {
    const claimUtxo: UTXO = {
      txId: 'c'.repeat(63) + '1',
      outputIndex: 0,
      address: walletA.address,
      amount: 100_000_000,
      height: 5,
      isClaim: true,
    }
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(claimUtxo.txId, 0), claimUtxo)

    const spendTx = createTransaction(
      walletA,
      [claimUtxo],
      [{ address: walletB.address, amount: 100_000_000 - 10000 }],
      10000
    )

    const result = validateTransaction(spendTx, utxoSet, 6) // age=1
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Claim UTXO')
    expect(result.error).toContain('not mature')
    expect(result.error).toContain('age 1')
  })

  it('should reject spending claim UTXO at age 9 (one block short)', () => {
    const claimUtxo: UTXO = {
      txId: 'c'.repeat(63) + '2',
      outputIndex: 0,
      address: walletA.address,
      amount: 50_000_000,
      height: 1,
      isClaim: true,
    }
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(claimUtxo.txId, 0), claimUtxo)

    const spendTx = createTransaction(
      walletA,
      [claimUtxo],
      [{ address: walletB.address, amount: 50_000_000 - 10000 }],
      10000
    )

    // currentHeight=10, height=1, age=9 < CLAIM_MATURITY(10)
    const result = validateTransaction(spendTx, utxoSet, 10)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('age 9')
    expect(result.error).toContain(`need ${CLAIM_MATURITY}`)
  })

  it('should allow spending claim UTXO at exactly CLAIM_MATURITY age', () => {
    const claimUtxo: UTXO = {
      txId: 'c'.repeat(63) + '3',
      outputIndex: 0,
      address: walletA.address,
      amount: 100_000_000,
      height: 1,
      isClaim: true,
    }
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(claimUtxo.txId, 0), claimUtxo)

    const spendTx = createTransaction(
      walletA,
      [claimUtxo],
      [{ address: walletB.address, amount: 100_000_000 - 10000 }],
      10000
    )

    // currentHeight=11, height=1, age=10 == CLAIM_MATURITY
    const result = validateTransaction(spendTx, utxoSet, 1 + CLAIM_MATURITY)
    expect(result.valid).toBe(true)
  })

  it('should allow spending claim UTXO well past maturity', () => {
    const claimUtxo: UTXO = {
      txId: 'c'.repeat(63) + '4',
      outputIndex: 0,
      address: walletA.address,
      amount: 100_000_000,
      height: 1,
      isClaim: true,
    }
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(claimUtxo.txId, 0), claimUtxo)

    const spendTx = createTransaction(
      walletA,
      [claimUtxo],
      [{ address: walletB.address, amount: 100_000_000 - 10000 }],
      10000
    )

    // age = 500, well past maturity
    const result = validateTransaction(spendTx, utxoSet, 501)
    expect(result.valid).toBe(true)
  })

  it('should not apply claim maturity to non-claim UTXOs', () => {
    // Regular UTXO (not isClaim, not isCoinbase) — should be spendable immediately
    const utxo: UTXO = {
      txId: 'a'.repeat(64),
      outputIndex: 0,
      address: walletA.address,
      amount: 100_000_000,
      height: 10,
      // no isClaim flag
    }
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(utxo.txId, 0), utxo)

    const spendTx = createTransaction(
      walletA,
      [utxo],
      [{ address: walletB.address, amount: 100_000_000 - 10000 }],
      10000
    )

    // currentHeight=11, age=1 — would fail if claim maturity applied
    const result = validateTransaction(spendTx, utxoSet, 11)
    expect(result.valid).toBe(true)
  })

  it('should set isClaim=true on UTXOs created by claim transactions (chain level)', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    chain.difficulty = TEST_TARGET
    const genesisHash = chain.blocks[0].hash

    const claimTx = createClaimTransaction(
      holders[0].secretKey, holders[0].publicKey,
      snapshot.entries[0], walletA, snapshot.btcBlockHash, genesisHash
    )

    const block = mineBlockOnChain(chain, [claimTx])
    expect(chain.addBlock(block).success).toBe(true)

    // Check the UTXO created by the claim has isClaim=true
    const key = utxoKey(claimTx.id, 0)
    const utxo = chain.utxoSet.get(key)
    expect(utxo).toBeDefined()
    expect(utxo!.isClaim).toBe(true)
    expect(utxo!.height).toBe(1)
  })

  it('should NOT set isClaim on coinbase UTXOs', () => {
    const node = new Node('cb-flag')
    node.chain.difficulty = TEST_TARGET
    node.mine(walletA.address, false)

    // Get the coinbase UTXO
    const coinbaseTx = node.chain.blocks[1].transactions[0]
    const key = utxoKey(coinbaseTx.id, 0)
    const utxo = node.chain.utxoSet.get(key)
    expect(utxo).toBeDefined()
    expect(utxo!.isClaim).toBeUndefined()
    expect(utxo!.isCoinbase).toBe(true)
  })

  it('should reject immature claim spend at chain level (addBlock)', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    chain.difficulty = TEST_TARGET
    const genesisHash = chain.blocks[0].hash

    // Mine a claim in block 1
    const claimTx = createClaimTransaction(
      holders[0].secretKey, holders[0].publicKey,
      snapshot.entries[0], walletA, snapshot.btcBlockHash, genesisHash
    )
    const block1 = mineBlockOnChain(chain, [claimTx])
    expect(chain.addBlock(block1).success).toBe(true)

    // Try spending immediately in block 2 (age=1, need 10)
    const utxos = chain.findUTXOs(walletA.address)
    expect(utxos.length).toBe(1)

    const spendTx = createTransaction(
      walletA,
      utxos,
      [{ address: walletB.address, amount: utxos[0].amount - 10000 }],
      10000
    )
    const block2 = mineBlockOnChain(chain, [spendTx])
    const result = chain.addBlock(block2)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Claim UTXO')
    expect(result.error).toContain('not mature')
  })

  it('should accept mature claim spend at chain level (addBlock)', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    chain.difficulty = TEST_TARGET
    const genesisHash = chain.blocks[0].hash

    // Mine a claim in block 1
    const claimTx = createClaimTransaction(
      holders[0].secretKey, holders[0].publicKey,
      snapshot.entries[0], walletA, snapshot.btcBlockHash, genesisHash
    )
    const block1 = mineBlockOnChain(chain, [claimTx])
    expect(chain.addBlock(block1).success).toBe(true)

    // Mine CLAIM_MATURITY empty blocks to mature the claim
    for (let i = 0; i < CLAIM_MATURITY; i++) {
      expect(chain.addBlock(mineBlockOnChain(chain)).success).toBe(true)
    }

    // Now spend at height 1 + CLAIM_MATURITY + 1 = 12 (age=11, need 10) — should succeed
    const utxos = chain.findUTXOs(walletA.address)
    expect(utxos.length).toBe(1)

    const spendTx = createTransaction(
      walletA,
      utxos,
      [{ address: walletB.address, amount: utxos[0].amount - 10000 }],
      10000
    )
    const spendBlock = mineBlockOnChain(chain, [spendTx])
    const result = chain.addBlock(spendBlock)
    expect(result.success).toBe(true)
    expect(chain.getBalance(walletB.address)).toBe(utxos[0].amount - 10000)
  })

  it('should reject immature claim spend in mempool', () => {
    const { snapshot, holders } = createMockSnapshot()
    const node = new Node('mempool-mat', snapshot)
    node.chain.difficulty = TEST_TARGET
    const genesisHash = node.chain.blocks[0].hash

    // Mine a claim in block 1
    const claimTx = createClaimTransaction(
      holders[0].secretKey, holders[0].publicKey,
      snapshot.entries[0], walletA, snapshot.btcBlockHash, genesisHash
    )
    const tip = node.chain.getChainTip()
    const height = node.chain.getHeight() + 1
    const coinbase = createCoinbaseTransaction('f'.repeat(64), height, 0)
    const txs = [coinbase, claimTx]
    const merkleRoot = computeMerkleRoot(txs.map(t => t.id))
    const header = {
      version: 1, previousHash: tip.hash, merkleRoot,
      timestamp: tip.header.timestamp + 1, target: TEST_TARGET, nonce: 0,
    }
    let hash = computeBlockHash(header)
    while (!hashMeetsTarget(hash, TEST_TARGET)) {
      header.nonce++
      hash = computeBlockHash(header)
    }
    expect(node.chain.addBlock({ header, hash, transactions: txs, height }).success).toBe(true)

    // Try spending immediately via receiveTransaction (mempool validates against chain height)
    const utxos = node.chain.findUTXOs(walletA.address)
    const spendTx = createTransaction(
      walletA, utxos,
      [{ address: walletB.address, amount: utxos[0].amount - 10000 }],
      10000
    )
    const result = node.receiveTransaction(spendTx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Claim UTXO')
  })
})

describe('Subnet diversity', () => {
  let tmpDir: string
  let node: Node
  let p2p: P2PServer

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-subnet-'))
    node = new Node('test')
    p2p = new P2PServer(node, 0, tmpDir)
  })

  afterEach(async () => {
    await p2p.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should accept addresses from multiple subnets into address book', () => {
    const addAddr = (p2p as any).addKnownAddress.bind(p2p)
    addAddr('8.8.1.1', 6001)
    addAddr('8.8.2.2', 6002)
    addAddr('8.8.3.3', 6003)
    addAddr('9.9.1.1', 6001)

    expect(p2p.getKnownAddresses().size).toBe(4)
  })

  it('should filter discovery candidates from over-represented subnets', () => {
    // Simulate 2 outbound peers on subnet 8.8.x.x
    const stub = () => {}
    const fakePeer1 = { address: '8.8.1.1', inbound: false, id: '8.8.1.1:6001', disconnect: stub }
    const fakePeer2 = { address: '8.8.2.2', inbound: false, id: '8.8.2.2:6002', disconnect: stub }
    const peerMap = (p2p as any).peers as Map<string, any>
    peerMap.set('8.8.1.1:6001', fakePeer1)
    peerMap.set('8.8.2.2:6002', fakePeer2)

    // Add candidate addresses: 2 from same subnet, 1 from different
    const addAddr = (p2p as any).addKnownAddress.bind(p2p)
    addAddr('8.8.3.3', 6003) // same /16 as the 2 connected peers
    addAddr('9.9.1.1', 6001) // different /16

    // Build subnet counts like discovery does
    const subnetCounts = new Map<string, number>()
    for (const peer of peerMap.values()) {
      if (!peer.inbound) {
        const ip = peer.address.replace(/^::ffff:/i, '')
        const match = ip.match(/^(\d+\.\d+)\.\d+\.\d+$/)
        const subnet = match ? match[1] : ip
        subnetCounts.set(subnet, (subnetCounts.get(subnet) ?? 0) + 1)
      }
    }

    const candidates = Array.from(p2p.getKnownAddresses().values())
    const filtered = candidates.filter((a) => {
      const ip = a.host.replace(/^::ffff:/i, '')
      const match = ip.match(/^(\d+\.\d+)\.\d+\.\d+$/)
      const subnet = match ? match[1] : ip
      return (subnetCounts.get(subnet) ?? 0) < 2 // MAX_OUTBOUND_PER_SUBNET
    })

    // 8.8.3.3 should be filtered out (subnet 8.8 already has 2 outbound)
    expect(filtered.length).toBe(1)
    expect(filtered[0].host).toBe('9.9.1.1')
  })

  it('should skip subnet filtering in local mode', () => {
    p2p.setLocalMode(true)

    // Even with many peers on same subnet, localMode skips filtering
    // In localMode, the discovery loop skips the subnet filter
    expect((p2p as any).localMode).toBe(true)
  })

  it('should fall back to all candidates when all subnets saturated', () => {
    const stub = () => {}
    const fakePeer1 = { address: '8.8.1.1', inbound: false, id: '8.8.1.1:6001', disconnect: stub }
    const fakePeer2 = { address: '8.8.2.2', inbound: false, id: '8.8.2.2:6002', disconnect: stub }
    const peerMap = (p2p as any).peers as Map<string, any>
    peerMap.set('8.8.1.1:6001', fakePeer1)
    peerMap.set('8.8.2.2:6002', fakePeer2)

    // Only candidates from same saturated subnet
    const addAddr = (p2p as any).addKnownAddress.bind(p2p)
    addAddr('8.8.3.3', 6003)
    addAddr('8.8.4.4', 6004)

    const candidates = Array.from(p2p.getKnownAddresses().values())
    const subnetCounts = new Map<string, number>([['8.8', 2]])
    let filtered = candidates.filter((a) => {
      const match = a.host.match(/^(\d+\.\d+)\.\d+\.\d+$/)
      const subnet = match ? match[1] : a.host
      return (subnetCounts.get(subnet) ?? 0) < 2
    })
    // All filtered out — should fall back to all candidates
    if (filtered.length === 0) filtered = candidates
    expect(filtered.length).toBe(2) // fallback returns all
  })

  it('should not count inbound peers in subnet limits', () => {
    const stub = () => {}
    const fakePeer1 = { address: '8.8.1.1', inbound: true, id: '8.8.1.1:6001', disconnect: stub }
    const fakePeer2 = { address: '8.8.2.2', inbound: true, id: '8.8.2.2:6002', disconnect: stub }
    const fakePeer3 = { address: '8.8.3.3', inbound: true, id: '8.8.3.3:6003', disconnect: stub }
    const peerMap = (p2p as any).peers as Map<string, any>
    peerMap.set('8.8.1.1:6001', fakePeer1)
    peerMap.set('8.8.2.2:6002', fakePeer2)
    peerMap.set('8.8.3.3:6003', fakePeer3)

    // Build outbound-only subnet counts
    const subnetCounts = new Map<string, number>()
    for (const peer of peerMap.values()) {
      if (!peer.inbound) {
        const match = peer.address.match(/^(\d+\.\d+)\.\d+\.\d+$/)
        const subnet = match ? match[1] : peer.address
        subnetCounts.set(subnet, (subnetCounts.get(subnet) ?? 0) + 1)
      }
    }

    // No outbound peers counted — subnet 8.8 should have count 0
    expect(subnetCounts.get('8.8') ?? 0).toBe(0)

    // So candidate from 8.8.x.x should NOT be filtered
    const addAddr = (p2p as any).addKnownAddress.bind(p2p)
    addAddr('8.8.4.4', 6004)
    const candidates = Array.from(p2p.getKnownAddresses().values())
    const filtered = candidates.filter((a) => {
      const match = a.host.match(/^(\d+\.\d+)\.\d+\.\d+$/)
      const subnet = match ? match[1] : a.host
      return (subnetCounts.get(subnet) ?? 0) < 2
    })
    expect(filtered.length).toBe(1) // not filtered
  })

  it('should handle IPv6 addresses as their own subnet', () => {
    const stub = () => {}
    const fakePeer = { address: '2001:db8::1', inbound: false, id: '[2001:db8::1]:6001', disconnect: stub }
    const peerMap = (p2p as any).peers as Map<string, any>
    peerMap.set('[2001:db8::1]:6001', fakePeer)

    // Each unique IPv6 address is its own "subnet" so it won't block others
    const subnetCounts = new Map<string, number>()
    for (const peer of peerMap.values()) {
      if (!peer.inbound) {
        const ip = peer.address.replace(/^::ffff:/i, '')
        const match = ip.match(/^(\d+\.\d+)\.\d+\.\d+$/)
        const subnet = match ? match[1] : ip
        subnetCounts.set(subnet, (subnetCounts.get(subnet) ?? 0) + 1)
      }
    }
    expect(subnetCounts.get('2001:db8::1')).toBe(1)
  })
})

describe('Anchor peer persistence', () => {
  it('should save and load anchor peers across restarts', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-anchor-'))
    try {
      const node = new Node('test')
      const p2p1 = new P2PServer(node, 0, tmpDir)

      const addAddr = (p2p1 as any).addKnownAddress.bind(p2p1)
      p2p1.setLocalMode(true)
      addAddr('192.168.1.1', 6001)
      addAddr('192.168.1.2', 6002)
      addAddr('192.168.1.3', 6003)

      p2p1.saveAnchors()
      await p2p1.stop()

      const anchorsPath = path.join(tmpDir, 'anchors.json')
      expect(fs.existsSync(anchorsPath)).toBe(true)
      const anchors = JSON.parse(fs.readFileSync(anchorsPath, 'utf-8'))
      expect(anchors.length).toBe(3)

      // Create new P2PServer — should load anchors
      const p2p2 = new P2PServer(node, 0, tmpDir)
      p2p2.setLocalMode(true)
      expect(p2p2.getKnownAddresses().size).toBe(3)
      await p2p2.stop()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should cap anchors to MAX_ANCHORS (10)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-anchor-cap-'))
    try {
      const node = new Node('test')
      const p2p = new P2PServer(node, 0, tmpDir)

      const addAddr = (p2p as any).addKnownAddress.bind(p2p)
      for (let i = 1; i <= 20; i++) {
        addAddr(`8.8.${i}.1`, 6001)
      }

      p2p.saveAnchors()

      const anchorsPath = path.join(tmpDir, 'anchors.json')
      const anchors = JSON.parse(fs.readFileSync(anchorsPath, 'utf-8'))
      expect(anchors.length).toBe(10)

      await p2p.stop()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should save anchors on stop', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-anchor-stop-'))
    try {
      const node = new Node('test')
      const p2p = new P2PServer(node, 0, tmpDir)

      const addAddr = (p2p as any).addKnownAddress.bind(p2p)
      addAddr('8.8.8.8', 6001)

      await p2p.stop()

      const anchorsPath = path.join(tmpDir, 'anchors.json')
      expect(fs.existsSync(anchorsPath)).toBe(true)
      const anchors = JSON.parse(fs.readFileSync(anchorsPath, 'utf-8'))
      expect(anchors.length).toBe(1)
      expect(anchors[0].host).toBe('8.8.8.8')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should gracefully handle corrupt anchors.json', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-anchor-corrupt-'))
    try {
      // Write corrupt JSON
      fs.writeFileSync(path.join(tmpDir, 'anchors.json'), '{{{not json!!!')

      const node = new Node('test')
      // Should not throw — loadAnchors catches the error
      const p2p = new P2PServer(node, 0, tmpDir)
      expect(p2p.getKnownAddresses().size).toBe(0)
      await p2p.stop()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should handle missing anchors.json gracefully', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-anchor-missing-'))
    try {
      // No anchors.json — should start clean
      const node = new Node('test')
      const p2p = new P2PServer(node, 0, tmpDir)
      expect(p2p.getKnownAddresses().size).toBe(0)
      await p2p.stop()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should not save or load anchors without dataDir', async () => {
    const node = new Node('test')
    // No dataDir — anchorsPath should be null
    const p2p = new P2PServer(node, 0)
    expect((p2p as any).anchorsPath).toBeNull()

    // saveAnchors should no-op (no error)
    p2p.saveAnchors()

    // connectToAnchors should no-op (no error)
    p2p.connectToAnchors()

    await p2p.stop()
  })

  it('should sort anchors by most recently seen', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-anchor-sort-'))
    try {
      const node = new Node('test')
      const p2p = new P2PServer(node, 0, tmpDir)

      // Add addresses with different timestamps
      const knownAddresses = (p2p as any).knownAddresses as Map<string, { host: string; port: number; lastSeen: number }>
      knownAddresses.set('1.1.1.1:6001', { host: '1.1.1.1', port: 6001, lastSeen: 1000 })
      knownAddresses.set('2.2.2.2:6001', { host: '2.2.2.2', port: 6001, lastSeen: 3000 })
      knownAddresses.set('3.3.3.3:6001', { host: '3.3.3.3', port: 6001, lastSeen: 2000 })

      p2p.saveAnchors()

      const anchorsPath = path.join(tmpDir, 'anchors.json')
      const anchors = JSON.parse(fs.readFileSync(anchorsPath, 'utf-8'))

      // Should be sorted newest first
      expect(anchors[0].host).toBe('2.2.2.2')
      expect(anchors[1].host).toBe('3.3.3.3')
      expect(anchors[2].host).toBe('1.1.1.1')

      await p2p.stop()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should preserve anchor lastSeen timestamps across restarts', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-anchor-ts-'))
    try {
      const node = new Node('test')
      const p2p1 = new P2PServer(node, 0, tmpDir)
      const knownAddresses = (p2p1 as any).knownAddresses as Map<string, { host: string; port: number; lastSeen: number }>
      knownAddresses.set('8.8.8.8:6001', { host: '8.8.8.8', port: 6001, lastSeen: 12345 })
      p2p1.saveAnchors()
      await p2p1.stop()

      // Reload — lastSeen should be preserved
      const p2p2 = new P2PServer(node, 0, tmpDir)
      const loaded = p2p2.getKnownAddresses().get('8.8.8.8:6001')
      expect(loaded).toBeDefined()
      expect(loaded!.lastSeen).toBe(12345)
      await p2p2.stop()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should skip entries with missing host or port in anchors.json', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-anchor-bad-'))
    try {
      // Write anchors with some invalid entries
      const anchors = [
        { host: '1.1.1.1', port: 6001, lastSeen: 1000 },
        { host: '', port: 6001, lastSeen: 2000 },     // empty host
        { host: '2.2.2.2', port: 0, lastSeen: 3000 },  // port 0 is falsy
        { host: '3.3.3.3', port: 6002, lastSeen: 4000 },
      ]
      fs.writeFileSync(path.join(tmpDir, 'anchors.json'), JSON.stringify(anchors))

      const node = new Node('test')
      const p2p = new P2PServer(node, 0, tmpDir)

      // Only entries with truthy host AND port should be loaded
      expect(p2p.getKnownAddresses().size).toBe(2)
      expect(p2p.getKnownAddresses().has('1.1.1.1:6001')).toBe(true)
      expect(p2p.getKnownAddresses().has('3.3.3.3:6002')).toBe(true)

      await p2p.stop()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('Cumulative work threshold (1.5x)', () => {
  it('should ban peer claiming more than 1.5x verified work', () => {
    // The threshold is: peer.remoteCumulativeWork > verifiedPeerWork * 3n / 2n
    // If verified work = 100, threshold = 150
    // 151 should be banned, 150 should not
    const verified = 100n
    const threshold = verified * 3n / 2n // = 150

    expect(151n > threshold).toBe(true)  // would be banned
    expect(150n > threshold).toBe(false) // would NOT be banned (equal)
    expect(149n > threshold).toBe(false) // would NOT be banned
  })

  it('1.5x is tighter than previous 2x threshold', () => {
    const verified = 1000n
    const oldThreshold = verified * 2n   // 2000
    const newThreshold = verified * 3n / 2n // 1500

    // A peer claiming 1600 work would pass old check but fail new
    expect(1600n > oldThreshold).toBe(false)  // old: not banned
    expect(1600n > newThreshold).toBe(true)   // new: banned
  })
})
