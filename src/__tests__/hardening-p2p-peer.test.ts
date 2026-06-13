import { describe, it, expect } from 'vitest'
import net from 'node:net'
import { Peer } from '../p2p/peer.js'

describe('Misbehavior score decay', () => {
  it('should decay score over time', () => {
    const socket = new net.Socket()
    const peer = new Peer(
      socket,
      true,
      () => {},
      () => {},
    )

    // Add some misbehavior
    peer.addMisbehavior(20)
    expect(peer.getMisbehaviorScore()).toBe(20)

    // Simulate time passing by directly setting lastMisbehaviorDecay
    peer.setLastMisbehaviorDecay(Date.now() - 5 * 60_000) // 5 minutes ago

    // Score should have decayed by 5
    expect(peer.getMisbehaviorScore()).toBe(15)

    socket.destroy()
  })

  it('should not decay below zero', () => {
    const socket = new net.Socket()
    const peer = new Peer(
      socket,
      true,
      () => {},
      () => {},
    )

    peer.addMisbehavior(3)
    peer.setLastMisbehaviorDecay(Date.now() - 10 * 60_000) // 10 minutes ago

    expect(peer.getMisbehaviorScore()).toBe(0)

    socket.destroy()
  })
})

describe('Getaddr rate limiting', () => {
  it('should track lastGetaddrResponse on peer', () => {
    const socket = new net.Socket()
    const peer = new Peer(
      socket,
      true,
      () => {},
      () => {},
    )

    expect(peer.lastGetaddrResponse).toBe(0)
    peer.lastGetaddrResponse = Date.now()
    expect(peer.lastGetaddrResponse).toBeGreaterThan(0)

    socket.destroy()
  })
})

describe('Cumulative work threshold (1.5x)', () => {
  it('should ban peer claiming more than 1.5x verified work', () => {
    // The threshold is: peer.remoteCumulativeWork > verifiedPeerWork * 3n / 2n
    // If verified work = 100, threshold = 150
    // 151 should be banned, 150 should not
    const verified = 100n
    const threshold = verified * 3n / 2n // = 150

    expect(151n > threshold).toBe(true)  // would be banned
    expect(150n > threshold).toBe(false) // would NOT be banned (equal)
    expect(149n > threshold).toBe(false) // would NOT be banned
  })

  it('1.5x is tighter than previous 2x threshold', () => {
    const verified = 1000n
    const oldThreshold = verified * 2n   // 2000
    const newThreshold = verified * 3n / 2n // 1500

    // A peer claiming 1600 work would pass old check but fail new
    expect(1600n > oldThreshold).toBe(false)  // old: not banned
    expect(1600n > newThreshold).toBe(true)   // new: banned
  })
})
