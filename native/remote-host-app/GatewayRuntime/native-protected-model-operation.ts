/**
 * Typed native operation for one fixed signed-Host model route. It deliberately
 * accepts work and returns model output, never credential material or a
 * generic provider client. The production native implementation is not linked
 * yet; this is the only permitted seam for its future Keychain use.
 */

/** Fixed provider/model identity chosen by the signed Host build. */
export interface FixedModelIdentity {
  readonly provider: string
  readonly model: string
}

/** One text-only user turn supplied to the protected model operation. */
export interface ProtectedModelTurn {
  readonly sessionId: string
  readonly model: FixedModelIdentity
  readonly text: string
}

/** A single approval requested by the model's fixed agent execution. */
export interface ProtectedModelApprovalRequest {
  readonly sessionId: string
  readonly toolName: string
  readonly reason?: string
}

/** A single question requested by the model's fixed agent execution. */
export interface ProtectedModelQuestionRequest {
  readonly sessionId: string
  readonly questions: readonly { readonly id: string; readonly question: string }[]
}

/** The model operation's interaction callbacks, implemented by the sealed core. */
export interface ProtectedModelInteractions {
  requestApproval(request: ProtectedModelApprovalRequest): Promise<'allowed-once' | 'rejected'>
  requestQuestion(request: ProtectedModelQuestionRequest): Promise<unknown>
}

/** A completed model turn. Streaming belongs inside the native protected operation. */
export interface ProtectedModelCompletion { readonly text: string }

/**
 * Native Keychain-only model operation. It has no credential getter, export,
 * arbitrary endpoint parameter, or phone-controlled input beyond one admitted
 * text turn. A future signed Host implementation must retain Keychain access
 * in native code and expose only this operation to the Node child.
 */
export interface NativeProtectedModelOperation {
  readonly capability: 'signed-host-keychain-model-operation-v1'
  readonly model: FixedModelIdentity
  complete(turn: ProtectedModelTurn, interactions: ProtectedModelInteractions, signal: AbortSignal): Promise<ProtectedModelCompletion>
}
