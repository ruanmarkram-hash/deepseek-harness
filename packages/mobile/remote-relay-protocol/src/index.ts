/**
 * Mutual-authenticated X25519 relay transport for trusted DSH remote clients.
 * The relay sees only public route coordinates and opaque ciphertext frames.
 * @module @deepseek-ai/dsh-remote-relay-protocol
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { parseRemoteWireJson, serializeRemoteWireEnvelope } from '@deepseek-ai/dsh-remote-wire'
import type { RemoteWireEnvelope } from '@deepseek-ai/dsh-remote-wire'
import { hasExactKeys as exactKeys, isRecord } from '@deepseek-ai/dsh-util-values'
import { RemoteRelayProtocolError } from './error.ts'
import {
  MAX_REMOTE_RELAY_CIPHERTEXT_BYTES,
  MAX_REMOTE_RELAY_SEQUENCE,
  REMOTE_RELAY_NONCE_BYTES,
  REMOTE_RELAY_PROTOCOL_VERSION,
  REMOTE_RELAY_X25519_BYTES,
} from './types.ts'
import type {
  RemoteRelayCiphertext,
  RemoteRelayAck,
  RemoteRelayCommit,
  RemoteRelayConfirm,
  RemoteRelayReceipt,
  RemoteRelayEpochFinalizer,
  RemoteRelayFinish,
  RemoteRelayAgreementProvider,
  RemoteRelayHello,
  RemoteRelayIdentity,
  RemoteRelayMessage,
  RemoteRelayPeer,
  RemoteRelayPeerIdentity,
  RemoteRelayProtocolErrorCode,
  RemoteRelayRandomSource,
  RemoteRelayReady,
  RemoteRelayRoute,
  RemoteRelaySendFence,
  RemoteRelaySendResult,
  RemoteRelaySocket,
  RemoteRelayWelcome,
  TrustedRemoteRelayConnection,
} from './types.ts'

export { RemoteRelayProtocolError, isRemoteRelayProtocolError } from './error.ts'
export {
  MAX_REMOTE_RELAY_CIPHERTEXT_BYTES,
  MAX_REMOTE_RELAY_SEQUENCE,
  REMOTE_RELAY_NONCE_BYTES,
  REMOTE_RELAY_PROTOCOL_VERSION,
  REMOTE_RELAY_X25519_BYTES,
} from './types.ts'
export type {
  RemoteRelayCiphertext,
  RemoteRelayAck,
  RemoteRelayCommit,
  RemoteRelayConfirm,
  RemoteRelayReceipt,
  RemoteRelayEpochFinalizer,
  RemoteRelayFinish,
  RemoteRelayAgreementProvider,
  RemoteRelayHello,
  RemoteRelayIdentity,
  RemoteRelayMessage,
  RemoteRelayPeer,
  RemoteRelayPeerIdentity,
  RemoteRelayProtocolErrorCode,
  RemoteRelayRandomSource,
  RemoteRelayReady,
  RemoteRelayRoute,
  RemoteRelaySendFence,
  RemoteRelaySendResult,
  RemoteRelaySocket,
  RemoteRelayWelcome,
  TrustedRemoteRelayConnection,
} from './types.ts'

const TEXT = new TextEncoder()
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true })
const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const READY_TEXT = 'dsh-remote/v3/ready'
const FINISH_TEXT = 'dsh-remote/v3/finish'
const ACK_TEXT = 'dsh-remote/v3/ack'
const COMMIT_TEXT = 'dsh-remote/v3/commit'
const CONFIRM_TEXT = 'dsh-remote/v3/confirm'
const RECEIPT_TEXT = 'dsh-remote/v3/receipt'
const MAX_MESSAGE_BYTES = Math.ceil(MAX_REMOTE_RELAY_CIPHERTEXT_BYTES * 4 / 3) + 4_096

interface EphemeralKeyPair {
  readonly publicKey: string
  readonly secretKey: Uint8Array
}

interface DirectionKeys {
  readonly clientToHost: Uint8Array
  readonly hostToClient: Uint8Array
  readonly context: Uint8Array
}

interface ConnectionInput {
  readonly socket: RemoteRelaySocket
  /** Cancels any pending handshake flight and closes the socket before a trusted connection is exposed. */
  readonly signal?: AbortSignal
  readonly identity: RemoteRelayIdentity
  readonly peer: RemoteRelayPeerIdentity
  readonly route: RemoteRelayRoute
  readonly random: RemoteRelayRandomSource
}

/** Address an outbound handshake message without changing the sender/recipient ordering. */
function outboundAddress(
  coordinates: RemoteRelayRoute, local: RemoteRelayIdentity, peer: RemoteRelayPeerIdentity,
): Omit<RemoteRelayHello, 'type' | 'ephemeralPublicKey' | 'nonce'> {
  return {
    version: REMOTE_RELAY_PROTOCOL_VERSION, routeId: coordinates.routeId,
    generation: coordinates.generation, connectionEpoch: coordinates.connectionEpoch,
    senderDeviceId: local.deviceId, senderEnrollmentId: local.enrollmentId,
    recipientDeviceId: peer.deviceId, recipientEnrollmentId: peer.enrollmentId,
  }
}

function destroyDirectionKeys(value: DirectionKeys | undefined): void {
  value?.clientToHost.fill(0)
  value?.hostToClient.fill(0)
  value?.context.fill(0)
}

function failure(code: RemoteRelayProtocolErrorCode): never {
  throw new RemoteRelayProtocolError(code)
}

