/**
 * Cross-platform X25519 key confirmation for mobile pairing.
 * @module @deepseek-ai/dsh-pairing-protocol/crypto
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { PairingProtocolError } from './error.ts'
import {
  decodePairingEncryptedProof,
  decodePairingEphemeralPublicKey,
  encodePairingEncryptedProof,
  encodePairingEphemeralPublicKey,
  validateMobileCapabilities,
} from './index.ts'
import {
  PAIRING_PROOF_NONCE_BYTES,
  PAIRING_X25519_KEY_BYTES,
} from './types.ts'
import type {
  DesktopPairingAccept,
  MobilePairingCapability,
  MobilePairingInit,
  PairingBootstrap,
  PairingDeviceId,
  PairingEncryptedProof,
  PairingEphemeralPublicKey,
} from './types.ts'

const MOBILE_PROOF_LABEL = 'dsh-pairing/v2/mobile-init'
const DESKTOP_PROOF_LABEL = 'dsh-pairing/v2/desktop-accept'
const APPLICATION_CONFIRMATION_REQUIRED = 'PAIRING_KEY_CONFIRMATION_REQUIRED'

/** Platform-provided cryptographically secure random-byte source. */
export interface PairingRandomSource {
  /**
   * Return fresh random bytes.
   *
   * @param length - Exact number of bytes requested.
   * @returns Fresh cryptographically secure bytes.
   */
  randomBytes(length: number): Uint8Array
}

/** One in-memory X25519 key pair used by one pairing attempt. */
export interface PairingEphemeralKeyPair {
  readonly publicKey: PairingEphemeralPublicKey
  readonly secretKey: Uint8Array
}

/** Inputs used by a phone to create its encrypted initialization proof. */
export interface CreateMobilePairingProofInput {
  readonly bootstrap: PairingBootstrap
  readonly mobileDeviceId: PairingDeviceId
  readonly capabilities: readonly MobilePairingCapability[]
  readonly mobileKeyPair: PairingEphemeralKeyPair
  readonly random: PairingRandomSource
}

/** Mobile key material and proof that belong in a mobile-init relay control. */
export interface MobilePairingProof {
  readonly mobileEphemeralPublicKey: PairingEphemeralPublicKey
  readonly encryptedProof: PairingEncryptedProof
}

/** Inputs used by the desktop to verify a mobile-init key confirmation. */
export interface VerifyMobilePairingProofInput {
  readonly bootstrap: PairingBootstrap
  readonly init: MobilePairingInit
  readonly desktopSecretKey: Uint8Array
}

/** Inputs used by the desktop to create its encrypted acceptance proof. */
export interface CreateDesktopPairingProofInput {
  readonly bootstrap: PairingBootstrap
  readonly init: MobilePairingInit
  readonly desktopSecretKey: Uint8Array
  readonly random: PairingRandomSource
}

/** Inputs used by the phone to verify a desktop-accept key confirmation. */
export interface VerifyDesktopPairingProofInput {
  readonly bootstrap: PairingBootstrap
  readonly init: MobilePairingInit
  readonly accept: DesktopPairingAccept
  readonly mobileSecretKey: Uint8Array
}

/** A one-way application-frame gate opened only after local proof verification. */
export interface PairingKeyConfirmation {
  /** Throw when local key confirmation has not succeeded or has been revoked. */
  requireConfirmed(): void
  /** Revoke this authorization after close, expiry, or desktop revocation. */
  revoke(): void
}

function failure(code: 'PAIRING_KEY_INVALID' | 'PAIRING_PROOF_INVALID'): never {
  throw new PairingProtocolError(code)
}

function exactBytes(value: Uint8Array, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    return failure('PAIRING_KEY_INVALID')
  }
  return new Uint8Array(value)
}

