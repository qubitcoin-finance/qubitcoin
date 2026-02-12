#!/usr/bin/env node
/**
 * Convert Bitcoin Core's dumptxoutset binary → QTC snapshot NDJSON
 *
 * Two-phase pipeline with checkpointed resume:
 *
 *   Phase 1 — Extract (slow, resumable):
 *     Parse binary → filter P2PKH+P2WPKH+P2SH → append intermediate NDJSON
 *     Periodic checkpoints store byte offset; kill & re-run to resume.
 *
 *   Phase 2 — Aggregate (fast, ~2 min):
 *     Read intermediate NDJSON → aggregate by address → merkle root → final snapshot
 *
 * Usage:
 *   # Two-phase (recommended for large dumps):
 *   pnpm run convert-snapshot -- extract --input ~/utxos.dat --workdir ~/qtc-work/
 *   pnpm run convert-snapshot -- aggregate --workdir ~/qtc-work/ --output ~/qtc-snapshot.jsonl
 *
 *   # Legacy single command (runs both phases):
 *   pnpm run convert-snapshot -- --input ~/utxos.dat --output ~/qtc-snapshot.jsonl
 */
import {
  createWriteStream, createReadStream,
  openSync, closeSync, fdatasyncSync, writeSync,
  writeFileSync, readFileSync, renameSync, unlinkSync,
  existsSync, statSync, truncateSync,
} from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { parseDumptxoutset, parseHeader, type ResumeState } from './parse-utxoset.js'
import { execFileSync } from 'node:child_process'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { BtcAddressBalance } from '../snapshot.js'

// --- Types ---

interface Checkpoint {
  bytesRead: number
  coinsRead: string   // bigint serialized as string
  outputBytes: number // byte length of coins.jsonl at checkpoint time
}

// --- CLI args ---

interface ExtractArgs { command: 'extract'; input: string; workdir: string }
interface AggregateArgs { command: 'aggregate'; workdir: string; output: string; gzip: boolean }
interface LegacyArgs { command: 'legacy'; input: string; output: string; gzip: boolean }

type Args = ExtractArgs | AggregateArgs | LegacyArgs

function parseArgs(): Args {
  const rawArgs = process.argv.slice(2)
  // pnpm passes '--' separator literally; strip it
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
  const subcommand = args[0]

  // Check for subcommand
  if (subcommand === 'extract' || subcommand === 'aggregate') {
    let input = ''
    let output = ''
    let workdir = ''
    let gzip = false

    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--input' && args[i + 1]) input = args[++i]
      else if (args[i] === '--output' && args[i + 1]) output = args[++i]
      else if (args[i] === '--workdir' && args[i + 1]) workdir = args[++i]
      else if (args[i] === '--gzip') gzip = true
    }

    if (subcommand === 'extract') {
      if (!input || !workdir) {
        console.error('Usage: convert-snapshot extract --input <utxos.dat> --workdir <dir>')
        process.exit(1)
      }
      return { command: 'extract', input, workdir }
    } else {
      if (!workdir || !output) {
        console.error('Usage: convert-snapshot aggregate --workdir <dir> --output <snapshot.jsonl> [--gzip]')
        process.exit(1)
      }
      return { command: 'aggregate', workdir, output, gzip }
    }
  }

  // Legacy single-command mode
  let input = ''
  let output = ''
  let gzip = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) input = args[++i]
    else if (args[i] === '--output' && args[i + 1]) output = args[++i]
    else if (args[i] === '--gzip') gzip = true
  }

  if (!input || !output) {
    console.error('Usage: convert-snapshot --input <utxos.dat> --output <snapshot.jsonl> [--gzip]')
    console.error('       convert-snapshot extract --input <utxos.dat> --workdir <dir>')
    console.error('       convert-snapshot aggregate --workdir <dir> --output <snapshot.jsonl> [--gzip]')
    process.exit(1)
  }

  return { command: 'legacy', input, output, gzip }
}

// --- Checkpoint helpers ---

