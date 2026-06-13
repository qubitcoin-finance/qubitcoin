import { utxoKey, type UTXO } from '../transaction.js'

// ML-DSA-65 txs are ~5KB, so we need fee >= ~5 sat to meet 1 sat/KB minimum
export const DEFAULT_FEE = 10_000
export const DEFAULT_AMOUNT = 10_000_000_000

export function makeUtxoSet(wallet: { address: string }, amount = DEFAULT_AMOUNT): Map<string, UTXO> {
  const utxoSet = new Map<string, UTXO>()
  const txId = 'a'.repeat(64)
  utxoSet.set(utxoKey(txId, 0), {
    txId,
    outputIndex: 0,
    address: wallet.address,
    amount,
  })
  return utxoSet
}
