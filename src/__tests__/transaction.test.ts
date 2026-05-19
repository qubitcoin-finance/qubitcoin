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
  COINBASE_MATURITY,
  CLAIM_MATURITY,
  DUST_THRESHOLD,
  MAX_TX_INPUTS,
  MAX_TX_OUTPUTS,
  type Transaction,
  type UTXO,
} from '../transaction.js'
import { deriveAddress } from '../crypto.js'
import { walletA, walletB } from './fixtures.js'

describe('blockSubsidy', () => {
  it('returns 312500000 at height 0', () => {
    expect(blockSubsidy(0)).toBe(312_500_000)
  })

  it('returns 312500000 before first halving', () => {
    expect(blockSubsidy(HALVING_INTERVAL - 1)).toBe(312_500_000)
  })

  it('halves at 210,000', () => {
    expect(blockSubsidy(HALVING_INTERVAL)).toBe(156_250_000)
  })

  it('halves again at 420,000', () => {
    expect(blockSubsidy(HALVING_INTERVAL * 2)).toBe(78_125_000)
  })

  it('reaches 0 after 26 halvings', () => {
    expect(blockSubsidy(HALVING_INTERVAL * 26)).toBe(0)
  })

  it('throws RangeError for negative height', () => {
    expect(() => blockSubsidy(-1)).toThrow(RangeError)
    expect(() => blockSubsidy(-210_000)).toThrow(RangeError)
  })
})

