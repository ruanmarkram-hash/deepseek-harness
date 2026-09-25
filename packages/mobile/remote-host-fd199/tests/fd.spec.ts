import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fstatSync, statSync } from 'node:fs'
import { Socket } from 'node:net'
import { adoptInheritedAuthoritySocket, HOSTED_RUNTIME_ARGUMENTS, isHostedRuntimeInvocation, validateInheritedDescriptors } from '../src/fd.ts'

const { setNoDelay } = vi.hoisted(() => ({ setNoDelay: vi.fn() }))
vi.mock('node:net', () => ({ Socket: vi.fn(class { setNoDelay = setNoDelay }) }))

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(), fstatSync: vi.fn(),
}))

describe('inherited descriptor validation', () => {
  beforeEach(() => { vi.mocked(fstatSync).mockReset() })

  it('accepts only the exact hosted suffix', () => {
    expect(isHostedRuntimeInvocation([])).toBe(false)
    expect(isHostedRuntimeInvocation(['node', 'entry', ...HOSTED_RUNTIME_ARGUMENTS])).toBe(true)
    expect(isHostedRuntimeInvocation([...HOSTED_RUNTIME_ARGUMENTS, 'extra'])).toBe(false)
  })

  it('adopts only the requested inherited socket and sanitizes constructor failure', () => {
    adoptInheritedAuthoritySocket()
    expect(Socket).toHaveBeenLastCalledWith({ fd: 199, readable: true, writable: true })
    expect(setNoDelay).toHaveBeenCalledWith(true)
    adoptInheritedAuthoritySocket(201)
    expect(Socket).toHaveBeenLastCalledWith({ fd: 201, readable: true, writable: true })
    vi.mocked(Socket).mockImplementationOnce(() => { throw new Error('private') })
    expect(() => adoptInheritedAuthoritySocket()).toThrow('FD199')
  })

  it('uses the BigInt stat buffer so socket checks cannot poison CommonJS realpath resolution', () => {
    const stats = statSync(new URL(import.meta.url), { bigint: true })
    vi.mocked(fstatSync).mockReturnValue(Object.assign(stats, { isSocket: () => true }))
    expect(validateInheritedDescriptors).not.toThrow()
    expect(fstatSync).toHaveBeenNthCalledWith(1, 198, { bigint: true })
    expect(fstatSync).toHaveBeenNthCalledWith(2, 199, { bigint: true })
    expect(fstatSync).toHaveBeenCalledTimes(2)
  })

  it('rejects a non-socket descriptor', () => {
    vi.mocked(fstatSync).mockReturnValue(statSync(new URL(import.meta.url), { bigint: true }))
    expect(validateInheritedDescriptors).toThrow()
    expect(fstatSync).toHaveBeenCalledOnce()
  })

  it('rejects an unavailable descriptor', () => {
    vi.mocked(fstatSync).mockImplementation(() => {
      throw new Error('inspection sentinel')
    })
    expect(validateInheritedDescriptors).toThrow()
    expect(fstatSync).toHaveBeenCalledExactlyOnceWith(198, { bigint: true })
  })
})
