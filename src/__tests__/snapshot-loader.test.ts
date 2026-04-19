import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadSnapshot } from '../snapshot-loader.js'
import { getSnapshotIndex } from '../snapshot.js'

describe('loadSnapshot', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-snapshot-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should parse NDJSON snapshot file (legacy format, no header)', async () => {
    const filePath = path.join(tmpDir, 'test.jsonl')
    const lines = [
      '{"a":"aabbccdd0011223344556677889900aabbccddee","b":100000000}',
      '{"a":"11223344556677889900aabbccddeeff00112233","b":250000000}',
      '{"a":"ffeeddccbbaa99887766554433221100ffeeddcc","b":50000000}',
    ]
    fs.writeFileSync(filePath, lines.join('\n') + '\n')

    const snapshot = await loadSnapshot(filePath)

    expect(snapshot.entries).toHaveLength(3)
    expect(snapshot.entries[0].btcAddress).toBe('aabbccdd0011223344556677889900aabbccddee')
    expect(snapshot.entries[0].amount).toBe(100000000)
    expect(snapshot.entries[1].btcAddress).toBe('11223344556677889900aabbccddeeff00112233')
    expect(snapshot.entries[1].amount).toBe(250000000)
    expect(snapshot.entries[2].amount).toBe(50000000)
    expect(snapshot.merkleRoot).toBeTruthy()
    expect(snapshot.merkleRoot.length).toBe(64)
  })

  it('should parse snapshot with header line', async () => {
    const filePath = path.join(tmpDir, 'with-header.jsonl')
    const merkle = 'ff'.repeat(32)
    const lines = [
      JSON.stringify({ height: 0, hash: 'abcd1234', timestamp: 1739482182, count: 2, merkleRoot: merkle, p2pkhCoins: 1, p2wpkhCoins: 1, totalClaimableSats: '300' }),
      '{"a":"aabbccdd0011223344556677889900aabbccddee","b":100}',
      '{"a":"11223344556677889900aabbccddeeff00112233","b":200}',
    ]
    fs.writeFileSync(filePath, lines.join('\n') + '\n')

    const snapshot = await loadSnapshot(filePath)

    expect(snapshot.entries).toHaveLength(2)
    expect(snapshot.merkleRoot).toBe(merkle)
    expect(snapshot.btcBlockHash).toBe('abcd1234')
  })

  it('should handle empty lines gracefully', async () => {
    const filePath = path.join(tmpDir, 'sparse.jsonl')
    fs.writeFileSync(
      filePath,
      '{"a":"aabbccdd0011223344556677889900aabbccddee","b":100}\n\n{"a":"11223344556677889900aabbccddeeff00112233","b":200}\n'
    )

    const snapshot = await loadSnapshot(filePath)
    expect(snapshot.entries).toHaveLength(2)
  })

  it('should handle single entry', async () => {
    const filePath = path.join(tmpDir, 'single.jsonl')
    fs.writeFileSync(filePath, '{"a":"aabbccdd0011223344556677889900aabbccddee","b":42}\n')

    const snapshot = await loadSnapshot(filePath)
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0].amount).toBe(42)
  })

  it('should parse entry type fields (p2sh, p2tr, p2wsh, multisig)', async () => {
    const filePath = path.join(tmpDir, 'types.jsonl')
    const lines = [
      '{"a":"aabbccdd0011223344556677889900aabbccddee","b":100}',
      '{"a":"11223344556677889900aabbccddeeff00112233","b":200,"t":"p2sh"}',
      '{"a":"22334455667788990011aabbccddeeff00112233","b":300,"t":"p2tr"}',
      '{"a":"33445566778899001122bbccddeeff00112233aa","b":400,"t":"p2wsh"}',
      '{"a":"44556677889900112233ccddeeff00112233aabb","b":500,"t":"multisig"}',
      '{"a":"55667788990011223344ddeeff00112233aabbcc","b":600,"t":"unknown"}',
    ]
    fs.writeFileSync(filePath, lines.join('\n') + '\n')

    const snapshot = await loadSnapshot(filePath)

    expect(snapshot.entries).toHaveLength(6)
    expect(snapshot.entries[0].type).toBeUndefined()
    expect(snapshot.entries[1].type).toBe('p2sh')
    expect(snapshot.entries[2].type).toBe('p2tr')
    expect(snapshot.entries[3].type).toBe('p2wsh')
    expect(snapshot.entries[4].type).toBe('multisig')
    expect(snapshot.entries[5].type).toBeUndefined()
  })

  it('should throw when header has merkleRoot but missing timestamp', async () => {
    const filePath = path.join(tmpDir, 'no-timestamp.jsonl')
    const lines = [
      JSON.stringify({ height: 100, hash: 'deadbeef', count: 1, merkleRoot: 'ff'.repeat(32) }),
      '{"a":"aabbccdd0011223344556677889900aabbccddee","b":100}',
    ]
    fs.writeFileSync(filePath, lines.join('\n') + '\n')

    await expect(loadSnapshot(filePath)).rejects.toThrow('btcTimestamp')
  })

  it('should use hardcoded timestamp for known block hash', async () => {
    const filePath = path.join(tmpDir, 'known-hash.jsonl')
    const knownHash = '3aafae11a317cdd4fa7802ad577e741501e1fa0e970101000000000000000000'
    const lines = [
      JSON.stringify({ height: 935941, hash: knownHash, count: 1, merkleRoot: 'ff'.repeat(32) }),
      '{"a":"aabbccdd0011223344556677889900aabbccddee","b":100}',
    ]
    fs.writeFileSync(filePath, lines.join('\n') + '\n')

    const snapshot = await loadSnapshot(filePath)
    expect(snapshot.btcTimestamp).toBe(1739482182)
    expect(snapshot.btcBlockHash).toBe(knownHash)
  })

  it('should parse btcBlockHeight and btcBlockHash from header', async () => {
    const filePath = path.join(tmpDir, 'full-header.jsonl')
    const lines = [
      JSON.stringify({ height: 800000, hash: 'cafebabe', timestamp: 1700000000, count: 1, merkleRoot: 'ab'.repeat(32) }),
      '{"a":"aabbccdd0011223344556677889900aabbccddee","b":100}',
    ]
    fs.writeFileSync(filePath, lines.join('\n') + '\n')

    const snapshot = await loadSnapshot(filePath)
    expect(snapshot.btcBlockHeight).toBe(800000)
    expect(snapshot.btcBlockHash).toBe('cafebabe')
    expect(snapshot.btcTimestamp).toBe(1700000000)
  })
})

