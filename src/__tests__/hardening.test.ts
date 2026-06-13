/**
 * Hardening tests are split by subject into sibling suites.
 */
import { describe, expect, it } from 'vitest'

describe('hardening test split', () => {
  it('keeps this target retired after subject suites were extracted', () => {
    expect(true).toBe(true)
  })
})
