/** The optional narration row contributes through real YAML Loader composition. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as ProgressNarration from '../src/index.ts'

it('loads narration from cordis.yml and removes it with its entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-narration-loader-'))
  const ctx = new Context()
  try {
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, "- name: '@deepseek-ai/dsh-system-prompt'\n- name: '@deepseek-ai/dsh-progress-narration'\n")
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier === '@deepseek-ai/dsh-system-prompt') return SystemPrompt
        if (specifier === '@deepseek-ai/dsh-progress-narration') return ProgressNarration
        throw new Error(`Unexpected fixture module: ${specifier}`)
      },
      loadCache: new Map(),
      register(): never { throw new Error('Unexpected module hook registration') },
      getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
      resolveSync(): never { throw new Error('Unexpected synchronous resolution') },
      load(): never { throw new Error('Unexpected module load') },
    }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain(ProgressNarration.PROGRESS_NARRATION_POLICY)
    const row = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-progress-narration')
    expect(row?.fiber).toBeDefined()
    await row?.fiber?.dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain(ProgressNarration.PROGRESS_NARRATION_POLICY)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