/** Close an already-open transport when validation fails before the handshake try/finally owns it. */
function preflight<T>(socket: RemoteRelaySocket, operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    try { socket.close(4403, 'relay-handshake-failed') } catch { /* best-effort cleanup */ }
    throw error
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function base64Bytes(value: unknown, code: RemoteRelayProtocolErrorCode, maxBytes: number): Uint8Array {
  if (typeof value !== 'string' || !BASE64URL.test(value) || value.length % 4 === 1) return failure(code)
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4))
    const canonical = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    if (canonical !== value || binary.length > maxBytes) return failure(code)
    return Uint8Array.from(binary, byte => byte.charCodeAt(0))
  } catch {
    return failure(code)
  }
}

function text(value: unknown, expression: RegExp, code: RemoteRelayProtocolErrorCode): string {
  return typeof value === 'string' && expression.test(value) ? value : failure(code)
}

function number(value: unknown, code: 'REMOTE_RELAY_ROUTE_INVALID' | 'REMOTE_RELAY_EPOCH_INVALID' | 'REMOTE_RELAY_SEQUENCE_INVALID'): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_REMOTE_RELAY_SEQUENCE
    ? value
    : failure(code)
}

function route(value: RemoteRelayRoute): RemoteRelayRoute {
  return {
    routeId: text(value.routeId, ROUTE_ID, 'REMOTE_RELAY_ROUTE_INVALID'),
    generation: number(value.generation, 'REMOTE_RELAY_ROUTE_INVALID'),
    connectionEpoch: number(value.connectionEpoch, 'REMOTE_RELAY_EPOCH_INVALID'),
  }
}

function identity(value: RemoteRelayPeerIdentity): RemoteRelayPeerIdentity {
  const agreement = base64Bytes(value.agreementPublicKey, 'REMOTE_RELAY_KEY_INVALID', REMOTE_RELAY_X25519_BYTES)
  try {
    if (agreement.byteLength !== REMOTE_RELAY_X25519_BYTES) return failure('REMOTE_RELAY_KEY_INVALID')
  } finally {
    agreement.fill(0)
  }
  return {
    deviceId: text(value.deviceId, DEVICE_ID, 'REMOTE_RELAY_ID_INVALID'),
    enrollmentId: text(value.enrollmentId, DEVICE_ID, 'REMOTE_RELAY_ID_INVALID'),
    agreementPublicKey: value.agreementPublicKey,
  }
}

function localIdentity(value: RemoteRelayIdentity): RemoteRelayIdentity {
  const deviceId = text(value.deviceId, DEVICE_ID, 'REMOTE_RELAY_ID_INVALID')
  const enrollmentId = text(value.enrollmentId, DEVICE_ID, 'REMOTE_RELAY_ID_INVALID')
  const agreement = value.agreement
  if (typeof agreement.deriveSharedSecret !== 'function') {
    return failure('REMOTE_RELAY_KEY_INVALID')
  }
  const agreementPublicKey = base64Bytes(agreement.publicKey, 'REMOTE_RELAY_KEY_INVALID', REMOTE_RELAY_X25519_BYTES)
  try {
    if (agreementPublicKey.byteLength !== REMOTE_RELAY_X25519_BYTES) return failure('REMOTE_RELAY_KEY_INVALID')
    return {
      deviceId,
      enrollmentId,
      agreement: { publicKey: agreement.publicKey, deriveSharedSecret: agreement.deriveSharedSecret.bind(agreement) },
    }
  } finally {
    agreementPublicKey.fill(0)
  }
}

function secret(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== REMOTE_RELAY_X25519_BYTES) return failure('REMOTE_RELAY_KEY_INVALID')
  return new Uint8Array(value)
}

function randomBytes(random: RemoteRelayRandomSource, length: number): Uint8Array {
  let bytes: Uint8Array | undefined
  try {
    const candidate = random.randomBytes(length)
    if (!(candidate instanceof Uint8Array)) return failure('REMOTE_RELAY_KEY_INVALID')
    bytes = candidate
    if (bytes.byteLength !== length) return failure('REMOTE_RELAY_KEY_INVALID')
    return new Uint8Array(bytes)
  } catch (error) {
    if (error instanceof RemoteRelayProtocolError) throw error
    return failure('REMOTE_RELAY_KEY_INVALID')
  } finally {
    bytes?.fill(0)
  }
}