describe('createCoinbaseTransaction', () => {
  it('creates correct coinbase', () => {
    const addr = '0'.repeat(64)
    const tx = createCoinbaseTransaction(addr, 0, 500_000_000)
    expect(isCoinbase(tx)).toBe(true)
    expect(tx.outputs.length).toBe(1)
    expect(tx.outputs[0].amount).toBe(812_500_000) // 312500000 subsidy + 500000000 fees
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
      { txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: 10_000 },
    ]
    const tx = createTransaction(
      wallet,
      utxos,
      [{ address: 'b'.repeat(64), amount: 3000 }],
      1
    )

    expect(tx.inputs.length).toBe(1)
    expect(tx.outputs.length).toBe(2) // recipient + change
    expect(tx.outputs[0].amount).toBe(3000)
    expect(tx.outputs[1].amount).toBe(6999) // 10000 - 3000 - 1 fee
    expect(tx.id.length).toBe(64)
  })

  it('throws on insufficient funds', () => {
    const wallet = walletA
    const utxos: UTXO[] = [
      { txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: 1000 },
    ]
    expect(() =>
      createTransaction(wallet, utxos, [{ address: 'b'.repeat(64), amount: 10_000 }], 1)
    ).toThrow('Insufficient funds')
  })

  it('omits change output when exact amount', () => {
    const wallet = walletA
    const utxos: UTXO[] = [
      { txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: 5001 },
    ]
    const tx = createTransaction(
      wallet,
      utxos,
      [{ address: 'b'.repeat(64), amount: 5000 }],
      1
    )
    expect(tx.outputs.length).toBe(1)
  })

  it('omits dust change output and folds it into the effective fee', () => {
    const wallet = walletA
    const utxoId = 'a'.repeat(64)
    const utxos: UTXO[] = [
      { txId: utxoId, outputIndex: 0, address: wallet.address, amount: 6000 },
    ]
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(utxoId, 0), utxos[0])

    const tx = createTransaction(
      wallet,
      utxos,
      [{ address: 'b'.repeat(64), amount: 5000 }],
      500
    )

    expect(tx.outputs).toEqual([{ address: 'b'.repeat(64), amount: 5000 }])
    expect(validateTransaction(tx, utxoSet).valid).toBe(true)
    expect(calculateFee(tx, utxoSet)).toBe(1000)
  })

  it('keeps change output when the remainder is exactly at the dust threshold', () => {
    const wallet = walletA
    const tx = createTransaction(
      wallet,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: 6000 }],
      [{ address: 'b'.repeat(64), amount: 5454 }],
      0
    )

    expect(tx.outputs.length).toBe(2)
    expect(tx.outputs[1]).toEqual({ address: wallet.address, amount: DUST_THRESHOLD })
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
      amount: 10_000,
    })

    const tx = createTransaction(
      wallet,
      [{ txId: utxoId, outputIndex: 0, address: wallet.address, amount: 10_000 }],
      [{ address: 'b'.repeat(64), amount: 5000 }],
      1
    )

    const result = validateTransaction(tx, utxoSet)
    expect(result.valid).toBe(true)
  })

  it('rejects missing UTXO', () => {
    const wallet = walletA
    const tx = createTransaction(
      wallet,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: 10_000 }],
      [{ address: 'b'.repeat(64), amount: 5000 }],
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
      amount: 10_000,
    })

    // Signed by wallet1
    const tx = createTransaction(
      wallet1,
      [{ txId: utxoId, outputIndex: 0, address: wallet1.address, amount: 10_000 }],
      [{ address: 'b'.repeat(64), amount: 5000 }],
      1
    )

    const result = validateTransaction(tx, utxoSet)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('does not match UTXO owner')
  })

  it('rejects fractional output amount', () => {
    const wallet = walletA
    const utxoId = 'a'.repeat(64)
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(utxoId, 0), {
      txId: utxoId,
      outputIndex: 0,
      address: wallet.address,
      amount: 10_000,
    })

    const tx = createTransaction(
      wallet,
      [{ txId: utxoId, outputIndex: 0, address: wallet.address, amount: 10_000 }],
      [{ address: 'b'.repeat(64), amount: 5000 }],
      1
    )

    // Tamper: set output amount to a float
    tx.outputs[0].amount = 49.5

    const result = validateTransaction(tx, utxoSet)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('non-integer amount')
  })

  it('rejects transaction with too many inputs', () => {
    const wallet = walletA
    const txId = 'a'.repeat(64)
    const fakeInput = {
      txId,
      outputIndex: 0,
      publicKey: wallet.publicKey,
      signature: new Uint8Array(3309),
    }
    const tx: Transaction = {
      id: 'x'.repeat(64),
      inputs: Array.from({ length: MAX_TX_INPUTS + 1 }, (_, i) => ({ ...fakeInput, outputIndex: i })),
      outputs: [{ address: 'b'.repeat(64), amount: 5000 }],
      timestamp: Date.now(),
    }
    const result = validateTransaction(tx, new Map())
    expect(result.valid).toBe(false)
    expect(result.error).toContain('too many inputs')
  })

  it('rejects transaction with too many outputs', () => {
    const wallet = walletA
    const txId = 'a'.repeat(64)
    const fakeInput = {
      txId,
      outputIndex: 0,
      publicKey: wallet.publicKey,
      signature: new Uint8Array(3309),
    }
    const tx: Transaction = {
      id: 'x'.repeat(64),
      inputs: [fakeInput],
      outputs: Array.from({ length: MAX_TX_OUTPUTS + 1 }, () => ({ address: 'b'.repeat(64), amount: 546 })),
      timestamp: Date.now(),
    }
    const result = validateTransaction(tx, new Map())
    expect(result.valid).toBe(false)
    expect(result.error).toContain('too many outputs')
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
      outputs: [{ address: 'a'.repeat(64), amount: 10_000 }],
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
      outputs: [{ address: 'a'.repeat(64), amount: 10_000 }],
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

  it('returns correct fee for regular transaction', () => {
    const wallet = walletA
    const utxoId = 'a'.repeat(64)
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(utxoId, 0), {
      txId: utxoId,
      outputIndex: 0,
      address: wallet.address,
      amount: 1000,
    })

    const tx = createTransaction(
      wallet,
      [{ txId: utxoId, outputIndex: 0, address: wallet.address, amount: 1000 }],
      [{ address: 'b'.repeat(64), amount: 354 }],
      100
    )

    expect(calculateFee(tx, utxoSet)).toBe(100)
  })
})

