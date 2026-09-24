import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

const reconcile = vi.hoisted(() => vi.fn())
vi.mock('@deepseek-ai/dsh-app-boot', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-app-boot')>(),
  reconcileProfilePatches: reconcile,
}))

import { PluginPackages } from '@deepseek-ai/dsh-app-boot'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { FaceModelEmitter, WorkspaceAnalyzer } from '@deepseek-ai/dsh-typert-generator'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import HostedPluginControls, { HostedPluginState } from '@deepseek-ai/dsh-hosted-plugin-controls'
import type { PluginEnablementResult, PluginList } from '@deepseek-ai/dsh-hosted-plugin-controls/types'
import { hostedBootConfiguration, hostedProfilePatches, hostedRuntimeResolution, sealedHostedProfile } from '../src/profile-boot.ts'

let ctx: Context | undefined
let home: string | undefined
let generatedRoot: string | undefined

afterEach(async () => {
  reconcile.mockReset()
  await ctx?.fiber.dispose()
  ctx = undefined
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined
  if (generatedRoot !== undefined) rmSync(generatedRoot, { recursive: true, force: true })
  generatedRoot = undefined
})

it('lists and switches sealed Host rows through the generated Typert namespace', { timeout: 60_000 }, async () => {
  home = mkdtempSync(join(tmpdir(), 'dsh-hosted-plugin-remote-'))
  const patches = hostedProfilePatches(sealedHostedProfile(), [])
  const state = new HostedPluginState(home, patches)
  state.setComposer(overrides => [...patches, ...overrides])
  const rows = applyEntryPatches([], patches, (message) => { throw new Error(message) })
  ctx = new Context()
  ctx.baseUrl = hostedBootConfiguration().bareModuleBaseUrl
  await ctx.plugin(Loader)
  const entries = rows.map(row => ({ options: row, disabled: row.disabled === true }))
  vi.spyOn(ctx.loader, 'entries').mockImplementation(function* () { yield* entries as Entry[] })
  reconcile.mockImplementation(async (_root: Context, candidate: PatchOptions[]) => {
    const row = entries.find(entry => entry.options.id === 'progress-narration')
    if (row === undefined) throw new Error('progress narration row is absent')
    row.disabled = candidate.some(patch => patch.id === 'progress-narration' && patch.disabled === true)
    return []
  })
  await ctx.plugin(PluginPackages, { resolution: await hostedRuntimeResolution() })
  ctx.provide('hostedPluginState', state)
  await ctx.plugin(HostedPluginControls)
  await ctx.plugin(TypertRegistry)
  const workspaceRoot = resolve(import.meta.dirname, '../../..')
  const analyzed = new WorkspaceAnalyzer({
    root: workspaceRoot,
    faces: ['host'],
    packages: ['@deepseek-ai/dsh-hosted-plugin-controls'],
  }).analyze()
  const host = analyzed.faces.find(face => face.face === 'host')
  if (host === undefined) throw new Error('hosted plugin controls have no analyzed Host face')
  generatedRoot = mkdtempSync(join(workspaceRoot, 'packages/host/hosted-plugin-controls/tests/.generated-'))
  const generatedPath = join(generatedRoot, 'typert.host.mjs')
  writeFileSync(generatedPath, new FaceModelEmitter(host).emit('@deepseek-ai/dsh-hosted-plugin-controls').js)
  const generated = await import(pathToFileURL(generatedPath).href) as { TYPERT: TypertContribution }
  ctx.typert.register(generated.TYPERT)
  await ctx.plugin(TypertGateway)

  const result = await ctx.typertGateway.invoke({ namespace: 'hostPlugins', method: 'list', args: {} }) as PluginList
  expect(result.plugins.find(row => row.id === 'progress-narration'))
    .toMatchObject({ source: 'bundled', required: false, enabled: true })
  expect(result.plugins.find(row => row.id === 'remote-gateway'))
    .toMatchObject({ source: 'bundled', required: true, enabled: true })

  await expect(ctx.typertGateway.invoke({
    namespace: 'hostPlugins', method: 'setEnabled', args: { request: { id: 'remote-gateway', enabled: false } },
  })).rejects.toThrow('required or unknown')
  expect(reconcile).not.toHaveBeenCalled()

  const changed = await ctx.typertGateway.invoke({
    namespace: 'hostPlugins', method: 'setEnabled', args: { request: { id: 'progress-narration', enabled: false } },
  }) as PluginEnablementResult
  expect(changed.plugin).toMatchObject({ id: 'progress-narration', enabled: false, required: false })
  expect(entries.find(entry => entry.options.id === 'progress-narration')?.disabled).toBe(true)
  expect(JSON.parse(readFileSync(state.documentPath, 'utf8'))).toEqual({ version: 1, disabled: ['progress-narration'] })
  expect(new HostedPluginState(home, patches).overrides()).toEqual([{ id: 'progress-narration', disabled: true }])
  const listedAgain = await ctx.typertGateway.invoke({ namespace: 'hostPlugins', method: 'list', args: {} }) as PluginList
  expect(listedAgain.plugins.find(row => row.id === 'progress-narration')?.enabled).toBe(false)
})
