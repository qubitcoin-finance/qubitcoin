import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 30_000, // PoW mining + PQC keygen can be slow
  },
})
