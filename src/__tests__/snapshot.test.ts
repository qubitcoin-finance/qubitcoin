import { describe, it, expect } from 'vitest'
import { deriveBtcAddress, computeSnapshotMerkleRoot, ShardedIndex } from '../snapshot.js'
import { generateBtcKeypair } from '../crypto.js'
import type { BtcAddressBalance } from '../snapshot.js'

describe('deriveBtcAddress', () => {
  it('returns a 40-char hex string', () => {
    const { publicKey } = generateBtcKeypair()
    const addr = deriveBtcAddress(publicKey)
    expect(addr).toMatch(/^[0-9a-f]{40}$/)
  })

  it('is deterministic for same key', () => {
    const { publicKey } = generateBtcKeypair()
    expect(deriveBtcAddress(publicKey)).toBe(deriveBtcAddress(publicKey))
  })

  it('produces different addresses for different keys', () => {
    const kp1 = generateBtcKeypair()
    const kp2 = generateBtcKeypair()
    expect(deriveBtcAddress(kp1.publicKey)).not.toBe(deriveBtcAddress(kp2.publicKey))
  })
})

describe('computeSnapshotMerkleRoot', () => {
  it('returns 64 zero chars for empty entries', () => {
    expect(computeSnapshotMerkleRoot([])).toBe('0'.repeat(64))
  })

  it('returns 64-char hex for single entry', () => {
    const entries: BtcAddressBalance[] = [{ btcAddress: 'a'.repeat(40), amount: 1000 }]
    const root = computeSnapshotMerkleRoot(entries)
    expect(root).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic', () => {
    const entries: BtcAddressBalance[] = [
      { btcAddress: 'aa'.repeat(20), amount: 100 },
      { btcAddress: 'bb'.repeat(20), amount: 200 },
    ]
    expect(computeSnapshotMerkleRoot(entries)).toBe(computeSnapshotMerkleRoot(entries))
  })

  it('differs when entry order changes', () => {
    const e1: BtcAddressBalance = { btcAddress: 'aa'.repeat(20), amount: 100 }
    const e2: BtcAddressBalance = { btcAddress: 'bb'.repeat(20), amount: 200 }
    const root1 = computeSnapshotMerkleRoot([e1, e2])
    const root2 = computeSnapshotMerkleRoot([e2, e1])
    expect(root1).not.toBe(root2)
  })

  it('differs when amount changes', () => {
    const addr = 'aa'.repeat(20)
    const r1 = computeSnapshotMerkleRoot([{ btcAddress: addr, amount: 100 }])
    const r2 = computeSnapshotMerkleRoot([{ btcAddress: addr, amount: 101 }])
    expect(r1).not.toBe(r2)
  })

  it('differs when address changes', () => {
    const r1 = computeSnapshotMerkleRoot([{ btcAddress: 'aa'.repeat(20), amount: 100 }])
    const r2 = computeSnapshotMerkleRoot([{ btcAddress: 'bb'.repeat(20), amount: 100 }])
    expect(r1).not.toBe(r2)
  })

  it('includes type prefix in hash — same address with different types produce different roots', () => {
    const addr = 'aa'.repeat(20)
    const noType = computeSnapshotMerkleRoot([{ btcAddress: addr, amount: 100 }])
    const p2sh = computeSnapshotMerkleRoot([{ btcAddress: addr, amount: 100, type: 'p2sh' }])
    const p2tr = computeSnapshotMerkleRoot([{ btcAddress: addr, amount: 100, type: 'p2tr' }])
    expect(noType).not.toBe(p2sh)
    expect(noType).not.toBe(p2tr)
    expect(p2sh).not.toBe(p2tr)
  })

  it('handles multiple entries with mixed types', () => {
    const entries: BtcAddressBalance[] = [
      { btcAddress: 'aa'.repeat(20), amount: 100 },
      { btcAddress: 'bb'.repeat(32), amount: 200, type: 'p2tr' },
      { btcAddress: 'cc'.repeat(20), amount: 300, type: 'p2sh' },
    ]
    const root = computeSnapshotMerkleRoot(entries)
    expect(root).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('ShardedIndex', () => {
  it('stores and retrieves entries', () => {
    const idx = new ShardedIndex()
    const entry: BtcAddressBalance = { btcAddress: 'aabbccdd'.repeat(5), amount: 999 }
    idx.set(entry.btcAddress, entry)
    expect(idx.get(entry.btcAddress)).toBe(entry)
  })

  it('has() returns true for known key', () => {
    const idx = new ShardedIndex()
    const key = 'ff'.repeat(20)
    const entry: BtcAddressBalance = { btcAddress: key, amount: 1 }
    idx.set(key, entry)
    expect(idx.has(key)).toBe(true)
  })

  it('has() returns false for unknown key', () => {
    const idx = new ShardedIndex()
    expect(idx.has('00'.repeat(20))).toBe(false)
  })

  it('get() returns undefined for missing key', () => {
    const idx = new ShardedIndex()
    expect(idx.get('aa'.repeat(20))).toBeUndefined()
  })

  it('stores entries across different shards correctly', () => {
    const idx = new ShardedIndex()
    // Keys starting with different byte values land in different shards
    const e00: BtcAddressBalance = { btcAddress: '00' + 'aa'.repeat(19), amount: 1 }
    const e7f: BtcAddressBalance = { btcAddress: '7f' + 'bb'.repeat(19), amount: 2 }
    const eff: BtcAddressBalance = { btcAddress: 'ff' + 'cc'.repeat(19), amount: 3 }
    idx.set(e00.btcAddress, e00)
    idx.set(e7f.btcAddress, e7f)
    idx.set(eff.btcAddress, eff)
    expect(idx.get(e00.btcAddress)?.amount).toBe(1)
    expect(idx.get(e7f.btcAddress)?.amount).toBe(2)
    expect(idx.get(eff.btcAddress)?.amount).toBe(3)
  })

  it('overwrites existing entry on duplicate key', () => {
    const idx = new ShardedIndex()
    const key = 'ab'.repeat(20)
    const e1: BtcAddressBalance = { btcAddress: key, amount: 10 }
    const e2: BtcAddressBalance = { btcAddress: key, amount: 20 }
    idx.set(key, e1)
    idx.set(key, e2)
    expect(idx.get(key)?.amount).toBe(20)
  })
})
