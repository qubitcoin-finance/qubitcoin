import { describe, it, expect } from 'vitest'
import {
  blockSubsidy,
  createCoinbaseTransaction,
  createTransaction,
  validateTransaction,
  isCoinbase,
  isClaimTransaction,
  calculateFee,
  utxoKey,
  HALVING_INTERVAL,
  COINBASE_TXID,
  CLAIM_TXID,
  type Transaction,
  type UTXO,
} from '../transaction.js'
import { deriveAddress } from '../crypto.js'
import { walletA, walletB } from './fixtures.js'

describe('blockSubsidy', () => {
  it('returns 3.125 at height 0', () => {
    expect(blockSubsidy(0)).toBe(3.125)
  })

  it('returns 3.125 before first halving', () => {
    expect(blockSubsidy(HALVING_INTERVAL - 1)).toBe(3.125)
  })

  it('halves at 210,000', () => {
    expect(blockSubsidy(HALVING_INTERVAL)).toBe(1.5625)
  })

  it('halves again at 420,000', () => {
    expect(blockSubsidy(HALVING_INTERVAL * 2)).toBe(0.78125)
  })

  it('reaches 0 after 26 halvings', () => {
    expect(blockSubsidy(HALVING_INTERVAL * 26)).toBe(0)
  })
})

describe('createCoinbaseTransaction', () => {
  it('creates correct coinbase', () => {
    const addr = '0'.repeat(64)
    const tx = createCoinbaseTransaction(addr, 0, 5)
    expect(isCoinbase(tx)).toBe(true)
    expect(tx.outputs.length).toBe(1)
    expect(tx.outputs[0].amount).toBe(8.125) // 3.125 subsidy + 5 fees
    expect(tx.outputs[0].address).toBe(addr)
    expect(tx.id.length).toBe(64)
  })

  it('has correct input structure', () => {
    const tx = createCoinbaseTransaction('a'.repeat(64), 1, 0)
    expect(tx.inputs[0].txId).toBe(COINBASE_TXID)
    expect(tx.inputs[0].outputIndex).toBe(0xffffffff)
  })
})

describe('createTransaction', () => {
  it('creates a properly signed transaction', () => {
    const wallet = walletA
    const utxos: UTXO[] = [
      { txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: 100 },
    ]
    const tx = createTransaction(
      wallet,
      utxos,
      [{ address: 'b'.repeat(64), amount: 30 }],
      1
    )

    expect(tx.inputs.length).toBe(1)
    expect(tx.outputs.length).toBe(2) // recipient + change
    expect(tx.outputs[0].amount).toBe(30)
    expect(tx.outputs[1].amount).toBe(69) // 100 - 30 - 1 fee
    expect(tx.id.length).toBe(64)
  })

  it('throws on insufficient funds', () => {
    const wallet = walletA
    const utxos: UTXO[] = [
      { txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: 10 },
    ]
    expect(() =>
      createTransaction(wallet, utxos, [{ address: 'b'.repeat(64), amount: 100 }], 1)
    ).toThrow('Insufficient funds')
  })

  it('omits change output when exact amount', () => {
    const wallet = walletA
    const utxos: UTXO[] = [
      { txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: 51 },
    ]
    const tx = createTransaction(
      wallet,
      utxos,
      [{ address: 'b'.repeat(64), amount: 50 }],
      1
    )
    expect(tx.outputs.length).toBe(1)
  })
})

describe('validateTransaction', () => {
  it('validates a valid transaction', () => {
    const wallet = walletA
    const utxoId = 'a'.repeat(64)
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(utxoId, 0), {
      txId: utxoId,
      outputIndex: 0,
      address: wallet.address,
      amount: 100,
    })

    const tx = createTransaction(
      wallet,
      [{ txId: utxoId, outputIndex: 0, address: wallet.address, amount: 100 }],
      [{ address: 'b'.repeat(64), amount: 50 }],
      1
    )

    const result = validateTransaction(tx, utxoSet)
    expect(result.valid).toBe(true)
  })

  it('rejects missing UTXO', () => {
    const wallet = walletA
    const tx = createTransaction(
      wallet,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: 100 }],
      [{ address: 'b'.repeat(64), amount: 50 }],
      1
    )

    const result = validateTransaction(tx, new Map())
    expect(result.valid).toBe(false)
    expect(result.error).toContain('UTXO not found')
  })

  it('rejects wrong signature (wrong key)', () => {
    const wallet1 = walletA
    const wallet2 = walletB
    const utxoId = 'a'.repeat(64)

    // UTXO belongs to wallet2
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(utxoId, 0), {
      txId: utxoId,
      outputIndex: 0,
      address: wallet2.address,
      amount: 100,
    })

    // Signed by wallet1
    const tx = createTransaction(
      wallet1,
      [{ txId: utxoId, outputIndex: 0, address: wallet1.address, amount: 100 }],
      [{ address: 'b'.repeat(64), amount: 50 }],
      1
    )

    const result = validateTransaction(tx, utxoSet)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('does not match UTXO owner')
  })

  it('passes coinbase through', () => {
    const tx = createCoinbaseTransaction('a'.repeat(64), 0, 0)
    const result = validateTransaction(tx, new Map())
    expect(result.valid).toBe(true)
  })

  it('passes claim tx through', () => {
    const claimTx: Transaction = {
      id: 'x'.repeat(64),
      inputs: [{ txId: CLAIM_TXID, outputIndex: 0, publicKey: new Uint8Array(0), signature: new Uint8Array(0) }],
      outputs: [{ address: 'a'.repeat(64), amount: 100 }],
      timestamp: Date.now(),
      claimData: {
        btcAddress: 'b'.repeat(40),
        ecdsaPublicKey: new Uint8Array(33),
        ecdsaSignature: new Uint8Array(64),
        qbtcAddress: 'a'.repeat(64),
      },
    }

    const result = validateTransaction(claimTx, new Map())
    expect(result.valid).toBe(true)
  })
})

describe('isClaimTransaction', () => {
  it('true for tx with claimData', () => {
    const tx: Transaction = {
      id: 'x'.repeat(64),
      inputs: [],
      outputs: [],
      timestamp: 0,
      claimData: {
        btcAddress: 'a'.repeat(40),
        ecdsaPublicKey: new Uint8Array(33),
        ecdsaSignature: new Uint8Array(64),
        qbtcAddress: 'b'.repeat(64),
      },
    }
    expect(isClaimTransaction(tx)).toBe(true)
  })

  it('false for regular tx', () => {
    const tx: Transaction = {
      id: 'x'.repeat(64),
      inputs: [],
      outputs: [],
      timestamp: 0,
    }
    expect(isClaimTransaction(tx)).toBe(false)
  })

  it('false for coinbase', () => {
    const tx = createCoinbaseTransaction('a'.repeat(64), 0, 0)
    expect(isClaimTransaction(tx)).toBe(false)
  })
})

describe('calculateFee', () => {
  it('returns 0 for coinbase', () => {
    const tx = createCoinbaseTransaction('a'.repeat(64), 0, 0)
    expect(calculateFee(tx, new Map())).toBe(0)
  })

  it('returns 0 for claim tx', () => {
    const tx: Transaction = {
      id: 'x'.repeat(64),
      inputs: [],
      outputs: [{ address: 'a'.repeat(64), amount: 100 }],
      timestamp: 0,
      claimData: {
        btcAddress: 'a'.repeat(40),
        ecdsaPublicKey: new Uint8Array(33),
        ecdsaSignature: new Uint8Array(64),
        qbtcAddress: 'a'.repeat(64),
      },
    }
    expect(calculateFee(tx, new Map())).toBe(0)
  })
})
