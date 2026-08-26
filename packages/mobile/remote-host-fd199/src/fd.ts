/**
 * Hosted-runtime invocation contract: the exact command-line suffix and
 * inherited descriptors the signed Host application must supply. Ordinary
 * `dsh web` invocations carry neither and stay completely unaffected.
 * @module @deepseek-ai/dsh-remote-host-fd199/fd
 */

import { fstatSync } from 'node:fs'
import { Socket } from 'node:net'
import { REMOTE_HOST_V3_PRIVATE_FD } from '@deepseek-ai/dsh-remote-host-v3'
import { Fd199AuthorityError } from './error.ts'

/** The only FD199 authority descriptor inherited from the signed Host application. */
export const REMOTE_HOST_FD199_AUTHORITY_FD = 199

/** The only permitted hosted-runtime command-line suffix, in argv order. */
export const HOSTED_RUNTIME_ARGUMENTS = Object.freeze([
  '--private-relay-fd', String(REMOTE_HOST_V3_PRIVATE_FD),
  '--private-authority-fd', String(REMOTE_HOST_FD199_AUTHORITY_FD),
] as const)

/** Number of trailing argv entries the hosted contract occupies. */
const HOSTED_ARGUMENT_COUNT = HOSTED_RUNTIME_ARGUMENTS.length

/**
 * Validates the exact hosted invocation contract before any boot effect:
 * the trailing arguments must match exactly and both private descriptors
 * must already be sockets. Any other invocation is not a hosted runtime.
 * @param argv - Complete `process.argv`.
 * @returns whether this process was launched as a signed-Host hosted runtime.
 */
export function isHostedRuntimeInvocation(argv: readonly string[]): boolean {
  if (argv.length < HOSTED_ARGUMENT_COUNT) return false
  const suffix = argv.slice(-HOSTED_ARGUMENT_COUNT)
  return suffix.every((value, index) => value === HOSTED_RUNTIME_ARGUMENTS[index])
}

/**
 * Validates that both private descriptors are inherited sockets. Call only
 * after {@link isHostedRuntimeInvocation} accepted the invocation.
 * @throws {Fd199AuthorityError} when either descriptor is missing or not a socket.
 */
export function validateInheritedDescriptors(): void {
  for (const descriptor of [REMOTE_HOST_V3_PRIVATE_FD, REMOTE_HOST_FD199_AUTHORITY_FD]) {
    try {
      if (!fstatSync(descriptor).isSocket()) throw new Fd199AuthorityError()
    } catch (error) {
      if (error instanceof Fd199AuthorityError) throw error
      throw new Fd199AuthorityError()
    }
  }
}

/**
 * Wraps the inherited authority descriptor without connecting or listening;
 * the kernel-private socketpair was created by the signed Host application.
 * @param descriptor - Raw inherited descriptor; production passes none and adopts 199.
 * @returns the connected channel for the descriptor.
 * @throws {Fd199AuthorityError} when the descriptor cannot be adopted.
 */
export function adoptInheritedAuthoritySocket(descriptor: number = REMOTE_HOST_FD199_AUTHORITY_FD): Socket {
  try {
    const channel = new Socket({ fd: descriptor, readable: true, writable: true })
    channel.setNoDelay(true)
    return channel
  } catch {
    throw new Fd199AuthorityError()
  }
}