function ephemeral(random: RemoteRelayRandomSource): EphemeralKeyPair {
  const secretKey = randomBytes(random, REMOTE_RELAY_X25519_BYTES)
  try {
    return { publicKey: base64Url(x25519.getPublicKey(secretKey)), secretKey }
  } catch {
    secretKey.fill(0)
    return failure('REMOTE_RELAY_KEY_INVALID')
  }
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength
  for (let index = 0; index < Math.max(left.byteLength, right.byteLength); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

function handshakeContext(hello: RemoteRelayHello, welcome: RemoteRelayWelcome): Uint8Array {
  return TEXT.encode(JSON.stringify([
    'dsh-remote', REMOTE_RELAY_PROTOCOL_VERSION,
    hello.routeId, hello.generation, hello.connectionEpoch,
    hello.senderDeviceId, hello.senderEnrollmentId, hello.recipientDeviceId,
    hello.recipientEnrollmentId, hello.ephemeralPublicKey, hello.nonce,
    welcome.senderDeviceId, welcome.senderEnrollmentId, welcome.recipientDeviceId,
    welcome.recipientEnrollmentId, welcome.ephemeralPublicKey, welcome.nonce,
  ]))
}

function shared(secretKey: Uint8Array, publicKey: string): Uint8Array {
  const peer = base64Bytes(publicKey, 'REMOTE_RELAY_KEY_INVALID', REMOTE_RELAY_X25519_BYTES)
  try {
    if (peer.byteLength !== REMOTE_RELAY_X25519_BYTES) return failure('REMOTE_RELAY_KEY_INVALID')
    const result = x25519.getSharedSecret(secretKey, peer)
    return result.every(byte => byte === 0) ? failure('REMOTE_RELAY_KEY_INVALID') : result
  } catch (error) {
    if (error instanceof RemoteRelayProtocolError) throw error
    return failure('REMOTE_RELAY_KEY_INVALID')
  } finally {
    peer.fill(0)
  }
}

function providerShared(provider: RemoteRelayAgreementProvider, publicKey: string): Uint8Array {
  let providerResult: Uint8Array | undefined
  let sharedSecret: Uint8Array | undefined
  try {
    providerResult = provider.deriveSharedSecret(publicKey)
    sharedSecret = secret(providerResult)
    return sharedSecret.every(byte => byte === 0) ? failure('REMOTE_RELAY_KEY_INVALID') : sharedSecret
  } catch (error) {
    if (error instanceof RemoteRelayProtocolError) throw error
    return failure('REMOTE_RELAY_KEY_INVALID')
  } finally {
    providerResult?.fill(0)
  }
}

/** Derive directional keys with static-static, static-ephemeral, and ephemeral-ephemeral X25519 contributions. */
function keys(
  local: RemoteRelayIdentity,
  peer: RemoteRelayPeerIdentity,
  localEphemeral: EphemeralKeyPair,
  peerEphemeralPublicKey: string,
  context: Uint8Array,
  initiator: boolean,
): DirectionKeys {
  let staticStatic: Uint8Array | undefined
  let staticEphemeral: Uint8Array | undefined
  let ephemeralStatic: Uint8Array | undefined
  let ephemeralEphemeral: Uint8Array | undefined
  let material: Uint8Array | undefined
  try {
    staticStatic = providerShared(local.agreement, peer.agreementPublicKey)
    staticEphemeral = providerShared(local.agreement, peerEphemeralPublicKey)
    ephemeralStatic = shared(localEphemeral.secretKey, peer.agreementPublicKey)
    ephemeralEphemeral = shared(localEphemeral.secretKey, peerEphemeralPublicKey)
    material = new Uint8Array(REMOTE_RELAY_X25519_BYTES * 4)
    material.set(staticStatic, 0)
    material.set(initiator ? staticEphemeral : ephemeralStatic, REMOTE_RELAY_X25519_BYTES)
    material.set(initiator ? ephemeralStatic : staticEphemeral, REMOTE_RELAY_X25519_BYTES * 2)
    material.set(ephemeralEphemeral, REMOTE_RELAY_X25519_BYTES * 3)
    const derived = hkdf(sha256, material, context, TEXT.encode('dsh-remote/v3/3dh'), 64)
    return {
      clientToHost: derived.slice(0, 32),
      hostToClient: derived.slice(32, 64),
      context: new Uint8Array(context),
    }
  } catch (error) {
    if (error instanceof RemoteRelayProtocolError) throw error
    return failure('REMOTE_RELAY_KEY_INVALID')
  } finally {
    staticStatic?.fill(0)
    staticEphemeral?.fill(0)
    ephemeralStatic?.fill(0)
    ephemeralEphemeral?.fill(0)
    material?.fill(0)
  }
}

function fields(message: RemoteRelayMessage): readonly unknown[] {
  return [
    message.routeId, message.generation, message.connectionEpoch,
    message.senderDeviceId, message.senderEnrollmentId,
    message.recipientDeviceId, message.recipientEnrollmentId,
  ]
}

function associatedData(
  type: 'ready' | 'finish' | 'ack' | 'commit' | 'confirm' | 'receipt' | 'ciphertext',
  message:
    | RemoteRelayReady
    | RemoteRelayFinish
    | RemoteRelayAck
    | RemoteRelayCommit
    | RemoteRelayConfirm
    | RemoteRelayReceipt
    | RemoteRelayCiphertext,
): Uint8Array {
  const sequence = type === 'ciphertext' ? [(message as RemoteRelayCiphertext).sequence] : []
  return TEXT.encode(JSON.stringify([type, ...fields(message), ...sequence]))
}

function encodeCipher(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): string {
  try {
    const cipher = chacha20poly1305(key, nonce, aad).encrypt(plaintext)
    if (cipher.byteLength > MAX_REMOTE_RELAY_CIPHERTEXT_BYTES) return failure('REMOTE_RELAY_CIPHERTEXT_INVALID')
    return base64Url(cipher)
  } catch (error) {
    if (error instanceof RemoteRelayProtocolError) throw error
    return failure('REMOTE_RELAY_CIPHERTEXT_INVALID')
  }
}

function decryptCipher(key: Uint8Array, nonce: string, aad: Uint8Array, ciphertext: string): Uint8Array {
  const nonceBytes = base64Bytes(nonce, 'REMOTE_RELAY_CIPHERTEXT_INVALID', REMOTE_RELAY_NONCE_BYTES)
  const cipherBytes = base64Bytes(ciphertext, 'REMOTE_RELAY_CIPHERTEXT_INVALID', MAX_REMOTE_RELAY_CIPHERTEXT_BYTES)
  try {
    return chacha20poly1305(key, nonceBytes, aad).decrypt(cipherBytes)
  } catch {
    return failure('REMOTE_RELAY_DECRYPT_FAILED')
  } finally {
    nonceBytes.fill(0)
    cipherBytes.fill(0)
  }
}

function exactRoute(message: RemoteRelayMessage, expected: RemoteRelayRoute, sender: RemoteRelayPeerIdentity, recipient: Pick<RemoteRelayIdentity, 'deviceId' | 'enrollmentId'>): void {
  if (
    message.routeId !== expected.routeId
    || message.generation !== expected.generation
    || message.connectionEpoch !== expected.connectionEpoch
    || message.senderDeviceId !== sender.deviceId
    || message.senderEnrollmentId !== sender.enrollmentId
    || message.recipientDeviceId !== recipient.deviceId
    || message.recipientEnrollmentId !== recipient.enrollmentId
  ) failure('REMOTE_RELAY_PEER_INVALID')
}

function parseMessageObject(value: Record<string, unknown>): RemoteRelayMessage {
  if (value.version !== REMOTE_RELAY_PROTOCOL_VERSION || typeof value.type !== 'string') return failure('REMOTE_RELAY_UNSUPPORTED_VERSION')
  const common = {
    version: REMOTE_RELAY_PROTOCOL_VERSION,
    routeId: text(value.routeId, ROUTE_ID, 'REMOTE_RELAY_ROUTE_INVALID'),
    generation: number(value.generation, 'REMOTE_RELAY_ROUTE_INVALID'),
    connectionEpoch: number(value.connectionEpoch, 'REMOTE_RELAY_EPOCH_INVALID'),
    senderDeviceId: text(value.senderDeviceId, DEVICE_ID, 'REMOTE_RELAY_ID_INVALID'),
    senderEnrollmentId: text(value.senderEnrollmentId, DEVICE_ID, 'REMOTE_RELAY_ID_INVALID'),
    recipientDeviceId: text(value.recipientDeviceId, DEVICE_ID, 'REMOTE_RELAY_ID_INVALID'),
    recipientEnrollmentId: text(value.recipientEnrollmentId, DEVICE_ID, 'REMOTE_RELAY_ID_INVALID'),
  } as const
  if (value.type === 'hello' || value.type === 'welcome') {
    if (!exactKeys(value, ['version', 'type', 'routeId', 'generation', 'connectionEpoch', 'senderDeviceId', 'senderEnrollmentId', 'recipientDeviceId', 'recipientEnrollmentId', 'ephemeralPublicKey', 'nonce'])) return failure('REMOTE_RELAY_MALFORMED')
    const ephemeralPublicKey = base64Bytes(value.ephemeralPublicKey, 'REMOTE_RELAY_KEY_INVALID', REMOTE_RELAY_X25519_BYTES)
    const nonce = base64Bytes(value.nonce, 'REMOTE_RELAY_CIPHERTEXT_INVALID', REMOTE_RELAY_NONCE_BYTES)
    try {
      if (ephemeralPublicKey.byteLength !== REMOTE_RELAY_X25519_BYTES || nonce.byteLength !== REMOTE_RELAY_NONCE_BYTES) return failure('REMOTE_RELAY_KEY_INVALID')
      return value.type === 'hello'
        ? { ...common, type: 'hello', ephemeralPublicKey: value.ephemeralPublicKey as string, nonce: value.nonce as string }
        : { ...common, type: 'welcome', ephemeralPublicKey: value.ephemeralPublicKey as string, nonce: value.nonce as string }
    } finally {
      ephemeralPublicKey.fill(0)
      nonce.fill(0)
    }
  }
  if (value.type === 'ready' || value.type === 'finish' || value.type === 'ack' || value.type === 'commit' || value.type === 'confirm' || value.type === 'receipt') {
    if (!exactKeys(value, ['version', 'type', 'routeId', 'generation', 'connectionEpoch', 'senderDeviceId', 'senderEnrollmentId', 'recipientDeviceId', 'recipientEnrollmentId', 'nonce', 'ciphertext'])) return failure('REMOTE_RELAY_MALFORMED')
    const nonce = base64Bytes(value.nonce, 'REMOTE_RELAY_CIPHERTEXT_INVALID', REMOTE_RELAY_NONCE_BYTES)
    const ciphertext = base64Bytes(value.ciphertext, 'REMOTE_RELAY_CIPHERTEXT_INVALID', 512)
    try {
      if (nonce.byteLength !== REMOTE_RELAY_NONCE_BYTES || ciphertext.byteLength < 17) return failure('REMOTE_RELAY_CIPHERTEXT_INVALID')
      return value.type === 'ready'
        ? { ...common, type: 'ready', nonce: value.nonce as string, ciphertext: value.ciphertext as string }
        : value.type === 'finish'
          ? { ...common, type: 'finish', nonce: value.nonce as string, ciphertext: value.ciphertext as string }
          : value.type === 'ack'
            ? { ...common, type: 'ack', nonce: value.nonce as string, ciphertext: value.ciphertext as string }
            : value.type === 'commit'
              ? { ...common, type: 'commit', nonce: value.nonce as string, ciphertext: value.ciphertext as string }
              : value.type === 'confirm'
                ? { ...common, type: 'confirm', nonce: value.nonce as string, ciphertext: value.ciphertext as string }
                : { ...common, type: 'receipt', nonce: value.nonce as string, ciphertext: value.ciphertext as string }
    } finally {
      nonce.fill(0)
      ciphertext.fill(0)
    }
  }
  if (value.type === 'ciphertext') {
    if (!exactKeys(value, ['version', 'type', 'routeId', 'generation', 'connectionEpoch', 'senderDeviceId', 'senderEnrollmentId', 'recipientDeviceId', 'recipientEnrollmentId', 'sequence', 'nonce', 'ciphertext'])) return failure('REMOTE_RELAY_MALFORMED')
    const nonce = base64Bytes(value.nonce, 'REMOTE_RELAY_CIPHERTEXT_INVALID', REMOTE_RELAY_NONCE_BYTES)
    const ciphertext = base64Bytes(value.ciphertext, 'REMOTE_RELAY_CIPHERTEXT_INVALID', MAX_REMOTE_RELAY_CIPHERTEXT_BYTES)
    try {
      if (nonce.byteLength !== REMOTE_RELAY_NONCE_BYTES || ciphertext.byteLength < 17) return failure('REMOTE_RELAY_CIPHERTEXT_INVALID')
      return { ...common, type: 'ciphertext', sequence: number(value.sequence, 'REMOTE_RELAY_SEQUENCE_INVALID'), nonce: value.nonce as string, ciphertext: value.ciphertext as string }
    } finally {
      nonce.fill(0)
      ciphertext.fill(0)
    }
  }
  return failure('REMOTE_RELAY_MALFORMED')
}

/**
 * Parse one exact, bounded V3 relay WebSocket message without decrypting application data.
 * @param serialized - Unknown WebSocket payload to validate as relay JSON.
 * @returns the exact validated relay message.
 */
export function parseRemoteRelayMessage(serialized: unknown): RemoteRelayMessage {
  if (typeof serialized !== 'string' || serialized.length > MAX_MESSAGE_BYTES) return failure('REMOTE_RELAY_MALFORMED')
  if (TEXT.encode(serialized).byteLength > MAX_MESSAGE_BYTES) return failure('REMOTE_RELAY_CIPHERTEXT_INVALID')
  try {
    const value: unknown = JSON.parse(serialized)
    return isRecord(value) ? parseMessageObject(value) : failure('REMOTE_RELAY_MALFORMED')
  } catch (error) {
    if (error instanceof RemoteRelayProtocolError) throw error
    return failure('REMOTE_RELAY_MALFORMED')
  }
}

/**
 * Serialize an exact V3 relay message after syntax validation.
 * @param value - Candidate relay message to validate and serialize.
 * @returns the compact validated relay JSON text.
 */
export function serializeRemoteRelayMessage(value: unknown): string {
  const parsed = isRecord(value) ? parseMessageObject(value) : failure('REMOTE_RELAY_MALFORMED')
  const serialized = JSON.stringify(parsed)
  return TEXT.encode(serialized).byteLength <= MAX_MESSAGE_BYTES ? serialized : failure('REMOTE_RELAY_CIPHERTEXT_INVALID')
}

async function receiveOne(socket: RemoteRelaySocket, signal?: AbortSignal): Promise<RemoteRelayMessage> {
  if (signal?.aborted) return failure('REMOTE_RELAY_SOCKET_CLOSED')
  const iterator = socket.receive(signal)[Symbol.asyncIterator]()
  let removeAbort: (() => void) | undefined
  try {
    const next = iterator.next()
    const result = signal === undefined
      ? await next
      : await Promise.race([
        next,
        new Promise<IteratorResult<string>>((_, reject) => {
          const abort = (): void => { reject(new RemoteRelayProtocolError('REMOTE_RELAY_SOCKET_CLOSED')) }
          signal.addEventListener('abort', abort, { once: true })
          removeAbort = (): void => { signal.removeEventListener('abort', abort) }
          if (signal.aborted) abort()
        }),
      ])
    return result.done ? failure('REMOTE_RELAY_SOCKET_CLOSED') : parseRemoteRelayMessage(result.value)
  } finally {
    removeAbort?.()
    void iterator.return?.()
  }
}

function trustedConnection(
  socket: RemoteRelaySocket,
  remotePeer: RemoteRelayPeerIdentity,
  routeCoordinates: RemoteRelayRoute,
  localPeer: RemoteRelayPeer,
  local: Pick<RemoteRelayIdentity, 'deviceId' | 'enrollmentId'>,
  random: RemoteRelayRandomSource,
  keys: DirectionKeys,
): TrustedRemoteRelayConnection {
  let closed = false
  let nextOutbound = 1
  let nextInbound = 1
  let sendTail: Promise<void> = Promise.resolve()
  const sendKey = localPeer === 'host' ? keys.hostToClient : keys.clientToHost
  const receiveKey = localPeer === 'host' ? keys.clientToHost : keys.hostToClient
  const destroy = (): void => {
    if (closed) return
    closed = true
    sendKey.fill(0)
    receiveKey.fill(0)
    keys.context.fill(0)
  }
  const fenceOpen = (fence: RemoteRelaySendFence, generation: number): boolean => !closed
    && fence.active && fence.generation === generation && !fence.abortSignal.aborted
  const send = async (envelope: RemoteWireEnvelope, fence: RemoteRelaySendFence): Promise<RemoteRelaySendResult> => {
    const fenceGeneration = fence.generation
    const previous = sendTail
    let release: (() => void) | undefined
    sendTail = new Promise((resolve) => { release = resolve })
    await previous
    let plaintext: Uint8Array | undefined
    let nonce: Uint8Array | undefined
    try {
      if (!fenceOpen(fence, fenceGeneration)) return { status: 'not-committed' }
      plaintext = TEXT.encode(serializeRemoteWireEnvelope(envelope))
      nonce = randomBytes(random, REMOTE_RELAY_NONCE_BYTES)
      const frame: RemoteRelayCiphertext = {
        version: REMOTE_RELAY_PROTOCOL_VERSION, type: 'ciphertext',
        routeId: routeCoordinates.routeId, generation: routeCoordinates.generation, connectionEpoch: routeCoordinates.connectionEpoch,
        senderDeviceId: local.deviceId, senderEnrollmentId: local.enrollmentId,
        recipientDeviceId: remotePeer.deviceId, recipientEnrollmentId: remotePeer.enrollmentId,
        sequence: nextOutbound, nonce: base64Url(nonce), ciphertext: '',
      }
      try {
        const message: RemoteRelayCiphertext = { ...frame, ciphertext: encodeCipher(sendKey, nonce, associatedData('ciphertext', frame), plaintext) }
        // This check and synchronous socket write are one event-loop turn: close cannot interleave.
        if (!fenceOpen(fence, fenceGeneration)) return { status: 'not-committed' }
        socket.send(serializeRemoteRelayMessage(message))
        nextOutbound += 1
        return { status: 'committed-before-fence' }
      } catch {
        destroy()
        socket.close(4400, 'relay-send-failed')
        return { status: 'not-committed' }
      } finally {
        plaintext.fill(0)
        nonce.fill(0)
      }
    } finally {
      plaintext?.fill(0)
      nonce?.fill(0)
      release?.()
    }
  }
  const receive = async function* (signal?: AbortSignal): AsyncIterable<RemoteWireEnvelope> {
    try {
      for await (const raw of socket.receive(signal)) {
        if (closed) return
        const message = parseRemoteRelayMessage(raw)
        if (message.type !== 'ciphertext') return failure('REMOTE_RELAY_HANDSHAKE_INVALID')
        exactRoute(message, routeCoordinates, remotePeer, local)
        if (message.sequence !== nextInbound) return failure('REMOTE_RELAY_REPLAY')
        const plaintext = decryptCipher(receiveKey, message.nonce, associatedData('ciphertext', message), message.ciphertext)
        try {
          const envelope = parseRemoteWireJson(TEXT_DECODER.decode(plaintext))
          if (envelope.connectionEpoch !== routeCoordinates.connectionEpoch) return failure('REMOTE_RELAY_EPOCH_INVALID')
          nextInbound += 1
          yield envelope
        } finally {
          plaintext.fill(0)
        }
      }
    } finally {
      destroy()
    }
  }
  return {
    peer: remotePeer,
    deviceId: remotePeer.deviceId,
    route: routeCoordinates,
    receive,
    send,
    close(reason = 'relay-closed'): void {
      destroy()
      socket.close(1000, reason)
    },
  }
}

/**
 * Complete the device-initiated side of the three-DH handshake. The caller has
 * already authenticated the WebSocket to the blind relay with its route token.
 * @param input - Device identity, Host identity, route, socket, randomness, and cancellation inputs.
 * @returns an authenticated encrypted relay connection to the Host.
 */
export async function connectRemoteRelayDevice(
  input: Omit<ConnectionInput, 'peer'> & { readonly host: RemoteRelayPeerIdentity },
): Promise<TrustedRemoteRelayConnection> {
  const local = preflight(input.socket, () => localIdentity(input.identity))
  const peer = preflight(input.socket, () => identity(input.host))
  const coordinates = preflight(input.socket, () => route(input.route))
  const pair = preflight(input.socket, () => ephemeral(input.random))
  let derived: DirectionKeys | undefined
  try {
    const hello: RemoteRelayHello = {
      ...outboundAddress(coordinates, local, peer), type: 'hello',
      ephemeralPublicKey: pair.publicKey, nonce: base64Url(randomBytes(input.random, REMOTE_RELAY_NONCE_BYTES)),
    }
    input.socket.send(serializeRemoteRelayMessage(hello))
    const received = await receiveOne(input.socket, input.signal)
    if (received.type !== 'welcome') return failure('REMOTE_RELAY_HANDSHAKE_INVALID')
    exactRoute(received, coordinates, peer, local)
    const context = handshakeContext(hello, received)
    derived = keys(local, peer, pair, received.ephemeralPublicKey, context, true)
    const readyBase: Omit<RemoteRelayReady, 'nonce' | 'ciphertext'> = {
      ...outboundAddress(coordinates, local, peer), type: 'ready',
    }
    const nonce = randomBytes(input.random, REMOTE_RELAY_NONCE_BYTES)
    const readyFrame: RemoteRelayReady = {
      ...readyBase, nonce: base64Url(nonce), ciphertext: '',
    }
    const readyText = TEXT.encode(READY_TEXT)
    try {
      const ready: RemoteRelayReady = {
        ...readyFrame,
        ciphertext: encodeCipher(derived.clientToHost, nonce, associatedData('ready', readyFrame), readyText),
      }
      input.socket.send(serializeRemoteRelayMessage(ready))
    } finally {
      nonce.fill(0)
      readyText.fill(0)
    }
    const finish = await receiveOne(input.socket, input.signal)
    if (finish.type !== 'finish') return failure('REMOTE_RELAY_HANDSHAKE_INVALID')
    exactRoute(finish, coordinates, peer, local)
    const completion = decryptCipher(derived.hostToClient, finish.nonce, associatedData('finish', finish), finish.ciphertext)
    const expected = TEXT.encode(FINISH_TEXT)
    try {
      if (!equal(completion, expected)) return failure('REMOTE_RELAY_HANDSHAKE_INVALID')
    } finally {
      completion.fill(0)
      expected.fill(0)
    }
    const ackFrame: Omit<RemoteRelayAck, 'nonce' | 'ciphertext'> = {
      version: REMOTE_RELAY_PROTOCOL_VERSION, type: 'ack', routeId: coordinates.routeId,
      generation: coordinates.generation, connectionEpoch: coordinates.connectionEpoch,
      senderDeviceId: local.deviceId, senderEnrollmentId: local.enrollmentId,
      recipientDeviceId: peer.deviceId, recipientEnrollmentId: peer.enrollmentId,
    }
    const ackNonce = randomBytes(input.random, REMOTE_RELAY_NONCE_BYTES)
    const ack = { ...ackFrame, nonce: base64Url(ackNonce), ciphertext: '' } satisfies RemoteRelayAck
    const ackText = TEXT.encode(ACK_TEXT)
    try {
      input.socket.send(serializeRemoteRelayMessage({
        ...ack,
        ciphertext: encodeCipher(derived.clientToHost, ackNonce, associatedData('ack', ack), ackText),
      } satisfies RemoteRelayAck))
    } finally {
      ackNonce.fill(0)
      ackText.fill(0)
    }
    const commit = await receiveOne(input.socket, input.signal)
    if (commit.type !== 'commit') return failure('REMOTE_RELAY_HANDSHAKE_INVALID')
    exactRoute(commit, coordinates, peer, local)
    const committed = decryptCipher(derived.hostToClient, commit.nonce, associatedData('commit', commit), commit.ciphertext)
    const expectedCommit = TEXT.encode(COMMIT_TEXT)
    try {
      if (!equal(committed, expectedCommit)) return failure('REMOTE_RELAY_HANDSHAKE_INVALID')
    } finally {
      committed.fill(0)
      expectedCommit.fill(0)
    }
    const confirmFrame: Omit<RemoteRelayConfirm, 'nonce' | 'ciphertext'> = {
      version: REMOTE_RELAY_PROTOCOL_VERSION, type: 'confirm', routeId: coordinates.routeId,
      generation: coordinates.generation, connectionEpoch: coordinates.connectionEpoch,
      senderDeviceId: local.deviceId, senderEnrollmentId: local.enrollmentId,
      recipientDeviceId: peer.deviceId, recipientEnrollmentId: peer.enrollmentId,
    }
    const confirmNonce = randomBytes(input.random, REMOTE_RELAY_NONCE_BYTES)
    const confirm = { ...confirmFrame, nonce: base64Url(confirmNonce), ciphertext: '' } satisfies RemoteRelayConfirm
    const confirmText = TEXT.encode(CONFIRM_TEXT)
    try {
      input.socket.send(serializeRemoteRelayMessage({
        ...confirm,
        ciphertext: encodeCipher(derived.clientToHost, confirmNonce, associatedData('confirm', confirm), confirmText),
      } satisfies RemoteRelayConfirm))
    } finally {
      confirmNonce.fill(0)
      confirmText.fill(0)
    }
    const receipt = await receiveOne(input.socket, input.signal)
    if (receipt.type !== 'receipt') return failure('REMOTE_RELAY_HANDSHAKE_INVALID')
    exactRoute(receipt, coordinates, peer, local)
    const receivedReceipt = decryptCipher(derived.hostToClient, receipt.nonce, associatedData('receipt', receipt), receipt.ciphertext)
    const expectedReceipt = TEXT.encode(RECEIPT_TEXT)
    try {
      if (!equal(receivedReceipt, expectedReceipt)) return failure('REMOTE_RELAY_HANDSHAKE_INVALID')
    } finally {
      receivedReceipt.fill(0)
      expectedReceipt.fill(0)
    }
    const connection = trustedConnection(input.socket, peer, coordinates, 'device', local, input.random, derived)
    derived = undefined
    return connection
  } catch (error) {
    destroyDirectionKeys(derived)
    input.socket.close(4403, 'relay-handshake-failed')
    throw error
  } finally {
    pair.secretKey.fill(0)
  }
}

/**
 * Complete the Host side of a three-DH handshake and expose a connection only
 * after the device has proved possession of its enrolled static X25519 key.
 * @param input - Host identity, enrolled peer, route, socket, randomness, epoch finalizer, and cancellation inputs.
 * @returns an authenticated encrypted relay connection to the device.
 */
export async function acceptRemoteRelayDevice(
  input: ConnectionInput & { readonly epochFinalizer: RemoteRelayEpochFinalizer },
): Promise<TrustedRemoteRelayConnection> {
  const local = preflight(input.socket, () => localIdentity(input.identity))
  const peer = preflight(input.socket, () => identity(input.peer))
  const coordinates = preflight(input.socket, () => route(input.route))
  const pair = preflight(input.socket, () => ephemeral(input.random))
  let derived: DirectionKeys | undefined
  try {
    const received = await receiveOne(input.socket, input.signal)
    if (received.type !== 'hello') return failure('REMOTE_RELAY_HANDSHAKE_INVALID')
    exactRoute(received, coordinates, peer, local)
    const welcome: RemoteRelayWelcome = {
      ...outboundAddress(coordinates, local, peer), type: 'welcome',
      ephemeralPublicKey: pair.publicKey, nonce: base64Url(randomBytes(input.random, REMOTE_RELAY_NONCE_BYTES)),
    }
    const context = handshakeContext(received, welcome)
    derived = keys(local, peer, pair, received.ephemeralPublicKey, context, false)
    input.socket.send(serializeRemoteRelayMessage(welcome))
    const ready = await receiveOne(input.socket, input.signal)
    if (ready.type !== 'ready') return failure('REMOTE_RELAY_HANDSHAKE_INVALID')
    exactRoute(ready, coordinates, peer, local)
    const proof = decryptCipher(derived.clientToHost, ready.nonce, associatedData('ready', ready), ready.ciphertext)
    const expected = TEXT.encode(READY_TEXT)
    try {
      if (!equal(proof, expected)) return failure('REMOTE_RELAY_HANDSHAKE_INVALID')
    } finally {
      proof.fill(0)
      expected.fill(0)
    }
    const finishFrame: Omit<RemoteRelayFinish, 'nonce' | 'ciphertext'> = {
      version: REMOTE_RELAY_PROTOCOL_VERSION,
      type: 'finish',
      routeId: coordinates.routeId,
      generation: coordinates.generation,
      connectionEpoch: coordinates.connectionEpoch,
      senderDeviceId: local.deviceId,
      senderEnrollmentId: local.enrollmentId,
      recipientDeviceId: peer.deviceId,
      recipientEnrollmentId: peer.enrollmentId,
    }
    const nonce = randomBytes(input.random, REMOTE_RELAY_NONCE_BYTES)
    const finish: RemoteRelayFinish = { ...finishFrame, nonce: base64Url(nonce), ciphertext: '' }
    const completion = TEXT.encode(FINISH_TEXT)
    try {
      const encrypted: RemoteRelayFinish = {
        ...finish,
        ciphertext: encodeCipher(derived.hostToClient, nonce, associatedData('finish', finish), completion),
      }
      input.socket.send(serializeRemoteRelayMessage(encrypted))
    } finally {
      nonce.fill(0)
      completion.fill(0)
    }
    const ack = await receiveOne(input.socket, input.signal)
    if (ack.type !== 'ack') return failure('REMOTE_RELAY_HANDSHAKE_INVALID')
    exactRoute(ack, coordinates, peer, local)
    const acknowledged = decryptCipher(derived.clientToHost, ack.nonce, associatedData('ack', ack), ack.ciphertext)
    const expectedAck = TEXT.encode(ACK_TEXT)
    try {
      if (!equal(acknowledged, expectedAck)) return failure('REMOTE_RELAY_HANDSHAKE_INVALID')
    } finally {
      acknowledged.fill(0)
      expectedAck.fill(0)
    }
    const commitFrame: Omit<RemoteRelayCommit, 'nonce' | 'ciphertext'> = {
      version: REMOTE_RELAY_PROTOCOL_VERSION, type: 'commit', routeId: coordinates.routeId,
      generation: coordinates.generation, connectionEpoch: coordinates.connectionEpoch,
      senderDeviceId: local.deviceId, senderEnrollmentId: local.enrollmentId,
      recipientDeviceId: peer.deviceId, recipientEnrollmentId: peer.enrollmentId,
    }
    const commitNonce = randomBytes(input.random, REMOTE_RELAY_NONCE_BYTES)
    const commit = { ...commitFrame, nonce: base64Url(commitNonce), ciphertext: '' } satisfies RemoteRelayCommit
    const commitText = TEXT.encode(COMMIT_TEXT)
    try {
      input.socket.send(serializeRemoteRelayMessage({
        ...commit,
        ciphertext: encodeCipher(derived.hostToClient, commitNonce, associatedData('commit', commit), commitText),
      } satisfies RemoteRelayCommit))
    } finally {
      commitNonce.fill(0)
      commitText.fill(0)
    }
    const confirm = await receiveOne(input.socket, input.signal)
    if (confirm.type !== 'confirm') return failure('REMOTE_RELAY_HANDSHAKE_INVALID')
    exactRoute(confirm, coordinates, peer, local)
    const confirmed = decryptCipher(derived.clientToHost, confirm.nonce, associatedData('confirm', confirm), confirm.ciphertext)
    const expectedConfirm = TEXT.encode(CONFIRM_TEXT)
    try {
      if (!equal(confirmed, expectedConfirm)) return failure('REMOTE_RELAY_HANDSHAKE_INVALID')
    } finally {
      confirmed.fill(0)
      expectedConfirm.fill(0)
    }
    await input.epochFinalizer.finalize(coordinates, peer)
    if (input.signal?.aborted) return failure('REMOTE_RELAY_SOCKET_CLOSED')
    const receiptFrame: Omit<RemoteRelayReceipt, 'nonce' | 'ciphertext'> = {
      version: REMOTE_RELAY_PROTOCOL_VERSION, type: 'receipt', routeId: coordinates.routeId,
      generation: coordinates.generation, connectionEpoch: coordinates.connectionEpoch,
      senderDeviceId: local.deviceId, senderEnrollmentId: local.enrollmentId,
      recipientDeviceId: peer.deviceId, recipientEnrollmentId: peer.enrollmentId,
    }
    const receiptNonce = randomBytes(input.random, REMOTE_RELAY_NONCE_BYTES)
    const receipt = { ...receiptFrame, nonce: base64Url(receiptNonce), ciphertext: '' } satisfies RemoteRelayReceipt
    const receiptText = TEXT.encode(RECEIPT_TEXT)
    try {
      input.socket.send(serializeRemoteRelayMessage({
        ...receipt,
        ciphertext: encodeCipher(derived.hostToClient, receiptNonce, associatedData('receipt', receipt), receiptText),
      } satisfies RemoteRelayReceipt))
    } finally {
      receiptNonce.fill(0)
      receiptText.fill(0)
    }
    const connection = trustedConnection(input.socket, peer, coordinates, 'host', local, input.random, derived)
    derived = undefined
    return connection
  } catch (error) {
    destroyDirectionKeys(derived)
    input.socket.close(4403, 'relay-handshake-failed')
    throw error
  } finally {
    pair.secretKey.fill(0)
  }
}
