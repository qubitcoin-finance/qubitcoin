#!/usr/bin/env node
/**
 * Convert Bitcoin Core's dumptxoutset binary → QTC snapshot NDJSON
 *
 * Two-phase pipeline with checkpointed resume:
 *
 *   Phase 1 — Extract (slow, resumable):
 *     Parse binary → filter P2PKH+P2WPKH → append intermediate NDJSON
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
import { computeSnapshotMerkleRoot, type BtcAddressBalance } from '../snapshot.js'

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
  const args = process.argv.slice(2)
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

      // Only include P2PKH and P2WPKH
      if (coin.scriptType === 'p2pkh' || coin.scriptType === 'p2wpkh') {
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

// --- Phase 2: Aggregate ---

async function runAggregate(workdir: string, output: string, gzip: boolean) {
  const startTime = Date.now()

  const coinsPath = join(workdir, 'coins.jsonl')
  const metaPath = join(workdir, 'header.json')

  if (!existsSync(coinsPath)) {
    console.error(`ERROR: ${coinsPath} not found. Run extract first.`)
    process.exit(1)
  }

  // Load header metadata
  let blockHash = ''
  if (existsSync(metaPath)) {
    const meta = JSON.parse(await readFile(metaPath, 'utf8'))
    blockHash = meta.blockHash
  }

  console.log('Aggregating coins by address...')

  // Stream-read coins.jsonl and aggregate
  // Use plain object (Map hits V8 2^24 limit at ~16.7M entries)
  const balances: Record<string, bigint> = Object.create(null)
  let addressCount = 0
  let p2pkhCount = 0n
  let p2wpkhCount = 0n
  let totalCoins = 0n
  let totalClaimableValue = 0n

  const rl = createInterface({
    input: createReadStream(coinsPath),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line) continue
    const entry = JSON.parse(line) as { a: string; b: string; t: string }
    const amount = BigInt(entry.b)

    const prev = balances[entry.a]
    if (prev !== undefined) {
      balances[entry.a] = prev + amount
    } else {
      balances[entry.a] = amount
      addressCount++
    }

    totalClaimableValue += amount
    totalCoins++

    if (entry.t === 'p2pkh') p2pkhCount++
    else p2wpkhCount++

    if (totalCoins % 1_000_000n === 0n) {
      process.stdout.write(`\r  ${totalCoins.toLocaleString()} coins | ${addressCount.toLocaleString()} addresses`)
    }
  }

  console.log(`\n\nAggregation complete:`)
  console.log(`  Total coins:        ${totalCoins.toLocaleString()}`)
  console.log(`  P2PKH coins:        ${p2pkhCount.toLocaleString()}`)
  console.log(`  P2WPKH coins:       ${p2wpkhCount.toLocaleString()}`)
  console.log(`  Unique addresses:   ${addressCount.toLocaleString()}`)
  console.log(`  Total claimable:    ${(Number(totalClaimableValue) / 1e8).toFixed(2)} BTC`)
  console.log()

  // Compute merkle root over sorted entries
  console.log('Computing merkle root...')

  const sortedAddrs = Object.keys(balances).sort()

  const entries: BtcAddressBalance[] = sortedAddrs.map((addr) => ({
    btcAddress: addr,
    amount: Number(balances[addr]),
  }))

  const merkleRoot = computeSnapshotMerkleRoot(entries)
  console.log(`  Merkle root: ${merkleRoot}`)
  console.log()

  // Write NDJSON output
  console.log(`Writing ${output}${gzip ? ' (gzipped)' : ''}...`)

  const headerLine = JSON.stringify({
    height: 0,
    hash: blockHash,
    count: addressCount,
    merkleRoot,
    p2pkhCoins: Number(p2pkhCount),
    p2wpkhCoins: Number(p2wpkhCount),
    totalClaimableSats: totalClaimableValue.toString(),
  })

  async function* generateLines() {
    yield headerLine + '\n'
    for (const addr of sortedAddrs) {
      yield JSON.stringify({ a: addr, b: Number(balances[addr]) }) + '\n'
    }
  }

  const readable = Readable.from(generateLines())

  if (gzip) {
    await pipeline(readable, createGzip({ level: 6 }), createWriteStream(output))
  } else {
    await pipeline(readable, createWriteStream(output))
  }

  // Clean up workdir on success
  console.log(`Cleaning up workdir...`)
  await rm(workdir, { recursive: true, force: true })

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\nDone in ${elapsed}s`)
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
