import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { SnapshotAddressLookup } from './explorer-api';

const CLAIM_TXID = 'c'.repeat(64);
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export type ClaimCredentialFormat = 'hex' | 'wif' | 'seed';

export interface QbtcWalletExport {
  address: string;
  publicKey: string;
  secretKey: string;
}

export interface ClaimCandidate {
  label: string;
  path?: string;
  btcAddress: string;
  type: SnapshotAddressLookup['type'];
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

interface BrowserWallet {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  address: string;
}

interface BrowserClaimData {
  btcAddress: string;
  ecdsaPublicKey: Uint8Array;
  ecdsaSignature: Uint8Array;
  qbtcAddress: string;
  schnorrPublicKey?: Uint8Array;
  schnorrSignature?: Uint8Array;
}

interface BrowserTransaction {
  id: string;
  inputs: Array<{ txId: string; outputIndex: number; publicKey: Uint8Array; signature: Uint8Array }>;
  outputs: Array<{ address: string; amount: number }>;
  timestamp: number;
  claimData: BrowserClaimData;
}

export function detectCredentialFormat(input: string): ClaimCredentialFormat {
  const trimmed = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return 'hex';
  if (/^5[1-9A-HJ-NP-Za-km-z]{50}$/.test(trimmed)) {
    throw new Error('Uncompressed WIF keys are not supported in the browser claim builder. Use a compressed WIF key starting with K or L, a 64-character hex private key, or the CLI claim tool.');
  }
  if (/^[KL][1-9A-HJ-NP-Za-km-z]{51}$/.test(trimmed)) return 'wif';
  if (trimmed.split(/\s+/).length >= 12) return 'seed';
  throw new Error('Expected a 64-character hex private key, compressed WIF key starting with K or L, or 12/24-word BIP39 seed phrase.');
}

export function generateQbtcWallet(): { wallet: BrowserWallet; exportable: QbtcWalletExport } {
  const keys = ml_dsa65.keygen();
  const wallet = {
    publicKey: keys.publicKey,
    secretKey: keys.secretKey,
    address: bytesToHex(sha256(keys.publicKey)),
  };
  return {
    wallet,
    exportable: {
      address: wallet.address,
      publicKey: bytesToHex(wallet.publicKey),
      secretKey: bytesToHex(wallet.secretKey),
    },
  };
}

export function makeAddressOnlyWallet(address: string): BrowserWallet {
  if (!/^[0-9a-f]{64}$/i.test(address)) {
    throw new Error('QBTC destination must be a 64-character hex address.');
  }
  return {
    publicKey: new Uint8Array(0),
    secretKey: new Uint8Array(0),
    address: address.toLowerCase(),
  };
}

export function deriveClaimCandidates(input: string): ClaimCandidate[] {
  const format = detectCredentialFormat(input);
  if (format === 'seed') return deriveSeedCandidates(input);
  const secretKey = format === 'wif' ? decodeWIF(input.trim()) : hexToBytes(input.trim());
  return candidatesFromSecretKey(secretKey, format === 'wif' ? 'WIF key' : 'Hex key');
}

export function selectMatchingCandidate(candidates: ClaimCandidate[], snapshot: SnapshotAddressLookup): ClaimCandidate {
  const matches = candidates.filter((candidate) => candidate.btcAddress === snapshot.btcAddress);
  const exact = matches.find((candidate) => candidate.type === snapshot.type);
  if (exact) return exact;
  if (matches.length > 0) return matches[0];
  throw new Error('The provided BTC credential does not derive the snapshot address being claimed.');
}

export function createBrowserClaimTransaction(
  candidate: ClaimCandidate,
  snapshot: SnapshotAddressLookup,
  qbtcWallet: BrowserWallet,
  snapshotBlockHash: string,
  genesisHash: string,
): unknown {
  if (!/^[0-9a-f]{64}$/i.test(snapshotBlockHash) || !/^[0-9a-f]{64}$/i.test(genesisHash)) {
    throw new Error('Claim metadata is missing the snapshot block hash or genesis hash.');
  }

  const claimMsgHash = serializeClaimMessage(
    snapshot.btcAddress,
    qbtcWallet.address,
    snapshotBlockHash.toLowerCase(),
    genesisHash.toLowerCase(),
  );

  let claimData: BrowserClaimData;
  if (candidate.type === 'p2tr') {
    claimData = {
      btcAddress: snapshot.btcAddress,
      ecdsaPublicKey: new Uint8Array(0),
      ecdsaSignature: new Uint8Array(0),
      qbtcAddress: qbtcWallet.address,
      schnorrPublicKey: candidate.publicKey,
      schnorrSignature: schnorr.sign(claimMsgHash, candidate.secretKey),
    };
  } else {
    claimData = {
      btcAddress: snapshot.btcAddress,
      ecdsaPublicKey: candidate.publicKey,
      ecdsaSignature: secp256k1.sign(claimMsgHash, candidate.secretKey),
      qbtcAddress: qbtcWallet.address,
    };
  }

  const timestamp = Date.now();
  const outputs = [{ address: qbtcWallet.address, amount: snapshot.amount }];
  const inputOutpoints = [{ txId: CLAIM_TXID, outputIndex: 0 }];
  const tx: BrowserTransaction = {
    id: computeTxId(inputOutpoints, outputs, timestamp),
    inputs: [{
      txId: CLAIM_TXID,
      outputIndex: 0,
      publicKey: new Uint8Array(0),
      signature: new Uint8Array(0),
    }],
    outputs,
    timestamp,
    claimData,
  };
  return sanitizeForJson(tx);
}

function deriveSeedCandidates(input: string): ClaimCandidate[] {
  const mnemonic = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('Invalid BIP39 seed phrase. Check spelling and word count.');
  }

