import { describe, expect, it, vi } from 'vitest'
import { loadMobilePlugins, loadMobilePluginsAfterToggle, setMobilePluginEnabled, type MobilePlugin } from '../mobile-plugins'

const optional: MobilePlugin = { id: 'computer-use', name: 'Computer use', source: 'bundled', enabled: true, required: false }
const required: MobilePlugin = { id: 'remote-api', name: 'Remote API', source: 'bundled', enabled: true, required: true, reason: 'Needed for the phone connection' }

describe('mobile plugin controls', () => {
  it('loads the Host catalog without accepting malformed rows', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, value: { plugins: [optional, required] } })
    expect(await loadMobilePlugins(request)).toEqual([optional, required])
    expect(request).toHaveBeenCalledWith('plugins.list', {})
    request.mockResolvedValueOnce({ ok: true, value: { plugins: [{ ...optional, required: 'no' }] } })
    await expect(loadMobilePlugins(request)).rejects.toThrow('invalid plugin list')
  })

  it('refuses required plugins locally and replaces an optional row only after Host success', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, value: { plugin: { ...optional, enabled: false } } })
    await expect(setMobilePluginEnabled(request, required, false)).rejects.toThrow('Needed for the phone connection')
    expect(request).not.toHaveBeenCalled()
    expect(await setMobilePluginEnabled(request, optional, false)).toEqual({ ...optional, enabled: false })
    expect(request).toHaveBeenCalledWith('plugins.setEnabled', { id: 'computer-use', enabled: false })
  })

  it('keeps the old state on Host refusal or a mismatched response', async () => {
    const request = vi.fn().mockResolvedValueOnce({ ok: false, error: { message: 'This plugin is locked' } })
      .mockResolvedValueOnce({ ok: true, value: { plugin: { ...optional, id: 'different', enabled: false } } })
    await expect(setMobilePluginEnabled(request, optional, false)).rejects.toThrow('This plugin is locked')
    await expect(setMobilePluginEnabled(request, optional, false)).rejects.toThrow('invalid plugin update')
  })

  it('refreshes from the Host after a pending toggle settles, including after reconnect', async () => {
    let finishToggle: ((value: { ok: true; value: { plugin: MobilePlugin } }) => void) | undefined
    const request = vi.fn().mockImplementation((method: string) => method === 'plugins.setEnabled'
      ? new Promise((resolve) => { finishToggle = resolve })
      : Promise.resolve({ ok: true, value: { plugins: [{ ...optional, enabled: false }] } }))
    const pending = setMobilePluginEnabled(request, optional, false)
    const refresh = loadMobilePluginsAfterToggle(request, pending)
    expect(request).toHaveBeenCalledTimes(1)
    finishToggle?.({ ok: true, value: { plugin: { ...optional, enabled: false } } })
    expect(await refresh).toEqual([{ ...optional, enabled: false }])
    expect(request.mock.calls.map(call => call[0])).toEqual(['plugins.setEnabled', 'plugins.list'])
  })

  it('re-reads Host state after a toggle fails', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, value: { plugins: [optional] } })
    expect(await loadMobilePluginsAfterToggle(request, Promise.reject(new Error('connection stopped')))).toEqual([optional])
    expect(request).toHaveBeenCalledWith('plugins.list', {})
  })
})
