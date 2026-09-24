import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { afterEach, describe, expect, it, vi } from 'vitest'

const reconcile = vi.hoisted(() => vi.fn(async (
  _ctx: Context, _patches: PatchOptions[], _name: string, _requiredIds: readonly string[],
): Promise<string[]> => []))
const changedOpenedFile = vi.hoisted(() => ({ value: false }))
const blockedDiskRead = vi.hoisted(() => ({ value: false }))
const simulatedOwnerMode = vi.hoisted(() => ({ value: 0o600 }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, chmodSync: (path: string, mode: number) => {
    if (process.platform === 'win32' && path.endsWith('hosted-plugins.json')) simulatedOwnerMode.value = mode
    fs.chmodSync(path, mode)
  }, lstatSync: (path: string) => {
    if (blockedDiskRead.value && path.endsWith('hosted-plugins.json')) {
      throw Object.assign(new Error('blocked'), { code: 'EACCES' })
    }
    const stat = fs.lstatSync(path)
    // Windows does not expose owner-only ACLs as POSIX mode bits. Model the
    // signed macOS Host file here; the production owner-only check is unchanged.
    if (process.platform === 'win32' && path.endsWith('hosted-plugins.json') && stat.isFile()) {
      stat.mode = (stat.mode & ~0o777) | simulatedOwnerMode.value
    }
    return stat
  }, fstatSync: (fd: number) => {
    const stat = fs.fstatSync(fd)
    if (process.platform === 'win32' && stat.isFile()) {
      stat.mode = (stat.mode & ~0o777) | simulatedOwnerMode.value
    }
    if (!changedOpenedFile.value) return stat
    // Windows inode numbers are not a portable identity signal. A file-type
    // change exercises the same fail-closed read path on that CI runner.
    return process.platform === 'win32'
      ? Object.assign(stat, { isFile: () => false })
      : Object.assign(stat, { ino: stat.ino + 1 })
  } }
})
vi.mock('@deepseek-ai/dsh-app-boot', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-app-boot')>(),
  reconcileProfilePatches: reconcile,
}))

import { HostedPluginControls, HostedPluginState } from '../src/index.ts'

