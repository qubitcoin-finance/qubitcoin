import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 5_000, // keep tests fast — slow tests indicate bad test design
    include: ['src/__tests__/**/*.test.ts'],
    env: { LOG_LEVEL: 'silent' },
    pool: 'threads',
    maxWorkers: 1,
    isolate: false, // share ML-DSA-65 wallet fixtures across all test files
  },
})
