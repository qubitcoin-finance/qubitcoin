import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Node } from '../node.js'
import { startRpcServer } from '../rpc.js'
import { walletA, walletB } from './fixtures.js'
import { createMockSnapshot } from '../snapshot.js'
import { createClaimTransaction } from '../claim.js'
import { createTransaction, utxoKey } from '../transaction.js'
import { sanitizeForStorage, FileBlockStorage } from '../storage.js'
import { P2PServer } from '../p2p/server.js'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

describe('RPC endpoints', () => {
  let node: Node
  let server: Server
  let baseUrl: string

  beforeAll(() => {
    node = new Node('rpc-test')
    node.chain.difficulty = TEST_TARGET

    // Mine 3 blocks so we have data to query
    for (let i = 0; i < 3; i++) {
      node.mine(walletA.address, false)
    }

    const app = startRpcServer(node, 0)
    server = app.listen(0)
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(() => {
    server.close()
  })

  it('GET /block/:hash returns block by hash', async () => {
    const genesisHash = node.chain.blocks[0].hash
    const res = await fetch(`${baseUrl}/api/v1/block/${genesisHash}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.hash).toBe(genesisHash)
    expect(body.height).toBe(0)
  })

  it('GET /block/:hash returns 404 for unknown hash', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block/${'f'.repeat(64)}`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('not found')
  })

  it('GET /block/:hash rejects invalid hash format', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block/invalidhash`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid block hash format')
  })

  it('GET /block/:hash rejects non-hex characters', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block/${'g'.repeat(64)}`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid block hash format')
  })

  it('GET /block/:hash rejects too-short hash', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block/${'a'.repeat(63)}`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid block hash format')
  })

  it('GET /block/:hash rejects too-long hash', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block/${'a'.repeat(65)}`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid block hash format')
  })

  it('GET /block-by-height/:h returns block by height', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block-by-height/1`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.height).toBe(1)
  })

  it('GET /block-by-height/:h returns 404 for out-of-range height', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block-by-height/999`)
    expect(res.status).toBe(404)
  })

  it('GET /block-by-height/:h returns 400 for non-integer height', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block-by-height/abc`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('non-negative integer')
  })

  it('GET /tx/:txid returns 404 for unknown txid', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx/${'a'.repeat(64)}`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('not found')
  })

  it('GET /tx/:txid rejects invalid txid format', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx/notahash`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid transaction ID format')
  })

  it('GET /tx/:txid rejects non-hex characters', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx/${'g'.repeat(64)}`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid transaction ID format')
  })

  it('GET /tx/:txid rejects too-short txid', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx/${'a'.repeat(63)}`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid transaction ID format')
  })

  it('GET /tx/:txid rejects too-long txid', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx/${'a'.repeat(65)}`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid transaction ID format')
  })

  it('GET /tx/:txid returns coinbase tx from chain', async () => {
    const coinbaseTxId = node.chain.blocks[1].transactions[0].id
    const res = await fetch(`${baseUrl}/api/v1/tx/${coinbaseTxId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(coinbaseTxId)
  })

  it('POST /tx rejects malformed body', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('GET /mempool/stats returns size', async () => {
    const res = await fetch(`${baseUrl}/api/v1/mempool/stats`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.size).toBe('number')
    expect(body.size).toBe(0)
  })

  it('GET /address/:addr/balance returns balance', async () => {
    const res = await fetch(`${baseUrl}/api/v1/address/${walletA.address}/balance`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.balance).toBe('number')
    expect(body.balance).toBeGreaterThan(0)
  })

  it('GET /claims/stats returns object', async () => {
    const res = await fetch(`${baseUrl}/api/v1/claims/stats`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body).toBe('object')
    expect(typeof body.claimed).toBe('number')
  })

  it('GET /peers returns empty array when no p2pServer', async () => {
    const res = await fetch(`${baseUrl}/api/v1/peers`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(0)
  })

  it('GET /address/:addr/utxos returns UTXOs', async () => {
    const res = await fetch(`${baseUrl}/api/v1/address/${walletA.address}/utxos`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
    expect(body[0]).toHaveProperty('txId')
    expect(body[0]).toHaveProperty('amount')
  })

  it('GET /address/:addr/utxos returns empty array for unknown address', async () => {
    const res = await fetch(`${baseUrl}/api/v1/address/${'f'.repeat(64)}/utxos`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(0)
  })

  it('GET /address/:addr/balance normalizes uppercase address to return correct balance', async () => {
    const upperAddr = walletA.address.toUpperCase()
    const res = await fetch(`${baseUrl}/api/v1/address/${upperAddr}/balance`)
    expect(res.status).toBe(200)
    const body = await res.json()
    // Uppercase address must resolve to same balance as lowercase — not silently return 0
    expect(body.balance).toBeGreaterThan(0)
  })

  it('GET /address/:addr/utxos normalizes uppercase address to return UTXOs', async () => {
    const upperAddr = walletA.address.toUpperCase()
    const res = await fetch(`${baseUrl}/api/v1/address/${upperAddr}/utxos`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    // Uppercase address must resolve to the same UTXOs as lowercase — not silently return []
    expect(body.length).toBeGreaterThan(0)
  })

  it('GET /address/:addr/balance rejects invalid address format', async () => {
    const res = await fetch(`${baseUrl}/api/v1/address/invalidaddr/balance`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid address format')
  })

  it('GET /address/:addr/balance rejects non-hex characters', async () => {
    const res = await fetch(`${baseUrl}/api/v1/address/${'g'.repeat(64)}/balance`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid address format')
  })

  it('GET /address/:addr/balance rejects too-short address', async () => {
    const res = await fetch(`${baseUrl}/api/v1/address/${'a'.repeat(63)}/balance`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid address format')
  })

  it('GET /address/:addr/utxos rejects invalid address format', async () => {
    const res = await fetch(`${baseUrl}/api/v1/address/not-hex/utxos`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid address format')
  })

  it('GET /address/:addr/utxos rejects too-long address', async () => {
    const res = await fetch(`${baseUrl}/api/v1/address/${'a'.repeat(65)}/utxos`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid address format')
  })

  it('GET /status returns node state', async () => {
    const res = await fetch(`${baseUrl}/api/v1/status`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.height).toBe(3)
    expect(typeof body.hashrate).toBe('number')
    expect(typeof body.mempoolSize).toBe('number')
    expect(typeof body.utxoCount).toBe('number')
    expect(typeof body.cumulativeWork).toBe('string')
  })

  it('GET /blocks returns latest blocks with count cap', async () => {
    const res = await fetch(`${baseUrl}/api/v1/blocks?count=2`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(2)
    // Should be in reverse order (newest first)
    expect(body[0].height).toBeGreaterThan(body[1].height)
  })

  it('GET /blocks returns 400 for NaN count', async () => {
    const res = await fetch(`${baseUrl}/api/v1/blocks?count=abc`)
    expect(res.status).toBe(400)
  })

  it('GET /difficulty returns difficulty history', async () => {
    const res = await fetch(`${baseUrl}/api/v1/difficulty`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
    expect(body[0]).toHaveProperty('height')
    expect(body[0]).toHaveProperty('target')
  })
})

describe('RPC transaction endpoints', () => {
  let node: Node
  let server: Server
  let baseUrl: string

  beforeAll(() => {
    const { snapshot, holders } = createMockSnapshot()
    node = new Node('rpc-tx-test', snapshot)
    node.chain.difficulty = TEST_TARGET

    // Mine blocks for data
    for (let i = 0; i < 3; i++) {
      node.mine(walletA.address, false)
    }

    const app = startRpcServer(node, 0)
    server = app.listen(0)
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(() => {
    server.close()
  })

  it('GET /tx/:txid finds transaction in mempool', async () => {
    // Add a claim tx to the mempool
    const { snapshot, holders } = createMockSnapshot()
    const genesisHash = node.chain.blocks[0].hash
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash,
      genesisHash
    )

    node.receiveTransaction(claimTx)

    const res = await fetch(`${baseUrl}/api/v1/tx/${claimTx.id}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(claimTx.id)
  })

  it('GET /mempool/txs returns transaction summaries', async () => {
    const res = await fetch(`${baseUrl}/api/v1/mempool/txs`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
  })

  it('GET /mempool/txs regular tx derives sender and strips signature fields', async () => {
    const utxo = {
      txId: 'd'.repeat(64),
      outputIndex: 0,
      address: walletA.address,
      amount: 75_000_000,
    }
    node.chain.utxoSet.set(utxoKey(utxo.txId, utxo.outputIndex), utxo)
    const tx = createTransaction(
      walletA,
      [utxo],
      [{ address: walletB.address, amount: 50_000_000 }],
      10_000
    )
    const addResult = node.receiveTransaction(tx)
    expect(addResult.success).toBe(true)

    const res = await fetch(`${baseUrl}/api/v1/mempool/txs`)
    expect(res.status).toBe(200)
    const body = await res.json()
    const entry = body.find((candidate: { id: string }) => candidate.id === tx.id)

    expect(entry).toBeDefined()
    expect(entry.id).toBe(tx.id)
    expect(entry.timestamp).toBe(tx.timestamp)
    expect(entry.sender).toBe(walletA.address)
    expect(entry.claimData).toBeUndefined()
    expect(entry.inputs).toEqual(
      tx.inputs.map(input => ({ txId: input.txId, outputIndex: input.outputIndex }))
    )
    expect(entry.outputs).toEqual(tx.outputs)
    expect(entry.inputs[0]).not.toHaveProperty('publicKey')
    expect(entry.inputs[0]).not.toHaveProperty('signature')
  })

  it('GET /mempool/txs claim tx has null sender and defined claimData', async () => {
    const { snapshot, holders } = createMockSnapshot()
    const genesisHash = node.chain.blocks[0].hash
    const claimTx = createClaimTransaction(
      holders[2].secretKey,
      holders[2].publicKey,
      snapshot.entries[2],
      walletB,
      snapshot.btcBlockHash,
      genesisHash
    )
    node.receiveTransaction(claimTx)

    const res = await fetch(`${baseUrl}/api/v1/mempool/txs`)
    expect(res.status).toBe(200)
    const body = await res.json()
    const claimEntry = body.find((tx: { id: string; claimData?: unknown }) => tx.id === claimTx.id)
    expect(claimEntry).toBeDefined()
    expect(claimEntry.sender).toBeNull()
    expect(typeof claimEntry.claimData).toBe('object')
  })

  it('GET /mempool/txs claim tx keeps outpoints but strips binary input fields', async () => {
    const { snapshot, holders } = createMockSnapshot()
    const genesisHash = node.chain.blocks[0].hash
    const claimTx = createClaimTransaction(
      holders[3].secretKey,
      holders[3].publicKey,
      snapshot.entries[3],
      walletB,
      snapshot.btcBlockHash,
      genesisHash
    )
    const addResult = node.receiveTransaction(claimTx)
    expect(addResult.success).toBe(true)

    const res = await fetch(`${baseUrl}/api/v1/mempool/txs`)
    expect(res.status).toBe(200)
    const body = await res.json()
    const claimEntry = body.find((tx: { id: string }) => tx.id === claimTx.id)

    expect(claimEntry).toBeDefined()
    expect(claimEntry.inputs).toEqual(
      claimTx.inputs.map(input => ({ txId: input.txId, outputIndex: input.outputIndex }))
    )
    expect(claimEntry.inputs[0]).not.toHaveProperty('publicKey')
    expect(claimEntry.inputs[0]).not.toHaveProperty('signature')
  })

  it('POST /tx with valid claim transaction returns 200 with txid', async () => {
    const { snapshot, holders } = createMockSnapshot()
    const genesisHash = node.chain.blocks[0].hash
    // Use holders[1] — holders[0] is already pending in mempool from the earlier test
    const claimTx = createClaimTransaction(
      holders[1].secretKey,
      holders[1].publicKey,
      snapshot.entries[1],
      walletB,
      snapshot.btcBlockHash,
      genesisHash
    )
    const body = sanitizeForStorage(claimTx)

    const res = await fetch(`${baseUrl}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.txid).toBe(claimTx.id)
  })
})

describe('RPC edge cases', () => {
  let node: Node
  let server: Server
  let baseUrl: string

  beforeAll(() => {
    node = new Node('rpc-edge-test')
    node.chain.difficulty = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

    // Mine enough blocks to test pagination cap (>100)
    for (let i = 0; i < 3; i++) {
      node.mine(walletA.address, false)
    }

    const app = startRpcServer(node, 0)
    server = app.listen(0)
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(() => {
    server.close()
  })

  // GET /blocks edge cases
  it('GET /blocks?count=0 returns empty array', async () => {
    const res = await fetch(`${baseUrl}/api/v1/blocks?count=0`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(0)
  })

  it('GET /blocks?count=-1 returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/blocks?count=-1`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid count parameter')
  })

  it('GET /blocks?count=200 caps at 100', async () => {
    // Mine additional blocks to go over 100 total (start from 4, need ~100 more)
    const extraNode = new Node('rpc-cap-test')
    // Reset difficulty before each mine to prevent the every-10-block adjustment
    // from ratcheting the target to infeasible levels when blocks have ~0ms timestamps.
    const EASY_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    for (let i = 0; i < 105; i++) {
      extraNode.chain.difficulty = EASY_TARGET
      extraNode.mine(walletA.address, false)
    }
    const extraApp = startRpcServer(extraNode, 0)
    const extraServer = extraApp.listen(0)
    const extraAddr = extraServer.address() as AddressInfo
    const extraUrl = `http://127.0.0.1:${extraAddr.port}`

    const res = await fetch(`${extraUrl}/api/v1/blocks?count=200`)
    extraServer.close()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(100)
  })

  it('GET /blocks without count defaults to 10', async () => {
    const res = await fetch(`${baseUrl}/api/v1/blocks`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    // 3 mined + 1 genesis = 4 blocks total, all returned when default (10) > chain length
    expect(body.length).toBe(4)
  })

  // GET /block-by-height edge cases
  it('GET /block-by-height/-1 returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block-by-height/-1`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('non-negative integer')
  })

  it('GET /block-by-height/0 returns genesis block', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block-by-height/0`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.height).toBe(0)
  })

  it('GET /block-by-height/1abc returns 400 (not block 1)', async () => {
    // parseInt("1abc", 10) === 1, so without the regex guard this would
    // silently return block 1 instead of rejecting the malformed request.
    const res = await fetch(`${baseUrl}/api/v1/block-by-height/1abc`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('non-negative integer')
  })

  it('GET /block-by-height/:height beyond chain length returns 404', async () => {
    const beyondTip = node.chain.blocks.length
    const res = await fetch(`${baseUrl}/api/v1/block-by-height/${beyondTip}`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('not found')
  })

  it('GET /block-by-height/:height rejects values exceeding INT32 max', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block-by-height/2147483648`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('too large')
  })

  it('GET /blocks?count=100abc returns 400 (not 100 blocks)', async () => {
    // parseInt("100abc", 10) === 100, so without the regex guard this would
    // silently use 100 instead of rejecting the malformed parameter.
    const res = await fetch(`${baseUrl}/api/v1/blocks?count=100abc`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid count parameter')
  })

  // GET /mempool/txs limit edge cases
  it('GET /mempool/txs?limit=0 returns empty array', async () => {
    const { snapshot } = createMockSnapshot()
    const limitNode = new Node('rpc-limit-test', snapshot)
    limitNode.chain.difficulty = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    limitNode.mine(walletA.address, false)
    // Add a claim tx to mempool
    const { holders } = createMockSnapshot()
    const genesisHash = limitNode.chain.blocks[0].hash
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash,
      genesisHash
    )
    limitNode.receiveTransaction(claimTx)

    const limitApp = startRpcServer(limitNode, 0)
    const limitServer = limitApp.listen(0)
    const limitAddr = limitServer.address() as AddressInfo
    const limitUrl = `http://127.0.0.1:${limitAddr.port}`

    const res = await fetch(`${limitUrl}/api/v1/mempool/txs?limit=0`)
    limitServer.close()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(0)
  })

  it('GET /mempool/txs?limit=2000 caps at 1000', async () => {
    const res = await fetch(`${baseUrl}/api/v1/mempool/txs?limit=2000`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    // mempool is empty so 0 results, but we can verify no crash
    expect(body.length).toBe(0)
  })

  it('GET /mempool/txs?limit=abc returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/mempool/txs?limit=abc`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid limit parameter')
  })

  it('GET /mempool/txs?limit=-1 returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/mempool/txs?limit=-1`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid limit parameter')
  })

  it('GET /mempool/txs?limit=100abc returns 400 (not 100 results)', async () => {
    // parseInt("100abc", 10) === 100 — without regex guard this would silently use 100
    const res = await fetch(`${baseUrl}/api/v1/mempool/txs?limit=100abc`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid limit parameter')
  })

  // POST /tx edge cases
  it('POST /tx with valid-structure transaction but non-existent UTXOs returns 400', async () => {
    // Build a transaction spending a UTXO that does not exist in the chain
    const fakeTx = createTransaction(
      walletA,
      [{ txId: 'dead'.repeat(16), outputIndex: 0, address: walletA.address, amount: 1_000_000 }],
      [{ address: walletB.address, amount: 900_000 }],
      100_000
    )
    const body = sanitizeForStorage(fakeTx)

    const res = await fetch(`${baseUrl}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(typeof json.error).toBe('string')
  })

  it('POST /tx with non-object body returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify('not-an-object'),
    })
    expect(res.status).toBe(400)
  })

  it('POST /tx with array body returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([]),
    })
    expect(res.status).toBe(400)
  })

  it('POST /tx with malformed JSON returns JSON error payload', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.error).toBe('Malformed JSON request body')
  })

  it('POST /tx with oversized JSON body returns 413 JSON error payload', async () => {
    const largeBody = `"${'a'.repeat(1_100_000)}"`
    const res = await fetch(`${baseUrl}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: largeBody,
    })
    expect(res.status).toBe(413)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.error).toBe('Request body too large')
  })

  it('GET unknown /api/v1 route returns JSON 404 payload', async () => {
    const res = await fetch(`${baseUrl}/api/v1/does-not-exist`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.error).toBe('RPC endpoint not found')
  })

  it('POST to GET-only RPC route returns JSON 404 payload', async () => {
    const res = await fetch(`${baseUrl}/api/v1/status`, {
      method: 'POST',
    })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.error).toBe('RPC endpoint not found')
  })
})

