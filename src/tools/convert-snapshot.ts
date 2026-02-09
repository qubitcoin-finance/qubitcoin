#!/usr/bin/env node
/**
 * Convert Bitcoin Core's dumptxoutset binary → QTC snapshot NDJSON
 *
 * Pipeline: parse binary → filter P2PKH+P2WPKH → aggregate by address → output
 *
 * Usage:
 *   pnpm run convert-snapshot -- --input ~/utxos.dat --output ~/qtc-snapshot.jsonl
 *   pnpm run convert-snapshot -- --input ~/utxos.dat --output ~/qtc-snapshot.jsonl.gz --gzip
 */
import { createWriteStream } from 'node:fs'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { parseDumptxoutset, parseHeader } from './parse-utxoset.js'
import { computeSnapshotMerkleRoot, type BtcAddressBalance } from '../snapshot.js'

// --- CLI args ---

function parseArgs(): { input: string; output: string; gzip: boolean } {
  const args = process.argv.slice(2)
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
    process.exit(1)
  }

  return { input, output, gzip }
}

// --- Main ---

async function main() {
  const { input, output, gzip } = parseArgs()
  const startTime = Date.now()

  // Parse header first for metadata
  console.log(`Reading header from ${input}...`)
  const header = await parseHeader(input)
  console.log(`  Version:      ${header.version}`)
  console.log(`  Block hash:   ${header.blockHash}`)
  console.log(`  Coin count:   ${header.coinCount.toLocaleString()}`)
  console.log()

  // Aggregate balances per address
  // Key: 40-char hex address hash, Value: total satoshis (bigint)
  const balances = new Map<string, bigint>()

  let totalCoins = 0n
  let p2pkhCount = 0n
  let p2wpkhCount = 0n
  let skippedCount = 0n
  let totalClaimableValue = 0n

  console.log('Parsing and aggregating...')

  const progressInterval = 1_000_000n

  for await (const coin of parseDumptxoutset(input, (bytes, coins) => {
    if (coins % progressInterval === 0n) {
      const pct = Number(coins * 100n / header.coinCount)
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      const mbRead = (bytes / 1024 / 1024).toFixed(0)
      process.stdout.write(
        `\r  ${coins.toLocaleString()} / ${header.coinCount.toLocaleString()} coins (${pct}%) | ${mbRead} MB | ${elapsed}s | ${balances.size.toLocaleString()} addresses`
      )
    }
  })) {
    totalCoins++

    // Only include P2PKH and P2WPKH (both use HASH160 of compressed pubkey)
    if (coin.scriptType === 'p2pkh' || coin.scriptType === 'p2wpkh') {
      const addr = coin.addressHash!
      const prev = balances.get(addr) ?? 0n
      balances.set(addr, prev + coin.amount)
      totalClaimableValue += coin.amount

      if (coin.scriptType === 'p2pkh') p2pkhCount++
      else p2wpkhCount++
    } else {
      skippedCount++
    }
  }

  console.log(`\n\nAggregation complete:`)
  console.log(`  Total coins parsed: ${totalCoins.toLocaleString()}`)
  console.log(`  P2PKH coins:        ${p2pkhCount.toLocaleString()}`)
  console.log(`  P2WPKH coins:       ${p2wpkhCount.toLocaleString()}`)
  console.log(`  Skipped (other):    ${skippedCount.toLocaleString()}`)
  console.log(`  Unique addresses:   ${balances.size.toLocaleString()}`)
  console.log(`  Total claimable:    ${(Number(totalClaimableValue) / 1e8).toFixed(2)} BTC`)
  console.log()

  // Compute merkle root over sorted entries
  console.log('Computing merkle root...')

  // Sort by address for deterministic ordering
  const sortedAddrs = Array.from(balances.keys()).sort()

  // Build entries for merkle root (convert bigint to number for compatibility)
  // Note: for real snapshot with amounts > Number.MAX_SAFE_INTEGER, would need bigint support
  const entries: BtcAddressBalance[] = sortedAddrs.map((addr) => ({
    btcAddress: addr,
    amount: Number(balances.get(addr)!),
  }))

  const merkleRoot = computeSnapshotMerkleRoot(entries)
  console.log(`  Merkle root: ${merkleRoot}`)
  console.log()

  // Write NDJSON output
  console.log(`Writing ${output}${gzip ? ' (gzipped)' : ''}...`)

  const headerLine = JSON.stringify({
    height: 0, // will be filled from RPC metadata
    hash: header.blockHash,
    count: balances.size,
    merkleRoot,
    p2pkhCoins: Number(p2pkhCount),
    p2wpkhCoins: Number(p2wpkhCount),
    totalClaimableSats: totalClaimableValue.toString(),
  })

  async function* generateLines() {
    yield headerLine + '\n'
    for (const addr of sortedAddrs) {
      yield JSON.stringify({ a: addr, b: Number(balances.get(addr)!) }) + '\n'
    }
  }

  const readable = Readable.from(generateLines())

  if (gzip) {
    await pipeline(readable, createGzip({ level: 6 }), createWriteStream(output))
  } else {
    await pipeline(readable, createWriteStream(output))
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\nDone in ${elapsed}s`)
  console.log(`Output: ${output}`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
