/** Protected native Host identity adapter with no private-key bytes in JavaScript.
 * @module @deepseek-ai/dsh-remote-host-identity/identity */

import type { RemoteHostPublicIdentity } from './types.ts'

/** Native secure-store identity handle. Private keys never cross into JavaScript. */
export interface ProtectedRemoteHostIdentityHandle {
  /** @returns public static identity metadata. */
  publicIdentity(): RemoteHostPublicIdentity
  /** @param payload - Exact transcript bytes. @returns detached signature. */
  sign(payload: Uint8Array): Uint8Array
  /** @param remoteAgreementPublicKey - Remote X25519 public key. @returns KDF input bytes. */
  deriveSharedSecret(remoteAgreementPublicKey: string): Uint8Array
}

/** Host facade over a signed native protected-key handle. */
export class RemoteHostIdentity {
  /** @param handle - Native protected identity handle. */
  private constructor(private readonly handle: ProtectedRemoteHostIdentityHandle) {}

  /**
   * Wraps a signed native provider handle without exposing its private keys.
   * @param handle - Signed native provider handle.
   * @returns Host identity facade.
   */
  static fromProtectedHandle(handle: ProtectedRemoteHostIdentityHandle): RemoteHostIdentity {
    return new RemoteHostIdentity(handle)
  }

  /**
   * Copies the public metadata exposed by the protected identity handle.
   * @returns a caller-owned public identity copy.
   */
  publicIdentity(): RemoteHostPublicIdentity { return { ...this.handle.publicIdentity() } }

  /**
   * Signs exact handshake transcript bytes through the protected handle.
   * @param payload - Exact handshake transcript bytes.
   * @returns detached signature bytes.
   */
  sign(payload: Uint8Array): Uint8Array { return new Uint8Array(this.handle.sign(payload)) }

  /**
   * Derives shared-secret input through the protected agreement key.
   * @param remoteAgreementPublicKey - Base64url remote public key.
   * @returns KDF input bytes.
   */
  deriveSharedSecret(remoteAgreementPublicKey: string): Uint8Array {
    return new Uint8Array(this.handle.deriveSharedSecret(remoteAgreementPublicKey))
  }
}
