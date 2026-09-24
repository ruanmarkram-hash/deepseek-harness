import { describe, expect, it, vi } from 'vitest'
import { AnywherePairingError } from '../anywhere-pairing'
import { MobilePairingActions, pairingError } from '../mobile-pairing-actions'

const code = `dsh3.pairing_identifier_123.${'c'.repeat(32)}`

describe('mobile pairing input actions', () => {
  it('captures only the first camera callback and makes no submission until explicit confirmation', async () => {
    const actions = new MobilePairingActions()
    const captured: string[] = []
    const submit = vi.fn(async () => undefined)
    const cameraCallback = (value: string) => {
      const result = actions.scanCode(value)
      if (result !== undefined) captured.push(result)
    }
    actions.beginScan()
    // Native callbacks can arrive before React commits the mode change.
    cameraCallback(code)
    cameraCallback(code)
    expect(captured).toEqual([code])
    expect(submit).not.toHaveBeenCalled()
    await actions.submit(submit)
    expect(submit).toHaveBeenCalledOnce()
  })

  it('allows a fresh scan and rejects malformed QR content without submitting it', () => {
    const actions = new MobilePairingActions()
    expect(actions.scanCode(code)).toBeUndefined()
    actions.beginScan()
    expect(() => actions.scanCode('unrelated QR content')).toThrow('complete DSH pairing code')
    expect(actions.scanCode(code)).toBeUndefined()
    actions.beginScan()
    expect(actions.scanCode(` ${code} `)).toBe(code)
    actions.beginScan()
    actions.endScan()
    expect(actions.scanCode(code)).toBeUndefined()
  })

  it('suppresses repeated button callbacks before React renders and unlocks after completion', async () => {
    const actions = new MobilePairingActions()
    let finish!: () => void
    const submit = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const first = actions.submit(submit)
    const duplicate = actions.submit(submit)
    expect(submit).toHaveBeenCalledOnce()
    expect(actions.beginScan()).toBe(false)
    expect(actions.scanCode(code)).toBeUndefined()
    finish()
    await Promise.all([first, duplicate])
    expect(actions.beginScan()).toBe(true)
    await actions.submit(async () => undefined)
  })

  it('unlocks after a rejected submission', async () => {
    const actions = new MobilePairingActions()
    await expect(actions.submit(async () => { throw new Error('failed') })).rejects.toThrow('failed')
    const retry = vi.fn(async () => undefined)
    await actions.submit(retry)
    expect(retry).toHaveBeenCalledOnce()
  })

  it('preserves safe internet errors while keeping imported-invitation errors separate', () => {
    const missing = new AnywherePairingError('Pairing code may have expired or been removed.')
    expect(pairingError(missing)).toBe(missing.message)
    expect(pairingError(new Error('expired'))).toBe('This Host invitation has expired. Generate a new one from the Host.')
    expect(pairingError(new Error('raw untrusted details'))).not.toContain('raw untrusted details')
  })
})
