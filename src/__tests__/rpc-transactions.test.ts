import { it, expect, afterEach, beforeEach } from 'vitest'
import { Node } from '../node.js'
import { startRpcServer } from '../rpc.js'
import { walletA, walletB, walletC } from './fixtures.js'
import { createMockSnapshot } from '../snapshot.js'
import { createClaimTransaction } from '../claim.js'
import { createTransaction, utxoKey } from '../transaction.js'
import { sanitizeForStorage } from '../storage.js'
import { TEST_TARGET, describeLoopbackTcp, listenOnLoopback } from './rpc-test-helpers.js'
import type { Server } from 'node:http'

describeLoopbackTcp('RPC transaction endpoints', () => {
  let node: Node
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    const { snapshot, holders } = createMockSnapshot()
    node = new Node('rpc-tx-test', snapshot)
    node.chain.difficulty = TEST_TARGET

    // Mine blocks for data
    for (let i = 0; i < 3; i++) {
      node.mine(walletA.address, false)
    }

    const app = startRpcServer(node, 0)
    server = app.listen(0, '127.0.0.1')
    const addr = await listenOnLoopback(server)
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterEach(() => {
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
    expect(body.blockHash).toBeUndefined()
    expect(body.blockHeight).toBeUndefined()
  })

  it('GET /tx/:txid mempool tx has no confirmations field', async () => {
    const { snapshot, holders } = createMockSnapshot()
    const genesisHash = node.chain.blocks[0].hash
    const claimTx = createClaimTransaction(
      holders[4].secretKey,
      holders[4].publicKey,
      snapshot.entries[4],
      walletB,
      snapshot.btcBlockHash,
      genesisHash
    )
    node.receiveTransaction(claimTx)
    const res = await fetch(`${baseUrl}/api/v1/tx/${claimTx.id}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.confirmations).toBeUndefined()
  })

  it('POST /tx strips client-supplied confirmation metadata from mempool tx responses', async () => {
    const utxo = {
      txId: 'e'.repeat(64),
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
    const payload = {
      ...(sanitizeForStorage(tx) as Record<string, unknown>),
      blockHash: 'f'.repeat(64),
      blockHeight: 123,
    }

    const postRes = await fetch(`${baseUrl}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(postRes.status).toBe(200)

    const getRes = await fetch(`${baseUrl}/api/v1/tx/${tx.id}`)
    expect(getRes.status).toBe(200)
    const body = await getRes.json()
    expect(body.id).toBe(tx.id)
    expect(body.blockHash).toBeUndefined()
    expect(body.blockHeight).toBeUndefined()
    expect(body.confirmations).toBeUndefined()
  })

  it('GET /tx/:txid confirmed regular tx overwrites client-supplied confirmation metadata', async () => {
    const utxo = {
      txId: 'c'.repeat(64),
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
    const payload = {
      ...(sanitizeForStorage(tx) as Record<string, unknown>),
      blockHash: 'f'.repeat(64),
      blockHeight: 999_999,
      confirmations: 123_456,
    }

    const postRes = await fetch(`${baseUrl}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(postRes.status).toBe(200)

    const minedBlock = node.mine(walletA.address, false)
    expect(minedBlock).toBeTruthy()
    node.mine(walletA.address, false)

    const txBlock = node.chain.findTransactionBlock(tx.id)
    expect(txBlock).toBeTruthy()

    const getRes = await fetch(`${baseUrl}/api/v1/tx/${tx.id}`)
    expect(getRes.status).toBe(200)
    const body = await getRes.json()
    expect(body.id).toBe(tx.id)
    expect(body.blockHash).toBe(txBlock!.hash)
    expect(body.blockHeight).toBe(txBlock!.height)
    expect(body.confirmations).toBe(node.chain.blocks.length - txBlock!.height)
    expect(body.confirmations).toBe(2)
  })

  it('GET /mempool/txs returns transaction summaries', async () => {
    const utxo = {
      txId: 'b'.repeat(64),
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

  it('GET /mempool/txs returns claim-first then regular txs by fee density', async () => {
    const lowFeeUtxo = {
      txId: '1'.repeat(64),
      outputIndex: 0,
      address: walletA.address,
      amount: 75_000_000,
    }
    const highFeeUtxo = {
      txId: '2'.repeat(64),
      outputIndex: 0,
      address: walletB.address,
      amount: 75_000_000,
    }
    node.chain.utxoSet.set(utxoKey(lowFeeUtxo.txId, lowFeeUtxo.outputIndex), lowFeeUtxo)
    node.chain.utxoSet.set(utxoKey(highFeeUtxo.txId, highFeeUtxo.outputIndex), highFeeUtxo)

    const lowFeeTx = createTransaction(
      walletA,
      [lowFeeUtxo],
      [{ address: walletC.address, amount: 50_000_000 }],
      10_000
    )
    const highFeeTx = createTransaction(
      walletB,
      [highFeeUtxo],
      [{ address: walletC.address, amount: 50_000_000 }],
      100_000
    )
    expect(node.receiveTransaction(lowFeeTx).success).toBe(true)
    expect(node.receiveTransaction(highFeeTx).success).toBe(true)

    const { snapshot, holders } = createMockSnapshot()
    const genesisHash = node.chain.blocks[0].hash
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletC,
      snapshot.btcBlockHash,
      genesisHash
    )
    expect(node.receiveTransaction(claimTx).success).toBe(true)

    const res = await fetch(`${baseUrl}/api/v1/mempool/txs`)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.map((entry: { id: string }) => entry.id)).toEqual([
      claimTx.id,
      highFeeTx.id,
      lowFeeTx.id,
    ])
  })

  it('POST /tx with valid claim transaction returns 200 with txid', async () => {
    const { snapshot, holders } = createMockSnapshot()
    const genesisHash = node.chain.blocks[0].hash
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
