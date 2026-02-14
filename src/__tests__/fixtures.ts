/**
 * Shared test fixtures — generated once per vitest worker process.
 * Avoids redundant ML-DSA-65 keygen across test files that run in the same worker.
 */
import { generateWallet } from '../crypto.js'

export const walletA = generateWallet()
export const walletB = generateWallet()
export const walletC = generateWallet()
