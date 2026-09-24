/** Signed Host plugin controls for exact bundled rows only. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { PluginEnablementRequest, PluginEnablementResult, PluginList, PluginView } from './types.ts'

export type * from './types.ts'

/** Reviewed optional rows in the signed Host. Other rows remain fixed even when disabled. */
const BUNDLED_OPTIONAL_ROWS = new Map([
  ['native-computer-use-policy', '@deepseek-ai/dsh-experimental-computer-use-policy'],
  ['progress-narration', '@deepseek-ai/dsh-progress-narration'],
])
const VERSION = 2

/** One executable package sealed into the Host at build time. */
export interface ApprovedHostedPlugin {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly sha256: string
}

interface Document {
  readonly version: 1 | 2
  readonly disabled: readonly string[]
  readonly enabledApproved: readonly { readonly id: string; readonly sha256: string }[]
}

function parseDocument(bytes: string): Document {
  let parsed: unknown
  try { parsed = JSON.parse(bytes) }
  catch { throw new Error('Hosted plugin controls contain invalid JSON') }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
    || !Object.hasOwn(parsed, 'version') || !Object.hasOwn(parsed, 'disabled')) {
    throw new Error('Hosted plugin controls contain unapproved fields')
  }
  const record = parsed as { version?: unknown; disabled?: unknown; enabledApproved?: unknown }
  if (record.version !== 1 && record.version !== VERSION) throw new Error('Hosted plugin controls have an unsupported version')
  if (Object.keys(record).length !== (record.version === 1 ? 2 : 3)
    || (record.version === VERSION && !Object.hasOwn(record, 'enabledApproved'))
    || !Array.isArray(record.disabled)
    || record.disabled.some(id => typeof id !== 'string' || !BUNDLED_OPTIONAL_ROWS.has(id))
    || new Set(record.disabled).size !== record.disabled.length) {
    throw new Error('Hosted plugin controls contain an unapproved plugin selection')
  }
  if (record.version === 1) return { version: 1, disabled: record.disabled, enabledApproved: [] }
  if (!Array.isArray(record.enabledApproved)
    || record.enabledApproved.some(row => typeof row !== 'object' || row === null || Array.isArray(row)
      || Object.keys(row).length !== 2 || typeof row.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.id)
      || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256))
    || new Set(record.enabledApproved.map(row => row.id)).size !== record.enabledApproved.length) {
    throw new Error('Hosted plugin controls contain an unapproved plugin selection')
  }
  return { version: VERSION, disabled: record.disabled, enabledApproved: record.enabledApproved }
}

/** Persistent desired state for reviewed bundled Host rows. */
export class HostedPluginState {
  readonly documentPath: string
  readonly compositionLockPath: string
  private diskBytes: string | undefined
  private disabled: Set<string>
  private readonly rows: ReadonlyMap<string, string>
  private readonly approved: ReadonlyMap<string, ApprovedHostedPlugin>
  private compose: ((overrides: PatchOptions[]) => PatchOptions[]) | undefined