  const seed = mnemonicToSeedSync(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const paths = [
    { path: "m/44'/0'/0'/0/0", label: 'BIP44 P2PKH index 0', type: 'p2pkh' as const },
    { path: "m/44'/0'/0'/0/1", label: 'BIP44 P2PKH index 1', type: 'p2pkh' as const },
    { path: "m/44'/0'/0'/0/2", label: 'BIP44 P2PKH index 2', type: 'p2pkh' as const },
    { path: "m/84'/0'/0'/0/0", label: 'BIP84 P2WPKH index 0', type: 'p2pkh' as const },
    { path: "m/84'/0'/0'/0/1", label: 'BIP84 P2WPKH index 1', type: 'p2pkh' as const },
    { path: "m/84'/0'/0'/0/2", label: 'BIP84 P2WPKH index 2', type: 'p2pkh' as const },
    { path: "m/49'/0'/0'/0/0", label: 'BIP49 P2SH-P2WPKH index 0', type: 'p2sh' as const },
    { path: "m/49'/0'/0'/0/1", label: 'BIP49 P2SH-P2WPKH index 1', type: 'p2sh' as const },
    { path: "m/49'/0'/0'/0/2", label: 'BIP49 P2SH-P2WPKH index 2', type: 'p2sh' as const },
    { path: "m/86'/0'/0'/0/0", label: 'BIP86 P2TR index 0', type: 'p2tr' as const },
    { path: "m/86'/0'/0'/0/1", label: 'BIP86 P2TR index 1', type: 'p2tr' as const },
    { path: "m/86'/0'/0'/0/2", label: 'BIP86 P2TR index 2', type: 'p2tr' as const },
  ];

  const candidates: ClaimCandidate[] = [];
  for (const pathInfo of paths) {
    const child = master.derive(pathInfo.path);
    if (!child.privateKey) continue;
    const [candidate] = pathInfo.type === 'p2tr'
      ? taprootCandidates(child.privateKey, pathInfo.label)
      : pathInfo.type === 'p2sh'
        ? p2shCandidates(child.privateKey, pathInfo.label)
        : keyhashCandidates(child.privateKey, pathInfo.label);
    candidates.push({ ...candidate, path: pathInfo.path });
  }
  return candidates;
}

function candidatesFromSecretKey(secretKey: Uint8Array, labelPrefix: string): ClaimCandidate[] {
  return [
    ...keyhashCandidates(secretKey, `${labelPrefix} P2PKH/P2WPKH`),
    ...p2shCandidates(secretKey, `${labelPrefix} P2SH-P2WPKH`),
    ...taprootCandidates(secretKey, `${labelPrefix} P2TR`),
  ];
}

function keyhashCandidates(secretKey: Uint8Array, label: string): ClaimCandidate[] {
  const publicKey = secp256k1.getPublicKey(secretKey, true);
  return [{
    label,
    btcAddress: bytesToHex(hash160(publicKey)),
    type: 'p2pkh',
    secretKey,
    publicKey,
  }];
}

function p2shCandidates(secretKey: Uint8Array, label: string): ClaimCandidate[] {
  const publicKey = secp256k1.getPublicKey(secretKey, true);
  const redeemScript = concatBytes(new Uint8Array([0x00, 0x14]), hash160(publicKey));
  return [{
    label,
    btcAddress: bytesToHex(hash160(redeemScript)),
    type: 'p2sh',
    secretKey,
    publicKey,
  }];
}

function taprootCandidates(secretKey: Uint8Array, label: string): ClaimCandidate[] {
  const publicKey = schnorr.getPublicKey(secretKey);
  return [{
    label,
    btcAddress: bytesToHex(computeTaprootOutputKey(publicKey)),
    type: 'p2tr',
    secretKey,
    publicKey,
  }];
}

function decodeWIF(wif: string): Uint8Array {
  let value = 0n;
  for (const ch of wif) {
    const index = BASE58_ALPHABET.indexOf(ch);
    if (index === -1) throw new Error(`Invalid WIF character: ${ch}`);
    value = value * 58n + BigInt(index);
  }

  let hex = value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let decoded = hexToBytes(hex);
  let leadingZeroes = 0;
  for (const ch of wif) {
    if (ch !== '1') break;
    leadingZeroes++;
  }
  if (leadingZeroes > 0) {
    decoded = concatBytes(new Uint8Array(leadingZeroes), decoded);
  }

  const payload = decoded.slice(0, decoded.length - 4);
  const checksum = decoded.slice(decoded.length - 4);
  const hash = sha256(sha256(payload));
  for (let i = 0; i < 4; i++) {
    if (hash[i] !== checksum[i]) throw new Error('WIF checksum mismatch.');
  }
  if (payload[0] !== 0x80) throw new Error(`Unexpected WIF version byte: 0x${payload[0].toString(16)}.`);
  if (payload.length === 34 && payload[33] === 0x01) return payload.slice(1, 33);
  if (payload.length === 33) {
    throw new Error('Uncompressed WIF keys are not supported in the browser claim builder. Use a compressed WIF key starting with K or L, a 64-character hex private key, or the CLI claim tool.');
  }
  throw new Error(`Unexpected WIF payload length: ${payload.length}.`);
}

function serializeClaimMessage(
  btcAddress: string,
  qbtcAddress: string,
  snapshotBlockHash: string,
  genesisHash: string,
): Uint8Array {
  return sha256(sha256(new TextEncoder().encode(
    `QBTC_CLAIM:${btcAddress}:${qbtcAddress}:${snapshotBlockHash}:${genesisHash}`,
  )));
}

function computeTaprootOutputKey(internalPubkey: Uint8Array): Uint8Array {
  const tweak = schnorr.utils.taggedHash('TapTweak', internalPubkey);
  const xBig = BigInt('0x' + bytesToHex(internalPubkey));
  const P = schnorr.utils.lift_x(xBig);
  const tBig = BigInt('0x' + bytesToHex(tweak));
  const Q = P.add(schnorr.Point.BASE.multiply(tBig));
  return schnorr.utils.pointToBytes(Q);
}

function computeTxId(
  inputs: Array<{ txId: string; outputIndex: number }>,
  outputs: Array<{ address: string; amount: number }>,
  timestamp: number,
): string {
  return bytesToHex(sha256(sha256(serializeForSigning(inputs, outputs, timestamp))));
}

function serializeForSigning(
  inputs: Array<{ txId: string; outputIndex: number }>,
  outputs: Array<{ address: string; amount: number }>,
  timestamp: number,
): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [uint32LE(inputs.length)];
  for (const input of inputs) {
    parts.push(encoder.encode(input.txId));
    parts.push(uint32LE(input.outputIndex));
  }
  parts.push(uint32LE(outputs.length));
  for (const output of outputs) {
    parts.push(encoder.encode(output.address));
    parts.push(uint64LE(output.amount));
  }
  parts.push(uint64LE(timestamp));
  return concatBytes(...parts);
}

function uint32LE(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n >>> 0, true);
  return buf;
}

function uint64LE(n: number): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setUint32(0, n >>> 0, true);
  view.setUint32(4, Math.floor(n / 0x100000000) >>> 0, true);
  return buf;
}

function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

function sanitizeForJson(value: unknown): unknown {
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (Array.isArray(value)) return value.map(sanitizeForJson);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = sanitizeForJson(inner);
    }
    return out;
  }
  return value;
}