const homes: string[] = []
afterEach(() => {
  changedOpenedFile.value = false
  blockedDiskRead.value = false
  simulatedOwnerMode.value = 0o600
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
  const context = new Context()
  Object.defineProperty(context, 'loader', { value: { entries: () => entries } })
  return { home, patches, context, entries }
}

describe('signed Host plugin controls', () => {
  it('rejects malformed persisted selections before composing plugins', () => {
    const { home, patches } = fixture()
    const path = join(home, 'hosted-plugins.json')
    const digest = 'a'.repeat(64)
    for (const [content, message] of [
      ['{', 'invalid JSON'],
      ['null', 'unapproved fields'],
      [JSON.stringify({ version: 3, disabled: [] }), 'unsupported version'],
      [JSON.stringify({ version: 2, disabled: [], enabledApproved: null }), 'unapproved plugin selection'],
      [JSON.stringify({ version: 2, disabled: [], enabledApproved: [null] }), 'unapproved plugin selection'],
      [JSON.stringify({ version: 2, disabled: [], enabledApproved: [{ id: 'search', sha256: digest }, { id: 'search', sha256: digest }] }), 'unapproved plugin selection'],
    ] as const) {
      writeFileSync(path, content, { mode: 0o600 })
      expect(() => new HostedPluginState(home, patches)).toThrow(message)
    }
  })

  it('rejects unsigned approvals and approval rows that do not match the sealed bundle', () => {
    const { home, patches } = fixture()
    const approved = { id: 'search', name: '@rulabs/search', version: '1.0.0', sha256: 'a'.repeat(64) }
    expect(() => new HostedPluginState(home, patches, [{ ...approved, id: 'Bad' }])).toThrow('invalid signed approval')
    expect(() => new HostedPluginState(home, patches, [approved, approved])).toThrow('invalid signed approval')
    expect(() => new HostedPluginState(home, patches, [approved])).toThrow('require one disabled signed approval row')
    patches.push({ insert: [{ id: 'search', name: approved.name }] })
    expect(() => new HostedPluginState(home, patches, [approved])).toThrow('require one disabled signed approval row')
  })

  it('requires every sealed row to remain visible in the live Loader', () => {
    const { home, patches, context, entries } = fixture()
    const state = new HostedPluginState(home, patches)
    entries.pop()
    expect(() => state.list(context)).toThrow('absent from the signed composition')
  })

  it('ignores composed entries without a named plugin row', () => {
    const { home, patches, context } = fixture()
    patches.push({ insert: [{ id: 'nameless' } as never] })
    expect(new HostedPluginState(home, patches).list(context).plugins).toHaveLength(3)
  })

  it('rejects edits without a composition owner and returns unchanged selections without reconciliation', async () => {
    const { home, patches, context } = fixture()
    const state = new HostedPluginState(home, patches)
    await expect(state.setEnabled(context, { id: 'progress-narration', enabled: true })).rejects.toThrow('no composition owner')
    state.setComposer(overrides => [...patches, ...overrides])
    expect((await state.setEnabled(context, { id: 'progress-narration', enabled: true })).plugin.enabled).toBe(true)
    expect(reconcile).not.toHaveBeenCalled()
    writeFileSync(state.documentPath, '{"version":1,"disabled":["progress-narration"]}', { mode: 0o600 })
    const disabledState = new HostedPluginState(home, patches)
    disabledState.setComposer(overrides => [...patches, ...overrides])
    expect((await disabledState.setEnabled(context, { id: 'progress-narration', enabled: false })).plugin.id).toBe('progress-narration')
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('reports missing selected rows at both return points', async () => {
    const { home, patches, context, entries } = fixture()
    const state = new HostedPluginState(home, patches)
    state.setComposer(overrides => [...patches, ...overrides])
    const list = state.list.bind(state)
    const firstListSpy = vi.spyOn(state, 'list')
      .mockImplementation(ctx => ({ plugins: list(ctx).plugins.filter(row => row.id !== 'progress-narration') }))
    await expect(state.setEnabled(context, { id: 'progress-narration', enabled: true })).rejects.toThrow('disappeared')
    firstListSpy.mockRestore()
    reconcile.mockImplementation(async () => { entries[1]!.disabled = true; return [] })
    const originalList = state.list.bind(state)
    vi.spyOn(state, 'list').mockImplementationOnce(originalList)
      .mockImplementation(ctx => ({ plugins: originalList(ctx).plugins.filter(row => row.id !== 'progress-narration') }))
    await expect(state.setEnabled(context, { id: 'progress-narration', enabled: false })).rejects.toThrow('disappeared')
  })

  it('persists multiple approved selections in stable ID order', async () => {
    const { home, patches, context, entries } = fixture()
    const approved = ['zeta', 'alpha'].map(id => ({ id, name: `@rulabs/${id}`, version: '1.0.0', sha256: 'a'.repeat(64) }))
    patches.push({ insert: approved.map(plugin => ({ id: plugin.id, name: plugin.name, disabled: true })) })
    entries.push(...approved.map(plugin => ({ options: { id: plugin.id }, disabled: true })))
    const state = new HostedPluginState(home, patches, approved)
    state.setComposer(overrides => [...patches, ...overrides])
    reconcile.mockImplementation(async (_ctx, candidate) => {
      for (const entry of entries.slice(-2)) {
        entry.disabled = candidate.filter(patch => patch.id === entry.options.id).at(-1)?.disabled ?? true
      }
      return []
    })
    await state.setEnabled(context, { id: 'zeta', enabled: true })
    await state.setEnabled(context, { id: 'alpha', enabled: true })
    const saved: unknown = JSON.parse(readFileSync(state.documentPath, 'utf8'))
    expect((saved as { enabledApproved: Array<{ id: string }> }).enabledApproved.map(row => row.id))
      .toEqual(['alpha', 'zeta'])
  })

  it('rolls back when Loader reports the wrong state and surfaces rollback failure', async () => {
    const { home, patches, context } = fixture()
    const state = new HostedPluginState(home, patches)
    state.setComposer(overrides => [...patches, ...overrides])
    reconcile.mockRejectedValueOnce(new Error('change failed')).mockRejectedValueOnce(new Error('rollback failed'))
    await expect(state.setEnabled(context, { id: 'progress-narration', enabled: false }))
      .rejects.toThrow('Hosted plugin change and rollback failed')
    expect(existsSync(state.documentPath)).toBe(false)
    reconcile.mockResolvedValue([])
    await expect(state.setEnabled(context, { id: 'progress-narration', enabled: false }))
      .rejects.toThrow('did not reach the requested state')
    expect(state.overrides()).toEqual([])
  })

  it('rejects directory state and exposes the signed rows through the Remote facade', async () => {
    const { home, patches, context } = fixture()
    const state = new HostedPluginState(home, patches)
    Object.defineProperty(context, 'hostedPluginState', { value: state })
    const remote = new HostedPluginControls(context)
    expect((await remote.list()).plugins).toHaveLength(3)
    state.setComposer(overrides => [...patches, ...overrides])
    expect((await remote.setEnabled({ id: 'progress-narration', enabled: true })).plugin.enabled).toBe(true)
    mkdirSync(state.documentPath)
    expect(() => new HostedPluginState(home, patches)).toThrow('owner-only regular file')
  })

  it('detects a changed file between metadata and owner-only read', () => {
    const { home, patches } = fixture()
    writeFileSync(join(home, 'hosted-plugins.json'), '{"version":1,"disabled":[]}', { mode: 0o600 })
    changedOpenedFile.value = true
    expect(() => new HostedPluginState(home, patches)).toThrow('changed during owner-only read')
  })

  it('propagates non-missing filesystem errors while reading state', () => {
    const { home, patches } = fixture()
    blockedDiskRead.value = true
    expect(() => new HostedPluginState(home, patches)).toThrow('blocked')
  })

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
