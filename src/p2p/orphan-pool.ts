import { type Block, computeBlockHash, hashMeetsTarget } from '../block.js'

export interface OrphanBlock {
  block: Block
  receivedAt: number
}

export class OrphanBlockPool {
  private readonly orphanBlocks: Map<string, OrphanBlock> = new Map()

  constructor(
    private readonly maxBlocks: number,
    private readonly expiryMs: number,
  ) {}

  get size(): number {
    return this.orphanBlocks.size
  }

  has(parentHash: string): boolean {
    return this.orphanBlocks.has(parentHash)
  }

  take(parentHash: string): OrphanBlock | null {
    const orphan = this.orphanBlocks.get(parentHash)
    if (!orphan) return null
    this.orphanBlocks.delete(parentHash)
    return orphan
  }

  add(block: Block, now = Date.now()): boolean {
    if (computeBlockHash(block.header) !== block.hash) return false
    if (!hashMeetsTarget(block.hash, block.header.target)) return false

    this.expire(now)

    if (this.orphanBlocks.size >= this.maxBlocks) {
      this.evictOldest()
    }

    const parentHash = block.header.previousHash
    if (this.orphanBlocks.has(parentHash)) return false

    this.orphanBlocks.set(parentHash, { block, receivedAt: now })
    return true
  }

  expire(now = Date.now()): void {
    const cutoff = now - this.expiryMs
    for (const [key, orphan] of this.orphanBlocks) {
      if (orphan.receivedAt < cutoff) {
        this.orphanBlocks.delete(key)
      }
    }
  }

  private evictOldest(): void {
    let oldestKey = ''
    let oldestTime = Infinity
    for (const [key, orphan] of this.orphanBlocks) {
      if (orphan.receivedAt < oldestTime) {
        oldestTime = orphan.receivedAt
        oldestKey = key
      }
    }
    if (oldestKey) this.orphanBlocks.delete(oldestKey)
  }
}
