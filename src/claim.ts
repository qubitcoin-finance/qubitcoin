/**
 * BTC → qcoin claim transaction logic
 *
 * Allows Bitcoin holders to prove ECDSA ownership and receive
 * post-quantum (ML-DSA-65) native UTXOs on the qcoin chain.
 */
import {
  doubleSha256,
  ecdsaSign,
  verifyEcdsaSignature,
  hash160,
  deriveP2shP2wpkhAddress,
  bytesToHex,
  type Wallet,
} from './crypto.js'
import {
  type Transaction,
  type ClaimData,
  type TransactionOutput,
  CLAIM_TXID,
  computeTxId,
} from './transaction.js'
import { type BtcSnapshot, type BtcAddressBalance, getSnapshotIndex } from './snapshot.js'

/**
 * Serialize the claim message that gets ECDSA-signed.
 * Format: "QTC_CLAIM:<btcAddress>:<qcoinAddress>:<snapshotBlockHash>"
 * This ensures replay protection (snapshot hash) and address binding (qcoin address).
 */
export function serializeClaimMessage(
  btcAddress: string,
  qcoinAddress: string,
  snapshotBlockHash: string
): Uint8Array {
  const msg = `QTC_CLAIM:${btcAddress}:${qcoinAddress}:${snapshotBlockHash}`
  return doubleSha256(new TextEncoder().encode(msg))
}

/**
 * Create a claim transaction.
 * The BTC holder signs a message with their ECDSA key, proving ownership.
 * The output goes to their new ML-DSA-65 qcoin address.
 */
export function createClaimTransaction(
  btcSecretKey: Uint8Array,
  btcPubKey: Uint8Array,
  entry: BtcAddressBalance,
  qcoinWallet: Wallet,
  snapshotBlockHash: string
): Transaction {
  // Sign the claim message with ECDSA
  const claimMsgHash = serializeClaimMessage(
    entry.btcAddress,
    qcoinWallet.address,
    snapshotBlockHash
  )
  const ecdsaSig = ecdsaSign(claimMsgHash, btcSecretKey)

  const claimData: ClaimData = {
    btcAddress: entry.btcAddress,
    ecdsaPublicKey: btcPubKey,
    ecdsaSignature: ecdsaSig,
    qcoinAddress: qcoinWallet.address,
  }

  const timestamp = Date.now()

  // Claim tx uses CLAIM_TXID sentinel as input (like coinbase uses COINBASE_TXID)
  const inputs = [
    {
      txId: CLAIM_TXID,
      outputIndex: 0,
      publicKey: new Uint8Array(0),
      signature: new Uint8Array(0),
    },
  ]

  const outputs: TransactionOutput[] = [
    { address: qcoinWallet.address, amount: entry.amount },
  ]

  const id = computeTxId(
    [{ txId: CLAIM_TXID, outputIndex: 0 }],
    outputs,
    timestamp
  )

  return { id, inputs, outputs, timestamp, claimData }
}

/**
 * Verify a claim transaction's ECDSA proof against the BTC snapshot.
 *
 * Checks:
 * 1. The BTC address exists in the snapshot
 * 2. HASH160(ecdsaPubKey) matches the claimed address
 * 3. The ECDSA signature is valid for the claim message
 * 4. The output amount matches the snapshot amount
 */
export function verifyClaimProof(
  tx: Transaction,
  snapshot: BtcSnapshot
): { valid: boolean; error?: string } {
  const claim = tx.claimData
  if (!claim) {
    return { valid: false, error: 'Transaction has no claim data' }
  }

  // Find the BTC address in the snapshot (O(1) via cached index)
  const index = getSnapshotIndex(snapshot)
  const entry = index.get(claim.btcAddress)
  if (!entry) {
    return {
      valid: false,
      error: `BTC address ${claim.btcAddress} not found in snapshot`,
    }
  }

  // Verify public key matches the claimed address
  // P2SH-P2WPKH: HASH160(0x0014 || HASH160(pubkey)) === btcAddress
  // P2PKH/P2WPKH: HASH160(pubkey) === btcAddress
  if (entry.type === 'p2sh') {
    const derivedAddress = deriveP2shP2wpkhAddress(claim.ecdsaPublicKey)
    if (derivedAddress !== claim.btcAddress) {
      return {
        valid: false,
        error: 'ECDSA public key does not match P2SH-P2WPKH address in snapshot',
      }
    }
  } else {
    const derivedAddress = bytesToHex(hash160(claim.ecdsaPublicKey))
    if (derivedAddress !== claim.btcAddress) {
      return {
        valid: false,
        error: 'ECDSA public key does not match BTC address in snapshot',
      }
    }
  }

  // Verify ECDSA signature
  const claimMsgHash = serializeClaimMessage(
    claim.btcAddress,
    claim.qcoinAddress,
    snapshot.btcBlockHash
  )
  if (!verifyEcdsaSignature(claim.ecdsaSignature, claimMsgHash, claim.ecdsaPublicKey)) {
    return { valid: false, error: 'Invalid ECDSA signature' }
  }

  // Verify output amount matches snapshot
  if (tx.outputs.length !== 1 || tx.outputs[0].amount !== entry.amount) {
    return {
      valid: false,
      error: `Output amount mismatch: expected ${entry.amount}`,
    }
  }

  // Verify output goes to the claimed address
  if (tx.outputs[0].address !== claim.qcoinAddress) {
    return {
      valid: false,
      error: 'Output address does not match claim destination',
    }
  }

  return { valid: true }
}
