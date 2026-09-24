import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fstatSync, statSync } from 'node:fs'
import { validateInheritedDescriptors } from '../src/fd.ts'

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(), fstatSync: vi.fn(),
}))

describe('inherited descriptor validation', () => {
  beforeEach(() => { vi.mocked(fstatSync).mockReset() })

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
