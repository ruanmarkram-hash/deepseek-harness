import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { boot, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { HostedSettings, parseHostedSettings } from '../src/hosted-settings.ts'

function home(): string {
  const directory = mkdtempSync(join(tmpdir(), 'hosted-settings-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  return directory
}

const patches: PatchOptions[] = [{ insert: [
  { id: 'agent-default-model', name: 'cordis:model', config: { provider: 'test', model: 'original' } },
  { id: 'permission', name: 'cordis:permission', config: { defaultPreset: 'ask' } },
  { id: 'progress-narration', name: 'cordis:progress' },
] }]

async function start(directory: string, additionalPatches: () => PatchOptions[] = () => []) {
  const root = join(directory, 'sealed.yml')
  writeFileSync(root, '[]\n')
  const owner = new HostedSettings(directory, patches, additionalPatches)
  const ctx = await boot('hosted-test', root, owner.patches(), async (ctx) => {
    const profile: ProfileContext = {
      name: 'web', home: directory, dir: directory, patchPath: root,
      installAnchor: join(directory, 'package.json'), startedBundles: [], overlays: [], cwd: directory, telemetryDisabledEnv: undefined,
    }
    ctx.provide('profileContext', profile)
    ctx.loader.builtins.model = {
      Config: z.object({ provider: z.string().required().volatile(), model: z.string().required().volatile() }),
      apply: () => {},
    }
    ctx.loader.builtins.permission = {
      Config: z.object({ defaultPreset: z.union(['ask', 'read-only']).default('ask').volatile() }),
      apply: () => {},
    }
    ctx.loader.builtins.progress = { apply: () => {} }
    await owner.install(ctx)
  })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await owner.commitValidated(ctx)
  return { ctx, owner }
}

describe('signed Host data-only settings', () => {
  it('keeps Host plugin switches while saving settings in the same Include composition', async () => {
    const directory = home()
    const { ctx } = await start(directory, () => [{ id: 'progress-narration', disabled: true }])
    expect([...ctx.loader.entries()].find(row => row.options.id === 'progress-narration')?.disabled).toBe(true)
    await ctx.settings.update('agent-default-model', { model: 'next-model' })
    expect([...ctx.loader.entries()].find(row => row.options.id === 'progress-narration')?.disabled).toBe(true)
  })

  it('preserves legacy model and permission data, supports edits, and restores without reading home patches', async () => {
    const directory = home()
    const legacy = 'agent-default-model:\n  provider: local\n  model: prior-model\npermission:\n  defaultPreset: read-only\n'
    writeFileSync(join(directory, 'settings.yaml'), legacy)
    writeFileSync(join(directory, 'cordis.patch.yml'), '- insert:\n  - name: /untrusted/executable.mjs\n')
    const { ctx } = await start(directory)
    expect(ctx.settings.describe().find(row => row.ns === 'agent-default-model')?.value).toEqual({ provider: 'local', model: 'prior-model' })
    expect(ctx.settings.describe().find(row => row.ns === 'permission')?.value).toEqual({ defaultPreset: 'read-only' })
    expect(readFileSync(join(directory, 'settings.yaml'), 'utf8')).toBe(legacy)
    expect(existsSync(join(directory, 'settings.yaml.imported'))).toBe(false)
    await ctx.settings.update('agent-default-model', { model: 'next-model' })
    await ctx.fiber.dispose()
    const restored = await start(directory)
    expect(restored.ctx.settings.describe().find(row => row.ns === 'agent-default-model')?.value).toEqual({ provider: 'local', model: 'next-model' })
    expect(readFileSync(join(directory, 'sealed.yml'), 'utf8')).toBe('[]\n')
  })

  it('does not persist an invalid legacy configuration or weaken permission on failure', async () => {
    const directory = home()
    const legacy = 'permission:\n  defaultPreset: bypass-everything\n'
    writeFileSync(join(directory, 'settings.yaml'), legacy)
    await expect(start(directory)).rejects.toThrow()
    expect(existsSync(join(directory, 'hosted-settings.json'))).toBe(false)
    expect(readFileSync(join(directory, 'settings.yaml'), 'utf8')).toBe(legacy)
  })

  it.each([
    'llm-pi-ai:\n  providers:\n    bad:\n      __jsExpr: process.exit()\n',
    'llm-pi-ai:\n  providers: !!js process.exit()\n',
    'plugin-manager:\n  root: /mutable\n',
    'agent-default-model:\n  name: /mutable/plugin.mjs\n',
    '{"llm-pi-ai":{"providers":{"__proto__":{}}}}',
  ])('rejects executable or unapproved settings data: %s', (content) => {
    expect(() => parseHostedSettings(content)).toThrow()
  })

  it('rejects invalid live changes and external-file races without overwriting saved data', async () => {
    const directory = home()
    const { ctx, owner } = await start(directory)
    const previous = readFileSync(owner.documentPath, 'utf8')
    await expect(ctx.settings.update('permission', { defaultPreset: 'bypass-everything' })).rejects.toThrow()
    expect(readFileSync(owner.documentPath, 'utf8')).toBe(previous)
    const external = '{"permission":{"defaultPreset":"read-only"}}\n'
    writeFileSync(owner.documentPath, external)
    await expect(ctx.settings.update('agent-default-model', { model: 'other' })).rejects.toThrow('changed outside')
    expect(readFileSync(owner.documentPath, 'utf8')).toBe(external)
  })

  it('preserves an external write during reconciliation and restores the previous live config', async () => {
    const directory = home()
    const { ctx, owner } = await start(directory)
    const external = '{"agent-default-model":{"provider":"external","model":"external-model"}}\n'
    let wrote = false
    ctx.on('app-boot/config-reload', () => {
      if (wrote) return
      wrote = true
      writeFileSync(owner.documentPath, external)
    })
    await expect(ctx.settings.update('agent-default-model', { model: 'concurrent-model' })).rejects.toThrow('changed outside')
    expect(wrote).toBe(true)
    expect(readFileSync(owner.documentPath, 'utf8')).toBe(external)
    expect(ctx.settings.describe().find(row => row.ns === 'agent-default-model')?.value)
      .toEqual({ provider: 'test', model: 'original' })
  })
})
