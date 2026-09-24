/** Data-only settings for a signed Host whose executable composition is immutable. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { FiberState, resolveConfig, type Context } from '@deepseek-ai/cordis'
import { interpolate, type Entry } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { ConfigEditorService } from '@deepseek-ai/dsh-config-editor'
import SettingsForms from '@deepseek-ai/dsh-settings'
import * as yaml from 'js-yaml'

type DataSection = Record<string, unknown>
type SettingsDocument = Record<string, DataSection>

/** Only these pre-existing rows admit mutable data in a signed hosted runtime. */
const EDITABLE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'llm-pi-ai': ['providers'],
  'agent-default-model': ['provider', 'model'],
  permission: ['defaultPreset'],
  'ui-settings-general': ['welcomeNoticeVersion'],
  'ui-conversation': ['busyEnter'],
  'ui-theme': ['preference'],
  'agent-loop': ['maxParallelToolCalls'],
}

function object(value: unknown): value is DataSection {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
}

/** Reject Loader expressions, prototype keys and non-JSON values at every depth. */
function assertData(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) { value.forEach(assertData); return }
  if (!object(value)) throw new Error('Hosted settings must contain only JSON data')
  for (const [key, child] of Object.entries(value)) {
    if (['__jsExpr', '__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new Error('Hosted settings cannot contain expressions or prototype keys')
    }
    assertData(child)
  }
}

/** Parse only the reviewed data fields, translating the old onboarding section id. */
export function parseHostedSettings(content: string): SettingsDocument {
  const parsed: unknown = yaml.load(content, { schema: yaml.JSON_SCHEMA })
  if (!object(parsed)) throw new Error('Hosted settings must be a namespace object')
  assertData(parsed)
  const result: SettingsDocument = {}
  for (const [name, value] of Object.entries(parsed)) {
    const id = name === 'ui-onboarding' ? 'ui-settings-general' : name
    const fields = EDITABLE_FIELDS[id]
    if (fields === undefined || !object(value) || Object.keys(value).some(key => !fields.includes(key))) {
      throw new Error(`Hosted settings section ${id} contains unapproved fields`)
    }
    if (Object.hasOwn(result, id)) throw new Error(`Hosted settings section ${id} is duplicated`)
    result[id] = value
  }
  return result
}

function merge(base: DataSection, overlay: DataSection): DataSection {
  const result = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = object(value) && object(result[key]) ? merge(result[key], value) : structuredClone(value)
  }
  return result
}

/** Captured settings bytes and the immutable composition they can configure. */
export class HostedSettings {
  private document: SettingsDocument
  private diskBytes: string | undefined
  readonly documentPath: string
  private readonly baseRows: ReturnType<typeof composeEntries>

  constructor(
    home: string,
    private readonly sealedPatches: readonly PatchOptions[],
    private readonly additionalPatches: () => PatchOptions[] = () => [],
    private readonly compositionLockPath?: string,
  ) {
    this.documentPath = join(home, 'hosted-settings.json')
    this.diskBytes = existsSync(this.documentPath) ? readFileSync(this.documentPath, 'utf8') : undefined
    const legacyPath = join(home, 'settings.yaml')
    const source = this.diskBytes ?? (existsSync(legacyPath) ? readFileSync(legacyPath, 'utf8') : '{}')
    this.document = parseHostedSettings(source)
    this.baseRows = composeEntries([structuredClone([...sealedPatches])])
  }

  /** Complete fixed composition with data-only overrides. */
  patches(document = this.document, additional = this.additionalPatches()): PatchOptions[] {
    return [...structuredClone(this.sealedPatches), ...Object.entries(document).map(([id, data]) => {
      const row = this.baseRows.find(candidate => candidate.id === id)
      if (row === undefined) throw new Error(`Hosted settings has no sealed entry ${id}`)
      return { id, config: merge((row.config ?? {}) as DataSection, data) }
    }), ...structuredClone(additional)]
  }

  /** Provide the constrained editor and stock forms without its destructive legacy import. */
  async install(ctx: Context): Promise<void> {
    const editor: ConfigEditorService = {
      documentPath: this.documentPath,
      entries: (): Entry[] => [...ctx.loader.entries()].filter(entry => entry.parent.tree.ctx.fiber.entry?.id === 'include'),
      configuration: () => editor.entries().map(entry => ({
        entry,
        inherited: structuredClone((this.baseRows.find(row => row.id === entry.options.id)?.config ?? {}) as DataSection),
        override: structuredClone(this.document[entry.options.id] ?? {}),
      })),
      edit: async (entry: Entry, change: (current: DataSection, inherited: DataSection) => DataSection): Promise<void> => {
        const operation = async (): Promise<void> => withFileLock(this.documentPath, async () => {
          const id = entry.options.id
          const fields = EDITABLE_FIELDS[id]
          if (fields === undefined) throw new Error(`Hosted settings entry ${id} is read-only`)
          if (!editor.entries().includes(entry) || entry.fiber?.state !== FiberState.ACTIVE || entry.fiber.runtime === null) {
            throw new Error('Hosted configuration entry is no longer active')
          }
          const base = (this.baseRows.find(row => row.id === id)?.config ?? {}) as DataSection
          const current = (entry.options.config ?? {}) as DataSection
          const next = change(structuredClone(current), structuredClone(base))
          const data: DataSection = {}
          for (const [key, value] of Object.entries(next)) {
            if (fields.includes(key)) data[key] = value
            else if (!isDeepStrictEqual(value, base[key])) throw new Error(`Hosted settings field ${id}.${key} is read-only`)
          }
          const candidate = parseHostedSettings(JSON.stringify({ ...this.document, [id]: data }))
          resolveConfig(entry.fiber.runtime, interpolate(entry.fiber.ctx, next))
          this.assertDiskUnchanged()
          const previous = this.document
          try {
            await reconcileProfilePatches(ctx.root, this.patches(candidate), 'dsh', [id])
            this.assertDiskUnchanged()
            await this.persist(candidate)
            this.document = candidate
          } catch (error) {
            await reconcileProfilePatches(ctx.root, this.patches(previous), 'dsh', [id])
            throw error
          }
        })
        if (this.compositionLockPath === undefined) await operation()
        else await withFileLock(this.compositionLockPath, operation)
      },
    }
    ctx.provide('configEditor', editor)
    await ctx.plugin(SettingsForms, { importLegacyDocument: false })
  }

  /** Commit imported data only after every configured plugin has passed startup validation. */
  async commitValidated(ctx: Context): Promise<void> {
    for (const id of Object.keys(this.document)) {
      const entry = [...ctx.loader.entries()].find(row => row.options.id === id)
      if (entry?.fiber?.state !== FiberState.ACTIVE || entry.fiber.runtime === null) {
        throw new Error(`Hosted settings entry ${id} did not activate`)
      }
      resolveConfig(entry.fiber.runtime, interpolate(entry.fiber.ctx, entry.options.config ?? {}))
    }
    if (this.diskBytes === undefined) {
      await withFileLock(this.documentPath, async () => {
        this.assertDiskUnchanged()
        await this.persist(this.document)
      })
    }
  }

  private assertDiskUnchanged(): void {
    const current = existsSync(this.documentPath) ? readFileSync(this.documentPath, 'utf8') : undefined
    if (current !== this.diskBytes) throw new Error('Hosted settings changed outside this runtime; restart before editing')
  }

  private async persist(document: SettingsDocument): Promise<void> {
    const content = `${JSON.stringify(document, null, 2)}\n`
    await writeFileAtomic(this.documentPath, content, { mode: 0o600 })
    this.diskBytes = content
  }
}
