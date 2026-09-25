/** Bounded client-request and Host-result schemas for plugin controls. */
import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { PluginView } from './plugins.ts'

/** An installed row contains no package path, credentials, or executable manifest. */
export const pluginViewSchema = z.strictObject({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  source: z.enum(['bundled', 'downloaded']),
  enabled: z.boolean(),
  required: z.boolean(),
  reason: z.string().max(512).optional(),
}) satisfies z.ZodType<Wire<PluginView>>

/** plugins.list request. */
export const pluginsListRequestSchema = z.strictObject({}) satisfies z.ZodType<Wire<RequestPayload<'plugins.list'>>>
/** plugins.list response, capped by the remote-wire array bound. */
export const pluginsListValueSchema = z.strictObject({ plugins: z.array(pluginViewSchema).max(1024) }) satisfies z.ZodType<Wire<ResponseValue<'plugins.list'>>>
/** plugins.setEnabled request. */
export const pluginsSetEnabledRequestSchema = z.strictObject({ id: z.string().min(1).max(256), enabled: z.boolean() }) satisfies z.ZodType<Wire<RequestPayload<'plugins.setEnabled'>>>
/** plugins.setEnabled response. */
export const pluginsSetEnabledValueSchema = z.strictObject({ plugin: pluginViewSchema }) satisfies z.ZodType<Wire<ResponseValue<'plugins.setEnabled'>>>