  /**
   * Load owner-only data and validate every selectable ID against the sealed bundle.
   * @param home - signed Host data directory.
   * @param sealedPatches - fixed bundle and native Host composition.
   * @param approvedPlugins - executable packages sealed into this signed Host build.
   */
  constructor(home: string, sealedPatches: readonly PatchOptions[], approvedPlugins: readonly ApprovedHostedPlugin[] = []) {
    this.documentPath = join(home, 'hosted-plugins.json')
    this.compositionLockPath = join(home, 'hosted-composition.json')
    const approved = new Map<string, ApprovedHostedPlugin>()
    for (const plugin of approvedPlugins) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(plugin.id)
        || typeof plugin.name !== 'string' || plugin.name.length === 0
        || typeof plugin.version !== 'string' || plugin.version.length === 0
        || !/^[a-f0-9]{64}$/.test(plugin.sha256)
        || BUNDLED_OPTIONAL_ROWS.has(plugin.id) || approved.has(plugin.id)) {
        throw new Error('Hosted plugin controls received an invalid signed approval')
      }
      approved.set(plugin.id, plugin)
    }
    this.approved = approved
    this.diskBytes = this.readDisk()
    const document = this.diskBytes === undefined ? undefined : parseDocument(this.diskBytes)
    this.disabled = new Set(document?.disabled ?? [])
    for (const plugin of approved.values()) {
      if (!document?.enabledApproved.some(row => row.id === plugin.id && row.sha256 === plugin.sha256)) {
        this.disabled.add(plugin.id)
      }
    }
    const rows = composeEntries([structuredClone([...sealedPatches])])
    this.rows = new Map(rows.flatMap(row => typeof row.id === 'string' && typeof row.name === 'string'
      ? [[row.id, row.name] as const] : []))
    for (const [id, name] of BUNDLED_OPTIONAL_ROWS) {
      const rowsForId = rows.filter(row => row.id === id)
      const selected = rowsForId[0]
      if (rowsForId.length !== 1 || selected === undefined || selected.name !== name || selected.disabled === true) {
        throw new Error(`Hosted plugin controls require one enabled signed row ${id}`)
      }
    }
    for (const plugin of approved.values()) {
      const rowsForId = rows.filter(row => row.id === plugin.id)
      if (rowsForId.length !== 1 || rowsForId[0]?.name !== plugin.name || rowsForId[0].disabled !== true) {
        throw new Error(`Hosted plugin controls require one disabled signed approval row ${plugin.id}`)
      }
    }
  }

  /** Connect plugin edits to the shared settings composition after both owners exist. */
  setComposer(compose: (overrides: PatchOptions[]) => PatchOptions[]): void {
    this.compose = compose
  }

  /** Data-only overrides over the native-attested snapshot. */
  overrides(disabled: ReadonlySet<string> = this.disabled): PatchOptions[] {
    return [...disabled].sort().map(id => ({ id, disabled: true }))
  }

  /** Read signed rows, including fixed required rows and current enablement. */
  list(ctx: Context): PluginList {
    this.assertDiskUnchanged()
    const live = new Map([...ctx.loader.entries()].map(entry => [entry.options.id, !entry.disabled]))
    return { plugins: [...this.rows].map(([id, name]): PluginView => {
      if (!live.has(id)) throw new Error(`Hosted plugin ${id} is absent from the signed composition`)
      const required = !BUNDLED_OPTIONAL_ROWS.has(id) && !this.approved.has(id)
      return {
        id, name, source: this.approved.has(id) ? 'downloaded' : 'bundled', enabled: live.get(id) === true, required,
        ...required ? { reason: 'This signed Host row is fixed.' } : {},
      }
    }) }
  }

  /**
   * Apply one exact optional row and persist only after Loader reconciliation succeeds.
   * @param ctx - running signed Host context.
   * @param request - signed row ID and desired enablement.
   * @returns the row after its live change and atomic commit.
   */
  async setEnabled(ctx: Context, request: PluginEnablementRequest): Promise<PluginEnablementResult> {
    const value: unknown = request
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).length !== 2 || !('id' in value) || !('enabled' in value)
      || typeof value.id !== 'string' || typeof value.enabled !== 'boolean') {
      throw new Error('Hosted plugin controls require an exact ID and boolean enablement')
    }
    if ((!BUNDLED_OPTIONAL_ROWS.has(request.id) && !this.approved.has(request.id)) || !this.rows.has(request.id)) {
      throw new Error(`Hosted plugin ${request.id} is required or unknown`)
    }
    const compose = this.compose
    if (compose === undefined) throw new Error('Hosted plugin controls have no composition owner')
    return withFileLock(this.compositionLockPath, () => withFileLock(this.documentPath, async () => {
      this.assertDiskUnchanged()
      const previous = this.disabled
      const next = new Set(previous)
      if (request.enabled) next.delete(request.id)
      else next.add(request.id)
      if (next.size === previous.size && [...next].every(id => previous.has(id))) {
        const plugin = this.list(ctx).plugins.find(row => row.id === request.id)
        if (plugin === undefined) throw new Error(`Hosted plugin ${request.id} disappeared`)
        return { plugin }
      }
      try {
        await reconcileProfilePatches(ctx.root, compose(this.overrides(next)), 'dsh', request.enabled ? [request.id] : [])
        const effective = this.list(ctx).plugins.find(row => row.id === request.id)
        if (effective?.enabled !== request.enabled) {
          throw new Error(`Hosted plugin ${request.id} did not reach the requested state`)
        }
        this.assertDiskUnchanged()
        const disabled = [...next].filter(id => BUNDLED_OPTIONAL_ROWS.has(id)).sort()
        const enabledApproved = [...this.approved.values()].filter(plugin => !next.has(plugin.id))
          .map(plugin => ({ id: plugin.id, sha256: plugin.sha256 }))
          .sort((left, right) => left.id.localeCompare(right.id))
        const content = `${JSON.stringify(this.approved.size === 0
          ? { version: 1, disabled }
          : { version: VERSION, disabled, enabledApproved }, null, 2)}\n`
        await writeFileAtomic(this.documentPath, content, { mode: 0o600 })
        this.diskBytes = content
        this.disabled = next
      } catch (error) {
        try { await reconcileProfilePatches(ctx.root, compose(this.overrides(previous)), 'dsh', [request.id]) }
        catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Hosted plugin change and rollback failed')
        }
        throw error
      }
      const plugin = this.list(ctx).plugins.find(row => row.id === request.id)
      if (plugin === undefined) throw new Error(`Hosted plugin ${request.id} disappeared`)
      return { plugin }
    }))
  }

  private readDisk(): string | undefined {
    let stat
    try { stat = lstatSync(this.documentPath) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0
      || (process.getuid !== undefined && stat.uid !== process.getuid())) {
      throw new Error('Hosted plugin controls require an owner-only regular file')
    }
    const fd = openSync(this.documentPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.size > 4096 || opened.ino !== stat.ino || opened.dev !== stat.dev
        || (opened.mode & 0o077) !== 0
        || (process.getuid !== undefined && opened.uid !== process.getuid())) {
        throw new Error('Hosted plugin controls changed during owner-only read')
      }
      return readFileSync(fd, 'utf8')
    } finally { closeSync(fd) }
  }

  private assertDiskUnchanged(): void {
    if (this.readDisk() !== this.diskBytes) {
      throw new Error('Hosted plugin controls changed outside this runtime; restart before editing')
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Signed Host's bounded plugin state, absent from ordinary profiles. */
    hostedPluginState: HostedPluginState
  }
}

/** Trusted Remote exposing the signed Host's plugin catalog and optional switches. */
export class HostedPluginControls extends TypertRemoteService {
  static inject = ['hostedPluginState', 'loader']

  /** @param ctx - signed Host context carrying plugin state. */
  constructor(ctx: Context) { super(ctx, 'hostedPluginControls', { namespace: 'hostPlugins' }) }

  /** @returns current bundled plugin rows, including locked rows. */
  @Remote
  list(): Promise<PluginList> { return Promise.resolve(this.ctx.hostedPluginState.list(this.ctx)) }

  /**
   * Change one reviewed bundled row.
   * @param request - exact signed row ID and boolean desired state.
   * @returns the row after successful live reconciliation and persistence.
   */
  @Remote
  setEnabled(request: PluginEnablementRequest): Promise<PluginEnablementResult> {
    return this.ctx.hostedPluginState.setEnabled(this.ctx, request)
  }
}

export default HostedPluginControls
