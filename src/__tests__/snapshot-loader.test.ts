import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadSnapshot } from '../snapshot-loader.js'
import { getSnapshotIndex } from '../snapshot.js'

describe('loadSnapshot', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qtc-snapshot-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should parse NDJSON snapshot file', () => {
    const filePath = path.join(tmpDir, 'test.jsonl')
    const lines = [
      '{"a":"aabbccdd0011223344556677889900aabbccddee","b":100000000}',
      '{"a":"11223344556677889900aabbccddeeff00112233","b":250000000}',
      '{"a":"ffeeddccbbaa99887766554433221100ffeeddcc","b":50000000}',
    ]
    fs.writeFileSync(filePath, lines.join('\n') + '\n')

    const snapshot = loadSnapshot(filePath)

    expect(snapshot.entries).toHaveLength(3)
    expect(snapshot.entries[0].btcAddress).toBe('aabbccdd0011223344556677889900aabbccddee')
    expect(snapshot.entries[0].amount).toBe(100000000)
    expect(snapshot.entries[1].btcAddress).toBe('11223344556677889900aabbccddeeff00112233')
    expect(snapshot.entries[1].amount).toBe(250000000)
    expect(snapshot.entries[2].amount).toBe(50000000)
    expect(snapshot.merkleRoot).toBeTruthy()
    expect(snapshot.merkleRoot.length).toBe(64)
  })

  it('should handle empty lines gracefully', () => {
    const filePath = path.join(tmpDir, 'sparse.jsonl')
    fs.writeFileSync(
      filePath,
      '{"a":"aabbccdd0011223344556677889900aabbccddee","b":100}\n\n{"a":"11223344556677889900aabbccddeeff00112233","b":200}\n'
    )

    const snapshot = loadSnapshot(filePath)
    expect(snapshot.entries).toHaveLength(2)
  })

  it('should handle single entry', () => {
    const filePath = path.join(tmpDir, 'single.jsonl')
    fs.writeFileSync(filePath, '{"a":"aabbccdd0011223344556677889900aabbccddee","b":42}\n')

    const snapshot = loadSnapshot(filePath)
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0].amount).toBe(42)
  })
})

describe('getSnapshotIndex', () => {
  it('should provide O(1) lookups by btcAddress', () => {
    const filePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qtc-idx-')),
      'test.jsonl'
    )
    const lines = [
      '{"a":"aabbccdd0011223344556677889900aabbccddee","b":100}',
      '{"a":"11223344556677889900aabbccddeeff00112233","b":200}',
    ]
    fs.writeFileSync(filePath, lines.join('\n') + '\n')
    const snapshot = loadSnapshot(filePath)

    const index = getSnapshotIndex(snapshot)
    expect(index.size).toBe(2)
    expect(index.get('aabbccdd0011223344556677889900aabbccddee')?.amount).toBe(100)
    expect(index.get('11223344556677889900aabbccddeeff00112233')?.amount).toBe(200)
    expect(index.get('nonexistent')).toBeUndefined()
  })

  it('should return the same cached map on repeated calls', () => {
    const filePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qtc-idx2-')),
      'test.jsonl'
    )
    fs.writeFileSync(filePath, '{"a":"aabbccdd0011223344556677889900aabbccddee","b":1}\n')
    const snapshot = loadSnapshot(filePath)

    const idx1 = getSnapshotIndex(snapshot)
    const idx2 = getSnapshotIndex(snapshot)
    expect(idx1).toBe(idx2) // same reference
  })
})
