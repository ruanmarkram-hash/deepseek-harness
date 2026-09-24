/** Read-only validation of an explicitly supplied legacy settings document. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import type z from '@deepseek-ai/schemastery'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import * as PiAiConfig from '../../../packages/llm/llm-pi-ai/src/config.ts'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import Permission from '@deepseek-ai/dsh-permission-presets'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as General from '@deepseek-ai/dsh-client-ui-settings-general'
import * as Conversation from '@deepseek-ai/dsh-client-ui-conversation'
import * as Theme from '@deepseek-ai/dsh-client-ui-theme'
import { parseHostedSettings } from '../src/hosted-settings.ts'
import { sealedHostedProfile } from '../src/profile-boot.ts'

const filename = process.env.DSH_HOSTED_SETTINGS_VALIDATE
const schemas = new Map<string, z>([
  ['llm-pi-ai', PiAiConfig.Config],
  ['agent-default-model', DefaultModel.Config],
  ['permission', Permission.Config],
  ['agent-loop', AgentLoop.Config],
  ['ui-settings-general', General.Config],
  ['ui-conversation', Conversation.Config],
  ['ui-theme', Theme.Config],
])

it.skipIf(filename === undefined)('validates retained settings against the real upstream schemas without writing state', async () => {
  if (filename === undefined) return
  const sections = parseHostedSettings(readFileSync(filename, 'utf8'))
  const profile = sealedHostedProfile()
  const rows = composeEntries(profile.layers.map(layer => layer.patches))
  for (const [id, data] of Object.entries(sections)) {
    const schema = schemas.get(id)
    const row = rows.find(row => row.id === id)
    if (schema === undefined || row === undefined) throw new Error(`No retained-settings schema for ${id}`)
    // Every supported legacy section overrides top-level scalar fields or the
    // complete provider map. Plugin validation applies defaults within it.
    try {
      const result = await schema['~standard'].validate({ ...row.config, ...data })
      if (result.issues !== undefined) throw new Error('schema validation failed')
    }
    catch { throw new Error(`Retained settings do not satisfy upstream schema: ${id}`) }
  }
  expect(Object.keys(sections).length).toBeGreaterThan(0)
})