const CHECKPOINT_INTERVAL = 5_000_000n // every 5M coins

function loadCheckpoint(workdir: string): Checkpoint | null {
  const cpPath = join(workdir, 'checkpoint.json')
  if (!existsSync(cpPath)) return null
  try {
    return JSON.parse(readFileSync(cpPath, 'utf8')) as Checkpoint
  } catch {
    return null
  }
}

function writeCheckpointAtomic(workdir: string, cp: Checkpoint) {
  const cpPath = join(workdir, 'checkpoint.json')
  const tmpPath = cpPath + '.tmp'
  writeFileSync(tmpPath, JSON.stringify(cp, null, 2) + '\n')
  renameSync(tmpPath, cpPath)
}

// --- Phase 1: Extract ---

async function runExtract(input: string, workdir: string) {
  const startTime = Date.now()

  // Ensure workdir exists
  await mkdir(workdir, { recursive: true })

  const coinsPath = join(workdir, 'coins.jsonl')

  // Read header for metadata
  console.log(`Reading header from ${input}...`)
  const header = await parseHeader(input)
  console.log(`  Version:      ${header.version}`)
  console.log(`  Block hash:   ${header.blockHash}`)
  console.log(`  Coin count:   ${header.coinCount.toLocaleString()}`)
  console.log()

  // Check for existing checkpoint
  const checkpoint = loadCheckpoint(workdir)
  let resumeFrom: ResumeState | undefined
  let outputBytes = 0

  if (checkpoint) {
    const coinsRead = BigInt(checkpoint.coinsRead)
    const pct = Number(coinsRead * 100n / header.coinCount)
    console.log(`Resuming from checkpoint:`)
    console.log(`  Coins processed: ${coinsRead.toLocaleString()} (${pct}%)`)
    console.log(`  Byte offset:     ${checkpoint.bytesRead.toLocaleString()}`)
    console.log(`  Output size:     ${checkpoint.outputBytes.toLocaleString()} bytes`)
    console.log()

    // Truncate coins.jsonl to the checkpointed size (discard any partial writes after checkpoint)
    if (existsSync(coinsPath)) {
      truncateSync(coinsPath, checkpoint.outputBytes)
    }

    resumeFrom = { bytesRead: checkpoint.bytesRead, coinsRead }
    outputBytes = checkpoint.outputBytes
  } else {
    // Fresh start — remove any stale coins.jsonl
    if (existsSync(coinsPath)) {
      unlinkSync(coinsPath)
    }
    console.log('Starting fresh extraction...')
    console.log()
  }

  // Write header metadata to workdir for aggregate phase
  const metaPath = join(workdir, 'header.json')
  writeFileSync(metaPath, JSON.stringify({
    blockHash: header.blockHash,
    coinCount: header.coinCount.toString(),
  }) + '\n')

  // Open coins.jsonl in append mode
  const fd = openSync(coinsPath, 'a')

  // Track progress for checkpointing — these capture the latest values from the progress callback
  let latestBytesRead = resumeFrom ? resumeFrom.bytesRead : 0
  let latestCoinsRead = resumeFrom ? resumeFrom.coinsRead : 0n
  let coinsSinceCheckpoint = 0n

  const progressInterval = 1_000_000n

  try {
    for await (const coin of parseDumptxoutset(input, (bytes, coins) => {
      latestBytesRead = bytes
      latestCoinsRead = coins
      if (coins % progressInterval === 0n) {
        const pct = Number(coins * 100n / header.coinCount)
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
        const mbRead = (bytes / 1024 / 1024).toFixed(0)
        process.stdout.write(
          `\r  ${coins.toLocaleString()} / ${header.coinCount.toLocaleString()} coins (${pct}%) | ${mbRead} MB | ${elapsed}s`
        )
      }
    }, resumeFrom)) {

      // Include P2PKH, P2WPKH, and P2SH (P2SH-P2WPKH single-signer)
      if (coin.scriptType === 'p2pkh' || coin.scriptType === 'p2wpkh' || coin.scriptType === 'p2sh') {
        const line = JSON.stringify({
          a: coin.addressHash,
          b: coin.amount.toString(),
          t: coin.scriptType,
        }) + '\n'
        const buf = Buffer.from(line)
        writeSync(fd, buf)
        outputBytes += buf.length
      }

      coinsSinceCheckpoint++

      // Checkpoint every CHECKPOINT_INTERVAL coins, at group boundaries
      if (coinsSinceCheckpoint >= CHECKPOINT_INTERVAL && coin.isGroupEnd) {
        fdatasyncSync(fd)

        writeCheckpointAtomic(workdir, {
          bytesRead: latestBytesRead,
          coinsRead: latestCoinsRead.toString(),
          outputBytes,
        })

        coinsSinceCheckpoint = 0n

        const pct = Number(latestCoinsRead * 100n / header.coinCount)
        console.log(`  [checkpoint at ${latestCoinsRead.toLocaleString()} coins (${pct}%)]`)
      }
    }

    // Final sync
    fdatasyncSync(fd)
  } finally {
    closeSync(fd)
  }

  // Remove checkpoint on successful completion
  const cpPath = join(workdir, 'checkpoint.json')
  if (existsSync(cpPath)) unlinkSync(cpPath)

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n\nExtraction complete in ${elapsed}s`)
  console.log(`  Output: ${coinsPath}`)
  if (existsSync(coinsPath)) {
    const size = statSync(coinsPath).size
    console.log(`  Size:   ${(size / 1024 / 1024).toFixed(1)} MB`)
  }
}

// --- Phase 2: Aggregate (checkpointed sub-phases) ---
//
// Sub-phase A: Read coins.jsonl → aggregate in memory → write sorted balances.jsonl
// Sub-phase B: Stream balances.jsonl → compute merkle root → write final snapshot
//
// If the process crashes during B, sub-phase A's output (balances.jsonl) is
// already on disk and gets skipped on restart.

/**
 * Sub-phase A: Sort + aggregate coins into balances file.
 *
 * Uses external `sort` (disk-based merge sort) so memory stays constant
 * regardless of file size. Three checkpointed steps:
 *
 *   A1: sort coins.jsonl → sorted-coins.jsonl   (external sort, any file size)
 *   A2: stream sorted-coins.jsonl → balances.jsonl  (aggregate consecutive addresses)
 *
 * Each step skips if its output already exists.
 */
async function aggregateCoins(workdir: string) {
  const coinsPath = join(workdir, 'coins.jsonl')
  const sortedPath = join(workdir, 'sorted-coins.jsonl')
  const balancesPath = join(workdir, 'balances.jsonl')
  const balancesMetaPath = join(workdir, 'balances-meta.json')

  // Skip entirely if already completed
  if (existsSync(balancesPath) && existsSync(balancesMetaPath)) {
    const meta = JSON.parse(readFileSync(balancesMetaPath, 'utf8'))
    console.log(`Sub-phase A already complete (${Number(meta.addressCount).toLocaleString()} addresses). Skipping.`)
    return
  }

  // --- Step A1: External sort ---
  if (existsSync(sortedPath)) {
    console.log(`Step A1: sorted-coins.jsonl exists. Skipping sort.`)
  } else {
    console.log(`Step A1: Sorting coins.jsonl (external sort)...`)
    const sortStart = Date.now()

    // JSON lines sort correctly by address because "a" is the first field:
    //   {"a":"<40-char-hex>","b":"<amount>","t":"<type>"}
    // Lexicographic sort groups same-address lines together.
    // Use temp dir inside workdir so we don't fill /tmp.
    const sortTmpDir = join(workdir, 'sort-tmp')
    await mkdir(sortTmpDir, { recursive: true })

    execFileSync('sort', [
      '--parallel=2',
      '--buffer-size=1G',
      `--temporary-directory=${sortTmpDir}`,
      '-o', sortedPath,
      coinsPath,
    ], { stdio: 'inherit', timeout: 0, maxBuffer: 1024 })

    // Clean up sort temp files
    await rm(sortTmpDir, { recursive: true, force: true })

    const elapsed = ((Date.now() - sortStart) / 1000).toFixed(1)
    console.log(`  Sort complete in ${elapsed}s`)
  }

  // --- Step A2: Stream-aggregate sorted coins ---
  console.log(`Step A2: Aggregating sorted coins → balances.jsonl...`)
  const aggStart = Date.now()

  const fd = openSync(balancesPath + '.tmp', 'w')
  let addressCount = 0
  let totalCoins = 0n
  let totalClaimableValue = 0n
  let p2pkhCount = 0n
  let p2wpkhCount = 0n
  let p2shCount = 0n

  let currentAddr = ''
  let currentBalance = 0n
  let currentType = ''

  function flushAddress() {
    if (!currentAddr) return
    const obj: Record<string, string> = { a: currentAddr, b: currentBalance.toString() }
    if (currentType === 'p2sh') obj.t = 'p2sh'
    const line = JSON.stringify(obj) + '\n'
    writeSync(fd, line)
    addressCount++
  }

  try {
    const rl = createInterface({
      input: createReadStream(sortedPath),
      crlfDelay: Infinity,
    })

    for await (const line of rl) {
      if (!line) continue
      const entry = JSON.parse(line) as { a: string; b: string; t: string }
      const amount = BigInt(entry.b)

      if (entry.a !== currentAddr) {
        flushAddress()
        currentAddr = entry.a
        currentBalance = 0n
        currentType = entry.t
      }

      currentBalance += amount
      totalClaimableValue += amount
      totalCoins++

      if (entry.t === 'p2pkh') p2pkhCount++
      else if (entry.t === 'p2sh') p2shCount++
      else p2wpkhCount++

      if (totalCoins % 5_000_000n === 0n) {
        console.log(`  ${totalCoins.toLocaleString()} coins | ${addressCount.toLocaleString()} addresses`)
      }
    }

    // Flush last address
    flushAddress()
    fdatasyncSync(fd)
  } finally {
    closeSync(fd)
  }

  // Atomic rename
  renameSync(balancesPath + '.tmp', balancesPath)

  // Write metadata
  const meta = {
    addressCount,
    p2pkhCoins: p2pkhCount.toString(),
    p2wpkhCoins: p2wpkhCount.toString(),
    p2shCoins: p2shCount.toString(),
    totalCoins: totalCoins.toString(),
    totalClaimableSats: totalClaimableValue.toString(),
  }
  writeFileSync(balancesMetaPath, JSON.stringify(meta, null, 2) + '\n')

  const elapsed = ((Date.now() - aggStart) / 1000).toFixed(1)
  console.log(`\n  Aggregation complete in ${elapsed}s:`)
  console.log(`  Total coins:        ${totalCoins.toLocaleString()}`)
  console.log(`  P2PKH coins:        ${p2pkhCount.toLocaleString()}`)
  console.log(`  P2WPKH coins:       ${p2wpkhCount.toLocaleString()}`)
  console.log(`  P2SH coins:         ${p2shCount.toLocaleString()}`)
  console.log(`  Unique addresses:   ${addressCount.toLocaleString()}`)
  console.log(`  Total claimable:    ${(Number(totalClaimableValue) / 1e8).toFixed(2)} BTC`)
  console.log()
}

/** Sub-phase B: stream balances → merkle root → final snapshot */
async function finalizeSnapshot(workdir: string, output: string, gzip: boolean) {
  const balancesPath = join(workdir, 'balances.jsonl')
  const balancesMetaPath = join(workdir, 'balances-meta.json')
  const metaPath = join(workdir, 'header.json')

  if (!existsSync(balancesPath)) {
    console.error(`ERROR: ${balancesPath} not found. Run sub-phase A first.`)
    process.exit(1)
  }

  console.log('Sub-phase B: Computing merkle root (streaming)...')
  const startTime = Date.now()

  // Load metadata
  const balancesMeta = JSON.parse(readFileSync(balancesMetaPath, 'utf8'))
  let blockHash = ''
  if (existsSync(metaPath)) {
    const headerMeta = JSON.parse(await readFile(metaPath, 'utf8'))
    blockHash = headerMeta.blockHash
  }

  // Streaming merkle root: hash entries incrementally (constant memory)
  const encoder = new TextEncoder()
  const inner = sha256.create()
  let entryCount = 0

  const rl = createInterface({
    input: createReadStream(balancesPath),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line) continue
    const entry = JSON.parse(line) as { a: string; b: string; t?: string }
    const prefix = entry.t ? `${entry.t}:` : ''
    inner.update(encoder.encode(`${prefix}${entry.a}:${entry.b};`))
    entryCount++
    if (entryCount % 5_000_000 === 0) {
      process.stdout.write(`\r  Hashed ${entryCount.toLocaleString()} entries`)
    }
  }

  const merkleRoot = bytesToHex(sha256(inner.digest()))
  console.log(`\r  Merkle root: ${merkleRoot} (${entryCount.toLocaleString()} entries)`)

  // Write final snapshot
  console.log(`  Writing ${output}${gzip ? ' (gzipped)' : ''}...`)

  const headerLine = JSON.stringify({
    height: 0,
    hash: blockHash,
    count: Number(balancesMeta.addressCount),
    merkleRoot,
    p2pkhCoins: Number(balancesMeta.p2pkhCoins),
    p2wpkhCoins: Number(balancesMeta.p2wpkhCoins),
    p2shCoins: Number(balancesMeta.p2shCoins || '0'),
    totalClaimableSats: balancesMeta.totalClaimableSats,
  })

  // Stream balances.jsonl again → final output (avoids holding all entries in memory)
  async function* generateLines() {
    yield headerLine + '\n'
    const rl2 = createInterface({
      input: createReadStream(balancesPath),
      crlfDelay: Infinity,
    })
    for await (const line of rl2) {
      if (!line) continue
      const entry = JSON.parse(line) as { a: string; b: string; t?: string }
      yield JSON.stringify({ a: entry.a, b: Number(entry.b), ...(entry.t === 'p2sh' ? { t: 'p2sh' } : {}) }) + '\n'
    }
  }

  const readable = Readable.from(generateLines())

  if (gzip) {
    await pipeline(readable, createGzip({ level: 6 }), createWriteStream(output))
  } else {
    await pipeline(readable, createWriteStream(output))
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`  Sub-phase B done in ${elapsed}s\n`)
}

async function runAggregate(workdir: string, output: string, gzip: boolean) {
  const startTime = Date.now()

  const coinsPath = join(workdir, 'coins.jsonl')
  if (!existsSync(coinsPath)) {
    console.error(`ERROR: ${coinsPath} not found. Run extract first.`)
    process.exit(1)
  }

  // Sub-phase A: aggregate coins → sorted balances.jsonl
  await aggregateCoins(workdir)

  // Sub-phase B: stream balances → merkle root → final snapshot
  await finalizeSnapshot(workdir, output, gzip)

  // Clean up workdir on success
  console.log(`Cleaning up workdir...`)
  await rm(workdir, { recursive: true, force: true })

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`Done in ${elapsed}s`)
  console.log(`Output: ${output}`)
}

// --- Main ---

async function main() {
  const args = parseArgs()

  switch (args.command) {
    case 'extract':
      await runExtract(args.input, args.workdir)
      break
    case 'aggregate':
      await runAggregate(args.workdir, args.output, args.gzip)
      break
    case 'legacy': {
      // Run both phases with a temp workdir next to the output
      const workdir = args.output + '.work'
      console.log('Running full pipeline (extract + aggregate)...')
      console.log(`  Workdir: ${workdir}`)
      console.log()
      await runExtract(args.input, workdir)
      console.log()
      await runAggregate(workdir, args.output, args.gzip)
      break
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