describe('validateTransaction additional edge cases', () => {
  it('rejects zero amount output', () => {
    const wallet = walletA
    const utxoId = 'a'.repeat(64)
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(utxoId, 0), {
      txId: utxoId,
      outputIndex: 0,
      address: wallet.address,
      amount: 10_000,
    })

    const tx = createTransaction(
      wallet,
      [{ txId: utxoId, outputIndex: 0, address: wallet.address, amount: 10_000 }],
      [{ address: 'b'.repeat(64), amount: 5000 }],
      1
    )
    tx.outputs[0].amount = 0

    const result = validateTransaction(tx, utxoSet)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('non-positive amount')
  })

  it('rejects negative amount output', () => {
    const wallet = walletA
    const utxoId = 'a'.repeat(64)
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(utxoId, 0), {
      txId: utxoId,
      outputIndex: 0,
      address: wallet.address,
      amount: 10_000,
    })

    const tx = createTransaction(
      wallet,
      [{ txId: utxoId, outputIndex: 0, address: wallet.address, amount: 10_000 }],
      [{ address: 'b'.repeat(64), amount: 5000 }],
      1
    )
    tx.outputs[0].amount = -10

    const result = validateTransaction(tx, utxoSet)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('non-positive amount')
  })

  it('rejects duplicate inputs', () => {
    const wallet = walletA
    const utxoId = 'a'.repeat(64)
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(utxoId, 0), {
      txId: utxoId,
      outputIndex: 0,
      address: wallet.address,
      amount: 10_000,
    })

    const tx = createTransaction(
      wallet,
      [{ txId: utxoId, outputIndex: 0, address: wallet.address, amount: 10_000 }],
      [{ address: 'b'.repeat(64), amount: 5000 }],
      1
    )
    // Duplicate the first input
    tx.inputs.push({ ...tx.inputs[0] })

    const result = validateTransaction(tx, utxoSet)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Duplicate input')
  })

  it('rejects tampered transaction ID', () => {
    const wallet = walletA
    const utxoId = 'a'.repeat(64)
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(utxoId, 0), {
      txId: utxoId,
      outputIndex: 0,
      address: wallet.address,
      amount: 10_000,
    })

    const tx = createTransaction(
      wallet,
      [{ txId: utxoId, outputIndex: 0, address: wallet.address, amount: 10_000 }],
      [{ address: 'b'.repeat(64), amount: 5000 }],
      1
    )
    tx.id = 'f'.repeat(64) // tamper the ID

    const result = validateTransaction(tx, utxoSet)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Transaction ID mismatch')
  })

  it('rejects outputs exceeding inputs', () => {
    const wallet = walletA
    const utxoId = 'a'.repeat(64)
    // Set UTXO amount lower than what tx outputs claim
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(utxoId, 0), {
      txId: utxoId,
      outputIndex: 0,
      address: wallet.address,
      amount: 10_000,
    })

    // Create tx spending from the UTXO
    const tx = createTransaction(
      wallet,
      [{ txId: utxoId, outputIndex: 0, address: wallet.address, amount: 10_000 }],
      [{ address: 'b'.repeat(64), amount: 9000 }],
      1
    )

    // Lie about the UTXO amount to make output > input
    utxoSet.set(utxoKey(utxoId, 0), {
      txId: utxoId,
      outputIndex: 0,
      address: wallet.address,
      amount: 5000, // less than output (9000)
    })

    const result = validateTransaction(tx, utxoSet)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('exceed inputs')
  })

  it('rejects output below dust threshold', () => {
    const wallet = walletA
    const utxoId = 'a'.repeat(64)
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(utxoId, 0), {
      txId: utxoId,
      outputIndex: 0,
      address: wallet.address,
      amount: 10_000,
    })

    // Mutate a valid transaction to force a dust recipient output.
    const tx = createTransaction(
      wallet,
      [{ txId: utxoId, outputIndex: 0, address: wallet.address, amount: 10_000 }],
      [{ address: 'b'.repeat(64), amount: 5000 }],
      1
    )
    // Force output below dust threshold (DUST_THRESHOLD = 546)
    tx.outputs[0].amount = DUST_THRESHOLD - 1

    const result = validateTransaction(tx, utxoSet)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('dust threshold')
  })

  it('accepts output exactly at dust threshold', () => {
    const wallet = walletA
    const utxoId = 'a'.repeat(64)
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(utxoId, 0), {
      txId: utxoId,
      outputIndex: 0,
      address: wallet.address,
      amount: 10_000,
    })

    const tx = createTransaction(
      wallet,
      [{ txId: utxoId, outputIndex: 0, address: wallet.address, amount: 10_000 }],
      [{ address: 'b'.repeat(64), amount: DUST_THRESHOLD }],
      10_000 - DUST_THRESHOLD
    )

    const result = validateTransaction(tx, utxoSet)
    expect(result.valid).toBe(true)
  })

  it('rejects spending immature coinbase UTXO', () => {
    const wallet = walletA
    const utxoId = 'a'.repeat(64)
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(utxoId, 0), {
      txId: utxoId,
      outputIndex: 0,
      address: wallet.address,
      amount: 10_000_000,
      isCoinbase: true,
      height: 0, // mined at height 0
    })

    const tx = createTransaction(
      wallet,
      [{ txId: utxoId, outputIndex: 0, address: wallet.address, amount: 10_000_000 }],
      [{ address: 'b'.repeat(64), amount: 5_000_000 }],
      1000
    )

    // Attempt to spend at height 50 — coinbase requires COINBASE_MATURITY (100) blocks
    const currentHeight = COINBASE_MATURITY - 1
    const result = validateTransaction(tx, utxoSet, currentHeight)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('not mature')
    expect(result.error).toContain(`need ${COINBASE_MATURITY}`)
  })

  it('accepts spending coinbase UTXO once mature', () => {
    const wallet = walletA
    const utxoId = 'a'.repeat(64)
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(utxoId, 0), {
      txId: utxoId,
      outputIndex: 0,
      address: wallet.address,
      amount: 10_000_000,
      isCoinbase: true,
      height: 0,
    })

    const tx = createTransaction(
      wallet,
      [{ txId: utxoId, outputIndex: 0, address: wallet.address, amount: 10_000_000 }],
      [{ address: 'b'.repeat(64), amount: 5_000_000 }],
      1000
    )

    // At exactly COINBASE_MATURITY blocks later, spending should be allowed
    const result = validateTransaction(tx, utxoSet, COINBASE_MATURITY)
    expect(result.valid).toBe(true)
  })

  it('rejects spending immature claim UTXO', () => {
    const wallet = walletA
    const utxoId = 'a'.repeat(64)
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(utxoId, 0), {
      txId: utxoId,
      outputIndex: 0,
      address: wallet.address,
      amount: 10_000_000,
      isClaim: true,
      height: 5, // claim mined at height 5
    })

    const tx = createTransaction(
      wallet,
      [{ txId: utxoId, outputIndex: 0, address: wallet.address, amount: 10_000_000 }],
      [{ address: 'b'.repeat(64), amount: 5_000_000 }],
      1000
    )

    // Attempt to spend at height 5 + 9 = 14 — claim requires CLAIM_MATURITY (10) blocks
    const currentHeight = 5 + CLAIM_MATURITY - 1
    const result = validateTransaction(tx, utxoSet, currentHeight)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('not mature')
    expect(result.error).toContain(`need ${CLAIM_MATURITY}`)
  })

  it('accepts spending claim UTXO once mature', () => {
    const wallet = walletA
    const utxoId = 'a'.repeat(64)
    const claimHeight = 5
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(utxoId, 0), {
      txId: utxoId,
      outputIndex: 0,
      address: wallet.address,
      amount: 10_000_000,
      isClaim: true,
      height: claimHeight,
    })

    const tx = createTransaction(
      wallet,
      [{ txId: utxoId, outputIndex: 0, address: wallet.address, amount: 10_000_000 }],
      [{ address: 'b'.repeat(64), amount: 5_000_000 }],
      1000
    )

    // At exactly CLAIM_MATURITY blocks after the claim, spending should be allowed
    const result = validateTransaction(tx, utxoSet, claimHeight + CLAIM_MATURITY)
    expect(result.valid).toBe(true)
  })

  it('rejects transaction with NaN timestamp', () => {
    const fakeInput = {
      txId: 'a'.repeat(64),
      outputIndex: 0,
      publicKey: walletA.publicKey,
      signature: new Uint8Array(3309),
    }
    const tx: Transaction = {
      id: 'x'.repeat(64),
      inputs: [fakeInput],
      outputs: [{ address: 'b'.repeat(64), amount: 5000 }],
      timestamp: NaN,
    }
    const result = validateTransaction(tx, new Map())
    expect(result.valid).toBe(false)
    expect(result.error).toContain('timestamp')
  })

  it('rejects transaction with zero timestamp', () => {
    const fakeInput = {
      txId: 'a'.repeat(64),
      outputIndex: 0,
      publicKey: walletA.publicKey,
      signature: new Uint8Array(3309),
    }
    const tx: Transaction = {
      id: 'x'.repeat(64),
      inputs: [fakeInput],
      outputs: [{ address: 'b'.repeat(64), amount: 5000 }],
      timestamp: 0,
    }
    const result = validateTransaction(tx, new Map())
    expect(result.valid).toBe(false)
    expect(result.error).toContain('timestamp')
  })

  it('rejects transaction with negative timestamp', () => {
    const fakeInput = {
      txId: 'a'.repeat(64),
      outputIndex: 0,
      publicKey: walletA.publicKey,
      signature: new Uint8Array(3309),
    }
    const tx: Transaction = {
      id: 'x'.repeat(64),
      inputs: [fakeInput],
      outputs: [{ address: 'b'.repeat(64), amount: 5000 }],
      timestamp: -1,
    }
    const result = validateTransaction(tx, new Map())
    expect(result.valid).toBe(false)
    expect(result.error).toContain('timestamp')
  })

  it('rejects transaction with Infinity timestamp', () => {
    const fakeInput = {
      txId: 'a'.repeat(64),
      outputIndex: 0,
      publicKey: walletA.publicKey,
      signature: new Uint8Array(3309),
    }
    const tx: Transaction = {
      id: 'x'.repeat(64),
      inputs: [fakeInput],
      outputs: [{ address: 'b'.repeat(64), amount: 5000 }],
      timestamp: Infinity,
    }
    const result = validateTransaction(tx, new Map())
    expect(result.valid).toBe(false)
    expect(result.error).toContain('timestamp')
  })

  it('skips maturity check when currentHeight is undefined', () => {
    const wallet = walletA
    const utxoId = 'a'.repeat(64)
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(utxoId, 0), {
      txId: utxoId,
      outputIndex: 0,
      address: wallet.address,
      amount: 10_000_000,
      isCoinbase: true,
      height: 0,
    })

    const tx = createTransaction(
      wallet,
      [{ txId: utxoId, outputIndex: 0, address: wallet.address, amount: 10_000_000 }],
      [{ address: 'b'.repeat(64), amount: 5_000_000 }],
      1000
    )

    // No currentHeight → maturity not enforced (used in some internal paths)
    const result = validateTransaction(tx, utxoSet)
    expect(result.valid).toBe(true)
  })
})