describe('RPC /difficulty endpoint edge cases', () => {
  it('genesis-only chain returns exactly one entry', async () => {
    const node = new Node('rpc-diff-genesis')
    const app = startRpcServer(node, 0)
    const srv = app.listen(0)
    const addr = srv.address() as AddressInfo
    const url = `http://127.0.0.1:${addr.port}`
    try {
      const res = await fetch(`${url}/api/v1/difficulty`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(Array.isArray(body)).toBe(true)
      expect(body.length).toBe(1)
      expect(body[0].height).toBe(0)
    } finally {
      srv.close()
    }
  })

  it('chain at exact adjustment boundary does not duplicate the tip', async () => {
    const { DIFFICULTY_ADJUSTMENT_INTERVAL } = await import('../block.js')
    const node = new Node('rpc-diff-boundary')
    node.chain.difficulty = TEST_TARGET
    for (let i = 0; i < DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      node.mine('f'.repeat(64), false)
    }
    expect(node.chain.getHeight()).toBe(DIFFICULTY_ADJUSTMENT_INTERVAL)

    const app = startRpcServer(node, 0)
    const srv = app.listen(0)
    const addr = srv.address() as AddressInfo
    const url = `http://127.0.0.1:${addr.port}`
    try {
      const res = await fetch(`${url}/api/v1/difficulty`)
      expect(res.status).toBe(200)
      const body = await res.json()
      const heights: number[] = body.map((e: { height: number }) => e.height)
      // genesis (0) + adjustment block (DIFFICULTY_ADJUSTMENT_INTERVAL); tip must not be duplicated
      expect(heights.filter(h => h === DIFFICULTY_ADJUSTMENT_INTERVAL).length).toBe(1)
    } finally {
      srv.close()
    }
  })

  it('chain past adjustment boundary includes genesis, adjustment point, and tip', async () => {
    const { DIFFICULTY_ADJUSTMENT_INTERVAL } = await import('../block.js')
    const node = new Node('rpc-diff-past-boundary')
    node.chain.difficulty = TEST_TARGET
    for (let i = 0; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      node.chain.difficulty = TEST_TARGET
      node.mine('f'.repeat(64), false)
    }
    const tipHeight = node.chain.getHeight()
    expect(tipHeight).toBe(DIFFICULTY_ADJUSTMENT_INTERVAL + 1)

    const app = startRpcServer(node, 0)
    const srv = app.listen(0)
    const addr = srv.address() as AddressInfo
    const url = `http://127.0.0.1:${addr.port}`
    try {
      const res = await fetch(`${url}/api/v1/difficulty`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(Array.isArray(body)).toBe(true)
      const heights: number[] = body.map((e: { height: number }) => e.height)
      expect(heights[0]).toBe(0) // genesis
      expect(heights).toContain(DIFFICULTY_ADJUSTMENT_INTERVAL) // adjustment point
      expect(heights[heights.length - 1]).toBe(tipHeight) // current tip
    } finally {
      srv.close()
    }
  })
})

describe('RPC rate limiting', () => {
  it('POST /tx is rate-limited at 100 requests/min per IP', async () => {
    const node = new Node('rpc-rate-post-test')
    const app = startRpcServer(node, 0)
    const server = app.listen(0)
    const addr = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${addr.port}`

    try {
      // Send 101 POST requests concurrently from the same IP.
      // After 100 accepted requests, the 101st must be rejected with 429.
      const responses = await Promise.all(
        Array.from({ length: 101 }, () =>
          fetch(`${baseUrl}/api/v1/tx`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          })
        )
      )
      const statuses = responses.map(r => r.status)
      // Most responses will be 400 (invalid tx body), at least one must be 429
      expect(statuses.filter(s => s === 429).length).toBeGreaterThanOrEqual(1)
    } finally {
      server.close()
    }
  })

  it('GET /status is rate-limited independently at 600 requests/min per IP', async () => {
    const node = new Node('rpc-rate-get-test')
    const app = startRpcServer(node, 0)
    const server = app.listen(0)
    const addr = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${addr.port}`

    try {
      const responses = await Promise.all(
        Array.from({ length: 601 }, () => fetch(`${baseUrl}/api/v1/status`))
      )
      const statuses = responses.map(r => r.status)
      expect(statuses.filter(s => s === 429).length).toBeGreaterThanOrEqual(1)
      expect(statuses.filter(s => s === 200).length).toBeGreaterThanOrEqual(600)
    } finally {
      server.close()
    }
  })

  it('GET traffic does not consume the stricter POST rate-limit bucket', async () => {
    const node = new Node('rpc-rate-isolation-test')
    const app = startRpcServer(node, 0)
    const server = app.listen(0)
    const addr = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${addr.port}`

    try {
      const getResponses = await Promise.all(
        Array.from({ length: 600 }, () => fetch(`${baseUrl}/api/v1/status`))
      )
      expect(getResponses.every(r => r.status === 200)).toBe(true)

      const postRes = await fetch(`${baseUrl}/api/v1/tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(postRes.status).toBe(400)
    } finally {
      server.close()
    }
  })
})

describe('RPC with p2pServer', () => {
  it('GET /status includes peers count from p2pServer', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-rpc-status-'))
    try {
      const storage = new FileBlockStorage(tmpDir)
      const n = new Node('rpc-status-p2p-test', undefined, storage)
      const p2p = new P2PServer(n, 0, tmpDir)
      await p2p.start()

      const app = startRpcServer(n, 0, p2p)
      const srv = app.listen(0)
      const addr = srv.address() as AddressInfo
      const url = `http://127.0.0.1:${addr.port}`

      try {
        const res = await fetch(`${url}/api/v1/status`)
        expect(res.status).toBe(200)
        const body = await res.json()
        // peers field must be present and numeric (0 — no connected peers yet)
        expect(typeof body.peers).toBe('number')
        expect(body.peers).toBe(0)
      } finally {
        srv.close()
        await p2p.stop()
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
    }
  })

  it('GET /peers filters out localhost peers when p2pServer is provided', async () => {
    const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-rpc-peers1-'))
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-rpc-peers2-'))
    try {
      const n1 = new Node('rpc-peers-test-1', undefined, new FileBlockStorage(tmpDir1))
      const p2p1 = new P2PServer(n1, 0, tmpDir1)
      p2p1.setLocalMode(true) // allow private IPs in address book for this test
      await p2p1.start()
      const p2pPort = p2p1.getPort()

      const n2 = new Node('rpc-peers-test-2', undefined, new FileBlockStorage(tmpDir2))
      const p2p2 = new P2PServer(n2, 0, tmpDir2)
      p2p2.setLocalMode(true)
      await p2p2.start()

      // Connect node2 → node1 and wait for handshake
      p2p2.connectOutbound('127.0.0.1', p2pPort)
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 5_000
        const check = () => {
          if (p2p1.getPeers().length > 0) return resolve()
          if (Date.now() > deadline) return reject(new Error('handshake timeout'))
          setTimeout(check, 20)
        }
        setTimeout(check, 20)
      })

      const app = startRpcServer(n1, 0, p2p1)
      const srv = app.listen(0)
      const addr = srv.address() as AddressInfo
      const url = `http://127.0.0.1:${addr.port}`

      try {
        const res = await fetch(`${url}/api/v1/peers`)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(Array.isArray(body)).toBe(true)
        // The connected peer is on 127.0.0.1, so it must be filtered out
        expect(body.length).toBe(0)
      } finally {
        srv.close()
        await p2p1.stop()
        await p2p2.stop()
      }
    } finally {
      fs.rmSync(tmpDir1, { recursive: true })
      fs.rmSync(tmpDir2, { recursive: true })
    }
  })
})
