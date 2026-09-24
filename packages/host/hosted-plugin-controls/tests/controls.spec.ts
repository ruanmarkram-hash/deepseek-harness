import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { afterEach, describe, expect, it, vi } from 'vitest'

const reconcile = vi.hoisted(() => vi.fn(async (
  _ctx: Context, _patches: PatchOptions[], _name: string, _requiredIds: readonly string[],
): Promise<string[]> => []))
vi.mock('@deepseek-ai/dsh-app-boot', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-app-boot')>(),
  reconcileProfilePatches: reconcile,
}))

import { HostedPluginState } from '../src/index.ts'

const homes: string[] = []
afterEach(() => {
  reconcile.mockReset()
  reconcile.mockResolvedValue([])
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function fixture(): {
  home: string
  patches: PatchOptions[]
  context: Context
  entries: Array<{ options: { id: string }; disabled: boolean }>
} {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hosted-plugins-'))
  homes.push(home)
  const patches: PatchOptions[] = [{ insert: [
    { id: 'native-computer-use-policy', name: '@deepseek-ai/dsh-experimental-computer-use-policy' },
    { id: 'progress-narration', name: '@deepseek-ai/dsh-progress-narration' },
    { id: 'remote-gateway', name: '@deepseek-ai/dsh-remote-gateway' },
  ] }]
  const entries = [
    { options: { id: 'native-computer-use-policy' }, disabled: false },
    { options: { id: 'progress-narration' }, disabled: false },
    { options: { id: 'remote-gateway' }, disabled: false },
  ]
  const context = { root: {}, loader: { entries: () => entries } } as unknown as Context
  return { home, patches, context, entries }
}

describe('signed Host plugin controls', () => {
  it('keeps a signed downloaded row off until its exact digest is enabled', async () => {
    const { home, patches, context, entries } = fixture()
    const digest = 'a'.repeat(64)
    patches.push({ insert: [{ id: 'web-search-brave', name: '@rulabs/dsh-web-search-brave', disabled: true }] })
    entries.push({ options: { id: 'web-search-brave' }, disabled: true })
    const approved = [{ id: 'web-search-brave', name: '@rulabs/dsh-web-search-brave', version: '1.0.0', sha256: digest }]
    const state = new HostedPluginState(home, patches, approved)
    state.setComposer(overrides => [...patches, ...overrides])
    expect(state.list(context).plugins.at(-1)).toMatchObject({ id: 'web-search-brave', source: 'downloaded', enabled: false, required: false })
    expect(state.overrides()).toEqual([{ id: 'web-search-brave', disabled: true }])
    reconcile.mockImplementation(async (_ctx, candidate) => {
      const row = candidate.flatMap(patch => patch.insert ?? []).find(item => item.id === 'web-search-brave')
      const override = candidate.filter(patch => patch.id === 'web-search-brave').at(-1)
      entries.at(-1)!.disabled = override?.disabled ?? row?.disabled ?? false
      return []
    })
    await state.setEnabled(context, { id: 'web-search-brave', enabled: true })
    expect(state.list(context).plugins.at(-1)?.enabled).toBe(true)
    expect(JSON.parse(readFileSync(state.documentPath, 'utf8'))).toMatchObject({
      version: 2, enabledApproved: [{ id: 'web-search-brave', sha256: digest }],
    })
    const next = new HostedPluginState(home, patches, approved)
    expect(next.overrides()).toEqual([{ id: 'web-search-brave', disabled: false }])
    const updated = new HostedPluginState(home, patches, [{ ...approved[0]!, sha256: 'b'.repeat(64) }])
    expect(updated.overrides()).toEqual([{ id: 'web-search-brave', disabled: true }])
  })

  it('lists signed rows and refuses required or unknown IDs', async () => {
    const { home, patches, context } = fixture()
    const state = new HostedPluginState(home, patches)
    state.setComposer(overrides => [...patches, ...overrides])
    expect(state.list(context).plugins).toEqual([
      { id: 'native-computer-use-policy', name: '@deepseek-ai/dsh-experimental-computer-use-policy', source: 'bundled', enabled: true, required: false },
      { id: 'progress-narration', name: '@deepseek-ai/dsh-progress-narration', source: 'bundled', enabled: true, required: false },
      { id: 'remote-gateway', name: '@deepseek-ai/dsh-remote-gateway', source: 'bundled', enabled: true, required: true, reason: 'This signed Host row is fixed.' },
    ])
    await expect(state.setEnabled(context, { id: 'remote-gateway', enabled: false })).rejects.toThrow('required or unknown')
    await expect(state.setEnabled(context, { id: 'unlisted', enabled: false })).rejects.toThrow('required or unknown')
    await expect(state.setEnabled(context, { id: 'progress-narration', enabled: false, extra: true } as never))
      .rejects.toThrow('exact ID and boolean')
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('persists an optional disable only after live reconciliation and restores on next boot', async () => {
    const { home, patches, context, entries } = fixture()
    const state = new HostedPluginState(home, patches)
    state.setComposer(overrides => [...patches, ...overrides])
    reconcile.mockImplementation(async (_ctx, candidate) => {
      entries[1]!.disabled = candidate.some(patch => patch.id === 'progress-narration' && patch.disabled === true)
      return []
    })
    const changed = await state.setEnabled(context, { id: 'progress-narration', enabled: false })
    expect(reconcile).toHaveBeenCalledWith(context.root, [...patches, { id: 'progress-narration', disabled: true }], 'dsh', [])
    expect(changed.plugin.id).toBe('progress-narration')
    expect(changed.plugin.enabled).toBe(false)
    expect(state.overrides()).toEqual([{ id: 'progress-narration', disabled: true }])
    expect(JSON.parse(readFileSync(state.documentPath, 'utf8'))).toEqual({ version: 1, disabled: ['progress-narration'] })
    expect(new HostedPluginState(home, patches).overrides()).toEqual([{ id: 'progress-narration', disabled: true }])
  })

  it('rolls back Loader state and retains previous bytes after reconcile fails', async () => {
    const { home, patches, context } = fixture()
    const state = new HostedPluginState(home, patches)
    state.setComposer(overrides => [...patches, ...overrides])
    reconcile.mockRejectedValueOnce(new Error('plugin failed'))
    await expect(state.setEnabled(context, { id: 'progress-narration', enabled: false })).rejects.toThrow('plugin failed')
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(state.overrides()).toEqual([])
    expect(existsSync(state.documentPath)).toBe(false)
  })

  it('rejects unapproved, duplicate, and externally changed state', async () => {
    const { home, patches, context } = fixture()
    const path = join(home, 'hosted-plugins.json')
    for (const value of [
      { version: 1, disabled: ['remote-gateway'] },
      { version: 1, disabled: ['progress-narration', 'progress-narration'] },
      { version: 1, disabled: [], extra: true },
    ]) {
      writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
      expect(() => new HostedPluginState(home, patches)).toThrow()
    }
    writeFileSync(path, '{"version":1,"disabled":[]}', { mode: 0o600 })
    const state = new HostedPluginState(home, patches)
    state.setComposer(overrides => [...patches, ...overrides])
    writeFileSync(path, '{"version":1,"disabled":["progress-narration"]}')
    await expect(state.setEnabled(context, { id: 'progress-narration', enabled: false })).rejects.toThrow('changed outside')
    expect(reconcile).not.toHaveBeenCalled()
    chmodSync(path, 0o644)
    expect(() => new HostedPluginState(home, patches)).toThrow('owner-only regular file')
    chmodSync(path, 0o600)
    writeFileSync(path, 'x'.repeat(5000))
    expect(() => new HostedPluginState(home, patches)).toThrow('owner-only regular file')
  })

  it('preserves an outside write that races the live reconcile', async () => {
    const { home, patches, context } = fixture()
    const state = new HostedPluginState(home, patches)
    state.setComposer(overrides => [...patches, ...overrides])
    const external = '{"version":1,"disabled":["progress-narration"]}\n'
    reconcile.mockImplementationOnce(async () => {
      writeFileSync(state.documentPath, external, { mode: 0o600 })
      return []
    })
    await expect(state.setEnabled(context, { id: 'progress-narration', enabled: false })).rejects.toThrow('changed outside')
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(state.overrides()).toEqual([])
    expect(readFileSync(state.documentPath, 'utf8')).toBe(external)
  })

  it('rejects symlinked state and a signed composition missing an optional row', () => {
    const { home, patches } = fixture()
    const path = join(home, 'hosted-plugins.json')
    const target = join(home, 'target.json')
    writeFileSync(target, '{"version":1,"disabled":[]}', { mode: 0o600 })
    symlinkSync(target, path)
    expect(() => new HostedPluginState(home, patches)).toThrow('owner-only regular file')
    rmSync(path)
    expect(() => new HostedPluginState(home, patches.slice(0, 0))).toThrow('require one enabled signed row')
  })
})