describe('getSnapshotIndex', () => {
  it('should provide O(1) lookups by btcAddress', async () => {
    const filePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-idx-')),
      'test.jsonl'
    )
    const lines = [
      '{"a":"aabbccdd0011223344556677889900aabbccddee","b":100}',
      '{"a":"11223344556677889900aabbccddeeff00112233","b":200}',
    ]
    fs.writeFileSync(filePath, lines.join('\n') + '\n')
    const snapshot = await loadSnapshot(filePath)

    const index = getSnapshotIndex(snapshot)
    expect(index.get('aabbccdd0011223344556677889900aabbccddee')?.amount).toBe(100)
    expect(index.get('11223344556677889900aabbccddeeff00112233')?.amount).toBe(200)
    expect(index.get('nonexistent')).toBeUndefined()
  })

  it('should return the same cached index on repeated calls', async () => {
    const filePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-idx2-')),
      'test.jsonl'
    )
    fs.writeFileSync(filePath, '{"a":"aabbccdd0011223344556677889900aabbccddee","b":1}\n')
    const snapshot = await loadSnapshot(filePath)

    const idx1 = getSnapshotIndex(snapshot)
    const idx2 = getSnapshotIndex(snapshot)
    expect(idx1).toBe(idx2) // same reference
  })
})
