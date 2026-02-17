/**
 * BTC → qbtc claim transaction logic
 *
 * Allows Bitcoin holders to prove ECDSA ownership and receive
 * post-quantum (ML-DSA-65) native UTXOs on the qbtc chain.
 */
import {
  doubleSha256,
  ecdsaSign,
  verifyEcdsaSignature,
  schnorrSign,
  verifySchnorrSignature,
  computeTaprootOutputKey,
  hash160,
  deriveP2shP2wpkhAddress,
  deriveP2shMultisigAddress,
  deriveP2wshAddress,
  parseWitnessScript,
  bytesToHex,
  concatBytes,
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
 * Format: "QBTC_CLAIM:<btcAddress>:<qbtcAddress>:<snapshotBlockHash>:<genesisHash>"
 * This ensures replay protection (snapshot hash + genesis hash) and address binding (qbtc address).
 * The genesis hash prevents cross-fork replay attacks.
 */
export function serializeClaimMessage(
  btcAddress: string,
  qbtcAddress: string,
  snapshotBlockHash: string,
  genesisHash: string
): Uint8Array {
  const msg = `QBTC_CLAIM:${btcAddress}:${qbtcAddress}:${snapshotBlockHash}:${genesisHash}`
  return doubleSha256(new TextEncoder().encode(msg))
}

/**
 * Create a claim transaction.
 * The BTC holder signs a message with their ECDSA key, proving ownership.
 * The output goes to their new ML-DSA-65 qbtc address.
 */
export function createClaimTransaction(
  btcSecretKey: Uint8Array,
  btcPubKey: Uint8Array,
  entry: BtcAddressBalance,
  qbtcWallet: Wallet,
  snapshotBlockHash: string,
  genesisHash: string = ''
): Transaction {
  const claimMsgHash = serializeClaimMessage(
    entry.btcAddress,
    qbtcWallet.address,
    snapshotBlockHash,
    genesisHash
  )

  let claimData: ClaimData

  if (entry.type === 'p2tr') {
    // P2TR: sign with Schnorr (BIP340), btcPubKey is 32-byte x-only internal key
    const schnorrSig = schnorrSign(claimMsgHash, btcSecretKey)
    claimData = {
      btcAddress: entry.btcAddress,
      ecdsaPublicKey: new Uint8Array(0),
      ecdsaSignature: new Uint8Array(0),
      qbtcAddress: qbtcWallet.address,
      schnorrPublicKey: btcPubKey,
      schnorrSignature: schnorrSig,
    }
  } else {
    // P2PKH / P2WPKH / P2SH-P2WPKH: sign with ECDSA
    const ecdsaSig = ecdsaSign(claimMsgHash, btcSecretKey)
    claimData = {
      btcAddress: entry.btcAddress,
      ecdsaPublicKey: btcPubKey,
      ecdsaSignature: ecdsaSig,
      qbtcAddress: qbtcWallet.address,
    }
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
    { address: qbtcWallet.address, amount: entry.amount },
  ]

  const id = computeTxId(
    [{ txId: CLAIM_TXID, outputIndex: 0 }],
    outputs,
    timestamp
  )

  return { id, inputs, outputs, timestamp, claimData }
}

/**
 * Create a P2WSH claim transaction.
 * Multiple signers provide ECDSA signatures over the claim message to satisfy the witness script.
 * signerSecretKeys must be ordered to match the pubkey order in the witness script.
 */
export function createP2wshClaimTransaction(
  signerSecretKeys: Uint8Array[],
  witnessScript: Uint8Array,
  entry: BtcAddressBalance,
  qbtcWallet: Wallet,
  snapshotBlockHash: string,
  genesisHash: string = ''
): Transaction {
  // Verify witness script hashes to the claimed address
  const derivedAddr = deriveP2wshAddress(witnessScript)
  if (derivedAddr !== entry.btcAddress) {
    throw new Error('Witness script does not match P2WSH address')
  }

  const claimMsgHash = serializeClaimMessage(
    entry.btcAddress,
    qbtcWallet.address,
    snapshotBlockHash,
    genesisHash
  )

  // Each signer signs the claim message
  const sigs: Uint8Array[] = []
  for (const sk of signerSecretKeys) {
    sigs.push(ecdsaSign(claimMsgHash, sk))
  }
  const witnessSignatures = concatBytes(...sigs)

  const claimData: ClaimData = {
    btcAddress: entry.btcAddress,
    ecdsaPublicKey: new Uint8Array(0),
    ecdsaSignature: new Uint8Array(0),
    qbtcAddress: qbtcWallet.address,
    witnessScript,
    witnessSignatures,
  }

  const timestamp = Date.now()
  const inputs = [
    {
      txId: CLAIM_TXID,
      outputIndex: 0,
      publicKey: new Uint8Array(0),
      signature: new Uint8Array(0),
    },
  ]
  const outputs: TransactionOutput[] = [
    { address: qbtcWallet.address, amount: entry.amount },
  ]
  const id = computeTxId(
    [{ txId: CLAIM_TXID, outputIndex: 0 }],
    outputs,
    timestamp
  )

  return { id, inputs, outputs, timestamp, claimData }
}

/**
 * Create a P2SH multisig claim transaction.
 * Same as P2WSH but address = HASH160(redeemScript) instead of SHA256(witnessScript).
 * signerSecretKeys must be ordered to match the pubkey order in the redeem script.
 */
export function createP2shMultisigClaimTransaction(
  signerSecretKeys: Uint8Array[],
  redeemScript: Uint8Array,
  entry: BtcAddressBalance,
  qbtcWallet: Wallet,
  snapshotBlockHash: string,
  genesisHash: string = ''
): Transaction {
  const derivedAddr = deriveP2shMultisigAddress(redeemScript)
  if (derivedAddr !== entry.btcAddress) {
    throw new Error('Redeem script does not match P2SH address')
  }

  const claimMsgHash = serializeClaimMessage(
    entry.btcAddress,
    qbtcWallet.address,
    snapshotBlockHash,
    genesisHash
  )

  const sigs: Uint8Array[] = []
  for (const sk of signerSecretKeys) {
    sigs.push(ecdsaSign(claimMsgHash, sk))
  }
  const witnessSignatures = concatBytes(...sigs)

  const claimData: ClaimData = {
    btcAddress: entry.btcAddress,
    ecdsaPublicKey: new Uint8Array(0),
    ecdsaSignature: new Uint8Array(0),
    qbtcAddress: qbtcWallet.address,
    witnessScript: redeemScript,
    witnessSignatures,
  }

  const timestamp = Date.now()
  const inputs = [
    {
      txId: CLAIM_TXID,
      outputIndex: 0,
      publicKey: new Uint8Array(0),
      signature: new Uint8Array(0),
    },
  ]
  const outputs: TransactionOutput[] = [
    { address: qbtcWallet.address, amount: entry.amount },
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
  snapshot: BtcSnapshot,
  genesisHash: string = ''
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

  const claimMsgHash = serializeClaimMessage(
    claim.btcAddress,
    claim.qbtcAddress,
    snapshot.btcBlockHash,
    genesisHash
  )

  if (entry.type === 'p2wsh' || entry.type === 'multisig') {
    // P2WSH / bare multisig: verify script hash matches address, then verify signatures
    // Both use SHA256(script) as address and same m-of-n CHECKMULTISIG verification
    const typeLabel = entry.type === 'multisig' ? 'Bare multisig' : 'P2WSH'
    if (!claim.witnessScript || claim.witnessScript.length === 0) {
      return { valid: false, error: `${typeLabel} claim missing witness script` }
    }
    const derivedAddress = deriveP2wshAddress(claim.witnessScript)
    if (derivedAddress !== claim.btcAddress) {
      return { valid: false, error: `Script does not match ${typeLabel} address in snapshot` }
    }

    let parsed: ReturnType<typeof parseWitnessScript>
    try {
      parsed = parseWitnessScript(claim.witnessScript)
    } catch {
      return { valid: false, error: 'Failed to parse witness script' }
    }

    if (parsed.type === 'single-key') {
      // Single-key P2WSH: PUSH33 <pubkey> OP_CHECKSIG
      if (!claim.witnessSignatures || claim.witnessSignatures.length !== 64) {
        return { valid: false, error: 'P2WSH single-key claim requires exactly one 64-byte signature' }
      }
      if (!verifyEcdsaSignature(claim.witnessSignatures, claimMsgHash, parsed.pubkey)) {
        return { valid: false, error: 'Invalid ECDSA signature for P2WSH single-key' }
      }
    } else {
      // Multisig: verify m-of-n CHECKMULTISIG-style ordered signatures
      const { m, pubkeys } = parsed
      if (!claim.witnessSignatures || claim.witnessSignatures.length !== m * 64) {
        return { valid: false, error: `P2WSH ${m}-of-${pubkeys.length} claim requires exactly ${m} signatures (${m * 64} bytes)` }
      }

      // Extract individual signatures
      const sigs: Uint8Array[] = []
      for (let i = 0; i < m; i++) {
        sigs.push(claim.witnessSignatures.slice(i * 64, (i + 1) * 64))
      }

      // CHECKMULTISIG ordering: walk pubkeys in order, match signatures in order
      let sigIdx = 0
      for (let pkIdx = 0; pkIdx < pubkeys.length && sigIdx < m; pkIdx++) {
        if (verifyEcdsaSignature(sigs[sigIdx], claimMsgHash, pubkeys[pkIdx])) {
          sigIdx++
        }
      }
      if (sigIdx < m) {
        return { valid: false, error: `Only ${sigIdx} of ${m} required signatures verified` }
      }
    }
  } else if (entry.type === 'p2tr') {
    // P2TR: verify Schnorr signature against internal key, check tweaked key matches address
    if (!claim.schnorrPublicKey || claim.schnorrPublicKey.length !== 32) {
      return { valid: false, error: 'P2TR claim missing 32-byte Schnorr public key' }
    }
    if (!claim.schnorrSignature || claim.schnorrSignature.length !== 64) {
      return { valid: false, error: 'P2TR claim missing 64-byte Schnorr signature' }
    }

    // Compute tweaked output key Q from internal key P, check it matches snapshot address
    let derivedAddress: string
    try {
      derivedAddress = bytesToHex(computeTaprootOutputKey(claim.schnorrPublicKey))
    } catch {
      return { valid: false, error: 'Invalid P2TR public key' }
    }
    if (derivedAddress !== claim.btcAddress) {
      return {
        valid: false,
        error: 'Schnorr public key does not match P2TR address in snapshot',
      }
    }

    // Verify Schnorr signature against internal key
    if (!verifySchnorrSignature(claim.schnorrSignature, claimMsgHash, claim.schnorrPublicKey)) {
      return { valid: false, error: 'Invalid Schnorr signature' }
    }
  } else if (entry.type === 'p2sh') {
    if (claim.witnessScript && claim.witnessScript.length > 0) {
      // P2SH multisig: HASH160(redeemScript) === btcAddress
      const derivedAddress = deriveP2shMultisigAddress(claim.witnessScript)
      if (derivedAddress !== claim.btcAddress) {
        return { valid: false, error: 'Redeem script does not match P2SH address in snapshot' }
      }

      let parsed: ReturnType<typeof parseWitnessScript>
      try {
        parsed = parseWitnessScript(claim.witnessScript)
      } catch {
        return { valid: false, error: 'Failed to parse redeem script' }
      }

      if (parsed.type === 'single-key') {
        if (!claim.witnessSignatures || claim.witnessSignatures.length !== 64) {
          return { valid: false, error: 'P2SH single-key claim requires exactly one 64-byte signature' }
        }
        if (!verifyEcdsaSignature(claim.witnessSignatures, claimMsgHash, parsed.pubkey)) {
          return { valid: false, error: 'Invalid ECDSA signature for P2SH single-key' }
        }
      } else {
        const { m, pubkeys } = parsed
        if (!claim.witnessSignatures || claim.witnessSignatures.length !== m * 64) {
          return { valid: false, error: `P2SH ${m}-of-${pubkeys.length} claim requires exactly ${m} signatures (${m * 64} bytes)` }
        }

        const sigs: Uint8Array[] = []
        for (let i = 0; i < m; i++) {
          sigs.push(claim.witnessSignatures.slice(i * 64, (i + 1) * 64))
        }

        let sigIdx = 0
        for (let pkIdx = 0; pkIdx < pubkeys.length && sigIdx < m; pkIdx++) {
          if (verifyEcdsaSignature(sigs[sigIdx], claimMsgHash, pubkeys[pkIdx])) {
            sigIdx++
          }
        }
        if (sigIdx < m) {
          return { valid: false, error: `Only ${sigIdx} of ${m} required signatures verified` }
        }
      }
    } else {
      // P2SH-P2WPKH: HASH160(0x0014 || HASH160(pubkey)) === btcAddress
      const derivedAddress = deriveP2shP2wpkhAddress(claim.ecdsaPublicKey)
      if (derivedAddress !== claim.btcAddress) {
        return {
          valid: false,
          error: 'ECDSA public key does not match P2SH-P2WPKH address in snapshot',
        }
      }

      if (!verifyEcdsaSignature(claim.ecdsaSignature, claimMsgHash, claim.ecdsaPublicKey)) {
        return { valid: false, error: 'Invalid ECDSA signature' }
      }
    }
  } else {
    // P2PKH/P2WPKH: HASH160(pubkey) === btcAddress
    const derivedAddress = bytesToHex(hash160(claim.ecdsaPublicKey))
    if (derivedAddress !== claim.btcAddress) {
      return {
        valid: false,
        error: 'ECDSA public key does not match BTC address in snapshot',
      }
    }

    if (!verifyEcdsaSignature(claim.ecdsaSignature, claimMsgHash, claim.ecdsaPublicKey)) {
      return { valid: false, error: 'Invalid ECDSA signature' }
    }
  }

  // Verify output amount matches snapshot
  if (tx.outputs.length !== 1 || tx.outputs[0].amount !== entry.amount) {
    return {
      valid: false,
      error: `Output amount mismatch: expected ${entry.amount}`,
    }
  }

  // Verify output goes to the claimed address
  if (tx.outputs[0].address !== claim.qbtcAddress) {
    return {
      valid: false,
      error: 'Output address does not match claim destination',
    }
  }

  return { valid: true }
}
