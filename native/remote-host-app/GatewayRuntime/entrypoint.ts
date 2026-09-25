/**
 * Release entrypoint for the optional, sealed Node implementation of the V3
 * fixed session gateway. Packaging stays inert; only an attested launcher runs it.
 */
import { fstatSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startSealedHostOwnedRuntime } from './host-owned-dsh-runtime.ts'
import { createStaticHostDshServices } from './static-host-dsh-services.ts'

/** The only private descriptor inherited from the native Host launcher. */
export const REMOTE_HOST_V3_PRIVATE_FD = 198

const PRIVATE_RUNTIME_ARGUMENTS = ['--private-fd', String(REMOTE_HOST_V3_PRIVATE_FD)] as const

/**
 * Validates the exact argument and inherited descriptor contract before an
 * explicitly reviewed native launcher may attach a sealed gateway runtime.
 * No environment values, paths, configuration, credentials, or generic IPC are
 * accepted here.
 */
export function validateSealedGatewayInvocation(argv: readonly string[]): void {
  const supplied = argv.slice(2)
  if (supplied.length !== PRIVATE_RUNTIME_ARGUMENTS.length || supplied.some((value, index) => value !== PRIVATE_RUNTIME_ARGUMENTS[index])) {
    throw new Error('sealed DSH gateway invocation is invalid')
  }
  const descriptor = REMOTE_HOST_V3_PRIVATE_FD
  const stat = fstatSync(descriptor)
  if (!stat.isSocket()) throw new Error('sealed DSH gateway descriptor is not a socket')
}

type CloexecAddon = { setCloseOnExec(): void }

function protectPrivateDescriptorFromDescendants(): void {
  const module = { exports: {} as CloexecAddon }
  process.dlopen(module, fileURLToPath(new URL('./fd198-cloexec.node', import.meta.url)))
  module.exports.setCloseOnExec()
}

validateSealedGatewayInvocation(process.argv)
protectPrivateDescriptorFromDescendants()
// The static composition currently fails before the private pipe is read when
// its signed DSH service closure is absent. Deferral retains the exact sealed
// closure for attestation without introducing a fallback transport.
queueMicrotask(() => {
  void createStaticHostDshServices().then(composition => startSealedHostOwnedRuntime(composition.services))
})