describe('validateTransaction output address validation', () => {
  function makeFakeTx(outputAddress: string): Transaction {
    // Build a minimal transaction with the given output address.
    // Signatures / txId are irrelevant — address format is checked before UTXO or txId validation.
    return {
      id: 'f'.repeat(64),
      inputs: [
        {
          txId: 'a'.repeat(64),
          outputIndex: 0,
          publicKey: new Uint8Array(0),
          signature: new Uint8Array(0),
        },
      ],
      outputs: [{ address: outputAddress, amount: DUST_THRESHOLD }],
      timestamp: Date.now(),
    }
  }

  it('rejects output with empty address', () => {
    const result = validateTransaction(makeFakeTx(''), new Map())
    expect(result.valid).toBe(false)
    expect(result.error).toContain('invalid address format')
  })

  it('rejects output with address shorter than 64 chars', () => {
    const result = validateTransaction(makeFakeTx('ab'.repeat(16)), new Map()) // 32 chars
    expect(result.valid).toBe(false)
    expect(result.error).toContain('invalid address format')
  })

  it('rejects output with address longer than 64 chars', () => {
    const result = validateTransaction(makeFakeTx('a'.repeat(65)), new Map())
    expect(result.valid).toBe(false)
    expect(result.error).toContain('invalid address format')
  })

  it('rejects output with uppercase hex address', () => {
    // isValidHash requires lowercase; uppercase must be rejected so addresses stay canonical
    const result = validateTransaction(makeFakeTx('A'.repeat(64)), new Map())
    expect(result.valid).toBe(false)
    expect(result.error).toContain('invalid address format')
  })

  it('rejects output with non-hex address', () => {
    const result = validateTransaction(makeFakeTx('z'.repeat(64)), new Map())
    expect(result.valid).toBe(false)
    expect(result.error).toContain('invalid address format')
  })

  it('accepts output with valid 64-char lowercase hex address', () => {
    // A well-formed address gets past format validation;
    // subsequent UTXO lookup will fail (expected — we pass an empty UTXO set).
    const result = validateTransaction(makeFakeTx('a'.repeat(64)), new Map())
    expect(result.valid).toBe(false)
    expect(result.error).not.toContain('invalid address format')
  })
})
