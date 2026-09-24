/** Phone presentation of the signed Host's sanitized plugin catalog. */
import type { MobileRemoteClient } from './remote.ts'

/** The fields the Host permits an enrolled phone to inspect or change. */
export interface MobilePlugin {
  readonly id: string
  readonly name: string
  readonly source: 'bundled' | 'downloaded'
  readonly enabled: boolean
  readonly required: boolean
  readonly reason?: string
}

type PluginRequester = Pick<MobileRemoteClient, 'request'>['request']

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function plugin(value: unknown): MobilePlugin | undefined {
  if (!record(value) || Object.keys(value).some(key => !['id', 'name', 'source', 'enabled', 'required', 'reason'].includes(key))) return undefined
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 256
    || typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 256
    || (value.source !== 'bundled' && value.source !== 'downloaded')
    || typeof value.enabled !== 'boolean' || typeof value.required !== 'boolean'
    || (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 512))) return undefined
  return { id: value.id, name: value.name, source: value.source, enabled: value.enabled,
    required: value.required, ...(value.reason === undefined ? {} : { reason: value.reason }) }
}

function valueOrThrow(result: Awaited<ReturnType<PluginRequester>>): unknown {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Read the current Host catalog. Malformed remote data never becomes a switch. */
export async function loadMobilePlugins(request: PluginRequester): Promise<MobilePlugin[]> {
  const value = valueOrThrow(await request('plugins.list', {}))
  if (!record(value) || Object.keys(value).length !== 1 || !Array.isArray(value.plugins) || value.plugins.length > 1024) throw new Error('The Host returned an invalid plugin list.')
  const rows: MobilePlugin[] = []
  for (const item of value.plugins) {
    const parsed = plugin(item)
    if (parsed === undefined) throw new Error('The Host returned an invalid plugin list.')
    rows.push(parsed)
  }
  return rows
}

/** Re-read Host state after any earlier toggle settles, even when that toggle was refused. */
export async function loadMobilePluginsAfterToggle(
  request: PluginRequester,
  pending: Promise<MobilePlugin> | undefined,
): Promise<MobilePlugin[]> {
  if (pending !== undefined) {
    try { await pending } catch (_error) { /* The toggle caller reports its own failure; a fresh read still runs. */ }
  }
  return loadMobilePlugins(request)
}

/** Request one optional plugin change, accepting only the Host's committed row. */
export async function setMobilePluginEnabled(request: PluginRequester, current: MobilePlugin, enabled: boolean): Promise<MobilePlugin> {
  if (current.required) throw new Error(current.reason ?? 'This plugin is required by the Host.')
  const value = valueOrThrow(await request('plugins.setEnabled', { id: current.id, enabled }))
  const next = record(value) && Object.keys(value).length === 1 ? plugin(value.plugin) : undefined
  if (next === undefined || next.id !== current.id || next.enabled !== enabled) throw new Error('The Host returned an invalid plugin update.')
  return next
}