function randomBytes(random: PairingRandomSource, length: number): Uint8Array {
  try {
    return exactBytes(random.randomBytes(length), length)
  } catch {
    return failure('PAIRING_KEY_INVALID')
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength
  const width = Math.max(left.byteLength, right.byteLength)
  for (let index = 0; index < width; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

function capabilitySetIsAdmitted(
  requested: readonly MobilePairingCapability[],
  approved: readonly MobilePairingCapability[],
): boolean {
  return requested.every(capability => approved.includes(capability))
}

function transcript(
  bootstrap: PairingBootstrap,
  mobileDeviceId: PairingDeviceId,
  mobileEphemeralPublicKey: PairingEphemeralPublicKey,
  capabilities: readonly MobilePairingCapability[],
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([
    'dsh-pairing',
    bootstrap.version,
    bootstrap.pairingId,
    bootstrap.desktopDeviceId,
    mobileDeviceId,
    bootstrap.desktopEphemeralPublicKey,
    mobileEphemeralPublicKey,
    ...capabilities,
  ]))
}

function derivedProofKey(
  secretKey: Uint8Array,
  peerPublicKey: PairingEphemeralPublicKey,
  transcriptBytes: Uint8Array,
  label: string,
): Uint8Array {
  let sharedSecret: Uint8Array | undefined
  try {
    sharedSecret = x25519.getSharedSecret(
      exactBytes(secretKey, PAIRING_X25519_KEY_BYTES),
      decodePairingEphemeralPublicKey(peerPublicKey),
    )
    if (sharedSecret.every(byte => byte === 0)) failure('PAIRING_KEY_INVALID')
    return hkdf(
      sha256,
      sharedSecret,
      transcriptBytes,
      new TextEncoder().encode(label),
      32,
    )
  } catch (error) {
    if (error instanceof PairingProtocolError) throw error
    return failure('PAIRING_KEY_INVALID')
  } finally {
    sharedSecret?.fill(0)
  }
}

function sealProof(
  secretKey: Uint8Array,
  peerPublicKey: PairingEphemeralPublicKey,
  transcriptBytes: Uint8Array,
  label: string,
  random: PairingRandomSource,
): PairingEncryptedProof {
  const key = derivedProofKey(secretKey, peerPublicKey, transcriptBytes, label)
  const nonce = randomBytes(random, PAIRING_PROOF_NONCE_BYTES)
  try {
    const ciphertext = xchacha20poly1305(key, nonce, transcriptBytes)
      .encrypt(new TextEncoder().encode(label))
    const result = new Uint8Array(nonce.byteLength + ciphertext.byteLength)
    result.set(nonce)
    result.set(ciphertext, nonce.byteLength)
    return encodePairingEncryptedProof(result)
  } catch {
    return failure('PAIRING_PROOF_INVALID')
  } finally {
    key.fill(0)
    nonce.fill(0)
  }
}

function openProof(
  secretKey: Uint8Array,
  peerPublicKey: PairingEphemeralPublicKey,
  transcriptBytes: Uint8Array,
  label: string,
  proof: PairingEncryptedProof,
): void {
  const proofBytes = decodePairingEncryptedProof(proof)
  const nonce = proofBytes.slice(0, PAIRING_PROOF_NONCE_BYTES)
  const ciphertext = proofBytes.slice(PAIRING_PROOF_NONCE_BYTES)
  const key = derivedProofKey(secretKey, peerPublicKey, transcriptBytes, label)
  try {
    const plaintext = xchacha20poly1305(key, nonce, transcriptBytes).decrypt(ciphertext)
    if (!constantTimeEqual(plaintext, new TextEncoder().encode(label))) {
      failure('PAIRING_PROOF_INVALID')
    }
  } catch (error) {
    if (error instanceof PairingProtocolError) throw error
    return failure('PAIRING_PROOF_INVALID')
  } finally {
    key.fill(0)
    nonce.fill(0)
    ciphertext.fill(0)
    proofBytes.fill(0)
  }
}

function validatedCapabilities(
  requested: readonly MobilePairingCapability[],
  bootstrap: PairingBootstrap,
): readonly MobilePairingCapability[] {
  const validated = validateMobileCapabilities(requested)
  return capabilitySetIsAdmitted(validated, bootstrap.capabilities)
    ? validated
    : failure('PAIRING_PROOF_INVALID')
}

function initTranscript(
  bootstrap: PairingBootstrap,
  init: Pick<MobilePairingInit, 'mobileDeviceId' | 'mobileEphemeralPublicKey' | 'capabilities'>,
): Uint8Array {
  const capabilities = validatedCapabilities(init.capabilities, bootstrap)
  return transcript(
    bootstrap,
    init.mobileDeviceId,
    init.mobileEphemeralPublicKey,
    capabilities,
  )
}

/**
 * Generate one X25519 pair from platform-injected randomness. Keep the secret
 * only in active memory and pass it to {@link destroyPairingEphemeralKeyPair}
 * on close, expiry, or revocation.
 *
 * @param random - Platform cryptographically secure random-byte source.
 * @returns A fresh in-memory X25519 pair.
 */
export function createPairingEphemeralKeyPair(
  random: PairingRandomSource,
): PairingEphemeralKeyPair {
  const secretKey = randomBytes(random, PAIRING_X25519_KEY_BYTES)
  try {
    return {
      publicKey: encodePairingEphemeralPublicKey(x25519.getPublicKey(secretKey)),
      secretKey,
    }
  } catch {
    secretKey.fill(0)
    return failure('PAIRING_KEY_INVALID')
  }
}

/**
 * Erase an ephemeral secret key after its pairing closes or is revoked.
 *
 * @param keyPair - In-memory ephemeral key pair whose secret must be cleared.
 */
export function destroyPairingEphemeralKeyPair(keyPair: PairingEphemeralKeyPair): void {
  keyPair.secretKey.fill(0)
}

/**
 * Create the phone proof carried by one mobile-init relay control.
 *
 * @param input - Bootstrap, requested capabilities, mobile key pair, and random source.
 * @returns Mobile key material and encrypted proof for the relay control.
 */
export function createMobilePairingProof(
  input: CreateMobilePairingProofInput,
): MobilePairingProof {
  const capabilities = validatedCapabilities(input.capabilities, input.bootstrap)
  const transcriptBytes = transcript(
    input.bootstrap,
    input.mobileDeviceId,
    input.mobileKeyPair.publicKey,
    capabilities,
  )
  return {
    mobileEphemeralPublicKey: input.mobileKeyPair.publicKey,
    encryptedProof: sealProof(
      input.mobileKeyPair.secretKey,
      input.bootstrap.desktopEphemeralPublicKey,
      transcriptBytes,
      MOBILE_PROOF_LABEL,
      input.random,
    ),
  }
}

/**
 * Verify the phone proof before the desktop approves capabilities or sends an
 * acceptance. This is the desktop's local key confirmation.
 *
 * @param input - Bootstrap, parsed mobile-init, and active desktop secret key.
 */
export function verifyMobilePairingProof(input: VerifyMobilePairingProofInput): void {
  openProof(
    input.desktopSecretKey,
    input.init.mobileEphemeralPublicKey,
    initTranscript(input.bootstrap, input.init),
    MOBILE_PROOF_LABEL,
    input.init.encryptedProof,
  )
}

/**
 * Create the desktop proof carried by one desktop-accept relay control after
 * local mobile-init verification and explicit user approval.
 *
 * @param input - Bootstrap, parsed mobile-init, active desktop key, and random source.
 * @returns Encrypted desktop acceptance proof for the relay control.
 */
export function createDesktopPairingProof(
  input: CreateDesktopPairingProofInput,
): PairingEncryptedProof {
  return sealProof(
    input.desktopSecretKey,
    input.init.mobileEphemeralPublicKey,
    initTranscript(input.bootstrap, input.init),
    DESKTOP_PROOF_LABEL,
    input.random,
  )
}

/**
 * Verify the desktop proof before the phone enables any application frame.
 *
 * @param input - Bootstrap, parsed init and acceptance controls, and mobile key.
 */
export function verifyDesktopPairingProof(input: VerifyDesktopPairingProofInput): void {
  if (
    input.accept.pairingId !== input.bootstrap.pairingId
    || input.accept.mobileDeviceId !== input.init.mobileDeviceId
  ) {
    failure('PAIRING_PROOF_INVALID')
  }
  openProof(
    input.mobileSecretKey,
    input.bootstrap.desktopEphemeralPublicKey,
    initTranscript(input.bootstrap, input.init),
    DESKTOP_PROOF_LABEL,
    input.accept.encryptedProof,
  )
}

/**
 * Return an application-frame gate after local desktop proof verification.
 * Revocation permanently closes it, so callers cannot reuse a closed pairing.
 *
 * @returns Mutable local confirmation gate.
 */
export function confirmPairingKey(): PairingKeyConfirmation {
  let confirmed = true
  return {
    requireConfirmed(): void {
      if (!confirmed) throw new PairingProtocolError(APPLICATION_CONFIRMATION_REQUIRED)
    },
    revoke(): void {
      confirmed = false
    },
  }
}
