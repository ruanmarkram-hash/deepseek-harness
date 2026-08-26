/**
 * Shared profile boot for every `dsh` surface: resolve the profile, stack its
 * patch layers (bundle layers in `dsh.profile.bundles` order, the profile's
 * own `cordis.patch.yml`, `--patch` overlays, the telemetry switch), mount the
 * tree over the profile's empty root config, keep the profile patch layer
 * live, and wire fail-loud plus bounded shutdown.
 *
 * App flags are not the launcher's business: the invocation's inner arguments
 * are provided to the tree through `ctx.cmdlineArgs`, where any injected app
 * plugin may read the same immutable snapshot.
 * @module @deepseek-ai/dsh/profile-boot
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  installFailLoud,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  resolveBundleDir,
  watchUserPatches,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Shipped agent-preset root: beside this app's own config, in both source and built layouts. */
const SHIPPED_PRESET_ROOT = fileURLToPath(new URL('../config/agent-presets/', import.meta.url))
const HOSTED_ROOT_CONFIG = fileURLToPath(new URL('../config/hosted-root.yml', import.meta.url))

import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import {
  HOSTED_RUNTIME_ARGUMENTS,
  isHostedRuntimeInvocation,
  validateInheritedDescriptors,
} from '@deepseek-ai/dsh-remote-host-fd199'
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts'
import {
  publishWebRuntimeRegistry,
  removeOwnedWebRuntimeRegistry,
  type WebRuntimeRegistryRecord,
} from './web-runtime-registry.ts'

const NAME = 'dsh'

/**
 * The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied
 * over every profile's own layer. Resolved per call, not at module load:
 * `$DSH_HOME` may be set by the test or launcher after import.
 * @returns the absolute patch-file path.
 */
export function homePatchPath(): string {
  return join(resolveDshHome(), PROFILE_PATCH_FILENAME)
}

/** Absolute path of this dsh installation's package.json (both anchors: src/ and lib/ sit one level under apps/cli). */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The session-telemetry row id the DSH_TELEMETRY_DISABLED switch targets. */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'
const HOSTED_PATCH_HASH_ENV = 'DSH_HOSTED_PATCH_SHA256'
const HOSTED_PATCH_RELATIVE_ENV = 'DSH_HOSTED_PATCH_RELATIVE'
const HOSTED_WEB_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const

/**
 * Hosted mode accepts one native-attested compatibility overlay only. Its
 * mutable source file is a data switch, not an executable extension point:
 * expressions, inserted rows, plugin names, and arbitrary config values are
 * rejected before Loader sees them.
 */
export function loadHostedPatchSnapshot(patchFiles: readonly string[], home = resolveDshHome()): PatchOptions[] {
  const relative = process.env[HOSTED_PATCH_RELATIVE_ENV]
  const expectedHash = process.env[HOSTED_PATCH_HASH_ENV]
  if (relative === undefined || expectedHash === undefined
    || !/^[a-f0-9]{64}$/.test(expectedHash)
    || relative.startsWith('/') || relative.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`${NAME}: hosted runtime has no valid signed patch snapshot`)
  }
  const root = resolve(home)
  const expectedPath = resolve(root, relative)
  if (!expectedPath.startsWith(`${root}/`) || patchFiles.length !== 1 || resolve(patchFiles[0] ?? '') !== expectedPath) {
    throw new Error(`${NAME}: hosted runtime rejects an untrusted patch path`)
  }
  let content: string
  try { content = readFileSync(expectedPath, 'utf8') }
  catch { throw new Error(`${NAME}: hosted runtime could not read its signed patch snapshot`) }
  return parseHostedPatchSnapshotBytes(content, expectedHash)
}

/** Parses the one byte snapshot already hashed by {@link loadHostedPatchSnapshot}. */
export function parseHostedPatchSnapshotBytes(content: string, expectedHash: string): PatchOptions[] {
  const actualHash = createHash('sha256').update(content).digest('hex')
  if (actualHash !== expectedHash) throw new Error(`${NAME}: hosted runtime patch snapshot changed`)
  let parsed: unknown
  try { parsed = yaml.load(content, { schema: yaml.JSON_SCHEMA }) }
  catch { throw new Error(`${NAME}: hosted runtime patch snapshot is not safe YAML`) }
  if (!Array.isArray(parsed)) throw new Error(`${NAME}: hosted runtime patch snapshot must be an array`)
  const patches = parsed as PatchOptions[]
  for (const patch of patches) {
    const candidate = patch as Record<string, unknown>
    if (Object.keys(candidate).length !== 2 || typeof candidate.id !== 'string' || candidate.disabled !== true) {
      throw new Error(`${NAME}: hosted runtime patch permits only disabled built-in rows`)
    }
  }
  return patches
}

/** The sealed files and resolver base a hosted child uses, never DSH_HOME. */
export function hostedBootConfiguration(): { rootConfig: string; bareModuleBaseUrl: string } {
  return { rootConfig: HOSTED_ROOT_CONFIG, bareModuleBaseUrl: pathToFileURL(INSTALL_ANCHOR).href }
}

/** Builds a hosted profile solely from package names resolved at the sealed CLI anchor. */
function sealedHostedProfile(): Profile {
  const profileDirectory = dirname(HOSTED_ROOT_CONFIG)
  const layers = HOSTED_WEB_BUNDLES.map((packageName) => {
    const packageDir = resolveBundleDir(NAME, packageName, INSTALL_ANCHOR, profileDirectory)
    const patchPath = join(packageDir, 'cordis.patch.yml')
    return { packageName, packageDir, patchPath, patches: loadOverlayPatches(NAME, patchPath) }
  })
  return { name: 'web', dir: profileDirectory, layers, patchPath: HOSTED_ROOT_CONFIG, patches: [] }
}

/** The empty root entry list every profile tree patches over. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** Root config filename inside a profile directory. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without the telemetry row
 * exports nothing, so the switch is then trivially satisfied and no patch is
 * generated — custom profiles need not mount telemetry to run with the
 * switch set.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/**
 * Load a resolved profile for `name`: heal the shared module fallback, then
 * (re)write the empty root config. The root is always rewritten: the whole
 * composition is patch layers, and the vendored Loader's tree write-back (a
 * plugin self-disposing persists the current tree) can bake composed rows
 * into this file — which would duplicate every bundle insert on the next
 * boot. The file exists on disk only because the Loader needs a real include
 * root to anchor `baseUrl` at the profile directory (the config dump anchors
 * on the same file, so both compose over the identical base).
 * @param name - the profile name.
 * @param userLayer - `false` skips parsing `cordis.patch.yml` (the default dump).
 * @returns the loaded profile.
 */
export function prepareProfile(name: string, userLayer = true): Profile {
  healProfilesModuleFallback(INSTALL_ANCHOR)
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, { userLayer })
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return profile
}

/** One profile's patch layers (application order) and the row index of its pre-flag composition. */
interface ComposedProfile {
  profile: Profile
  /** Bundle layers concatenated — the part below the user layers on a live reload. */
  bundlePatches: PatchOptions[]
  /** The home-level user layer (`$DSH_HOME/cordis.patch.yml`), applied after the profile's own. */
  homePatches: PatchOptions[]
  /** Layers above the user layers on a live reload: `--patch` overlays and the telemetry switch. */
  overlays: PatchOptions[]
  /**
   * id → row of the composed tree (bundles + user layers + overlays), for the
   * launcher's own row checks.
   */
  rows: ReadonlyMap<string, EntryOptions>
}

/** The full patch stack of one composed profile, in application order. */
function allPatches(composed: ComposedProfile): PatchOptions[] {
  return [
    ...composed.bundlePatches,
    ...composed.profile.patches,
    ...composed.homePatches,
    ...composed.overlays,
  ]
}

/**
 * Load `name` and compose its effective patch stack: bundle layers in
 * `dsh.profile.bundles` order (the base bundle gates the shell stacks by
 * platform on its own rows), the profile's user layer, the home-level user
 * layer (`$DSH_HOME/cordis.patch.yml` — machine-local preferences that apply
 * to every profile, so it outranks the per-profile layer), `--patch` overlays,
 * then the telemetry switch.
 * @param name - the profile name.
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @returns the profile, its patch layers, and the composed row index.
 */
function composeProfile(
  name: string,
  patchFiles: readonly string[],
  hostedRuntime = false,
): ComposedProfile {
  const profile = hostedRuntime ? sealedHostedProfile() : prepareProfile(name)
  const homePatches = hostedRuntime ? [] : loadOptionalPatches(NAME, homePatchPath()) ?? []
  const overlays = hostedRuntime ? loadHostedPatchSnapshot(patchFiles) : patchFiles.flatMap(file => loadOverlayPatches(NAME, resolve(file)))
  const bundlePatches = profile.layers.flatMap(layer => layer.patches)
  const rows = new Map<string, EntryOptions>()
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlays])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const composedOverlays = [...overlays]
  // The SHIPPED root is the part of the roster only this app can resolve: it
  // sits beside this app's own config, in both the source and built layouts.
  // The writable root the roster appends is `dsh-agent-presets`' own, so a
  // launcher that never reaches this patch still finds a person's presets.
  if (rows.has('agent-presets')) {
    composedOverlays.push({
      id: 'agent-presets',
      config: {
        ...(rows.get('agent-presets')?.config ?? {}) as Record<string, unknown>,
        roots: [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }],
      },
    })
  }
  const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) composedOverlays.push(telemetryPatch)
  return { profile, bundlePatches, homePatches, overlays: composedOverlays, rows }
}

/**
 * The signed-Host hosted-runtime overlay: enables the V3 route composition
 * without a pinned Host-app path (the FD199 authority announces the attested
 * path) and mounts the FD199 startup plugin that owns the handoff lifecycle.
 * An ordinary invocation never receives these patches.
 * @param rows - The pre-flag composed row index.
 * @returns the launcher-owned hosted patches, or `undefined` off the Web profile.
 */
function hostedRuntimeOverlay(rows: ReadonlyMap<string, EntryOptions>): readonly PatchOptions[] | undefined {
  const routeRow = rows.get('remote-host-v3')
  const routeConfig = (routeRow?.config ?? {}) as Record<string, unknown>
  return [{
    // No `id` here: an id alongside `insert` names a target GROUP to insert
    // into, and a nonexistent group silently drops the whole patch.
    insert: [
      { id: 'remote-host-fd199', name: '@deepseek-ai/dsh-remote-host-fd199' },
      { id: 'remote-host-fd199-web-owner', name: '@deepseek-ai/dsh-remote-host-fd199/web-owner' },
    ],
  }, {
    // Restates every key the row owns: a patch replaces the whole config.
    id: 'remote-host-v3',
    name: '@deepseek-ai/dsh-remote-host-v3',
    config: { ...routeConfig, enabled: true, hostAppPath: '' },
  }]
}

/** Options for {@link runProfile}. */
export interface RunProfileOptions {
  /** This run's frozen environment snapshot, provided before any entry mounts. */
  environment: LaunchEnvironmentSnapshot
  /** The profile name to boot. */
  profile: string
  /** `--patch` overlay paths, in argv order. */
  patchFiles: readonly string[]
  /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`. */
  args: readonly string[]
}

/** The only Web-server facts the launcher needs after a Web profile binds. */
interface BoundWebServer {
  host: unknown
  port: unknown
}

/** Return the canonical loopback URL only for a fully bound Web server. */
function loopbackWebUrl(ctx: Context): string | undefined {
  const server = ctx.get('webServer') as BoundWebServer | undefined
  if (server?.host !== '127.0.0.1'
    || typeof server.port !== 'number'
    || !Number.isInteger(server.port)
    || server.port < 1
    || server.port > 65_535) return undefined
  return `http://127.0.0.1:${String(server.port)}`
}

/** Registry operations owned by the Web profile's post-bind lifecycle. */
export interface WebRuntimeRegistryLifecycle {
  /** Atomically publish one bound loopback URL. */
  publish(url: string): Promise<WebRuntimeRegistryRecord>
  /** Remove the record only if it still belongs to its publisher. */
  remove(owner: WebRuntimeRegistryRecord): Promise<boolean>
}

const webRuntimeRegistryLifecycle: WebRuntimeRegistryLifecycle = {
  publish: async url => publishWebRuntimeRegistry({ url }),
  remove: removeOwnedWebRuntimeRegistry,
}

/**
 * Publish a bound Web runtime and attach its owner-checked removal to the
 * root context. Disposal that wins while publication is pending removes the
 * just-published record instead of leaving stale discovery behind.
 * @param ctx - active profile root that owns runtime lifetime.
 * @param url - canonical loopback URL of the bound Web server.
 * @param registry - publisher and remover, replaceable by lifecycle tests.
 */
export async function publishBoundWebRuntimeRegistry(
  ctx: Context,
  url: string,
  registry: WebRuntimeRegistryLifecycle = webRuntimeRegistryLifecycle,
): Promise<boolean> {
  let owner: WebRuntimeRegistryRecord | undefined
  const removeOwner = async (): Promise<void> => {
    if (owner === undefined) return
    try {
      await registry.remove(owner)
    } catch (error) {
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    }
  }
  try {
    owner = await registry.publish(url)
    if (ctx.fiber.state !== FiberState.ACTIVE) {
      await removeOwner()
      return false
    }
    ctx.effect(
      () => async () => { await removeOwner() },
      'dsh.webRuntimeRegistry',
    )
    return true
  } catch (error) {
    await removeOwner()
    ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    return false
  }
}

/**
 * Re-throw a watcher-setup failure unless a shutdown already owns the tree:
 * a signal aborted this invocation, or an app requested exit (`ctx.appExit`
 * from a fast one-shot) and the root's disposal rejected the in-flight setup
 * await. Either way the failure describes a tree that is exiting as asked,
 * not a broken watch.
 * @param ctx - the booted root context.
 * @param signal - this invocation's signal-shutdown fact.
 * @param error - the setup failure.
 */
function suppressShutdownError(ctx: Context, signal: AbortSignal, error: unknown): void {
  if (signal.aborted) return
  if (ctx.fiber.state !== FiberState.ACTIVE || ctx.get('loader') === undefined) return
  throw error
}

/**
 * Boot one profile invocation end to end and leave process lifetime to the
 * mounted plugins (or to a one-shot runner the composition mounts).
 * @param options - environment snapshot, profile name, overlays, and the booted app's own arguments.
 * @returns the settled root context and the shutdown controller.
 */
export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  // The hosted runtime contract is validated before any boot effect: both
  // private descriptors must already be inherited sockets, or the launch
  // fails loud with no mounted tree.
  const hostedRuntime = options.profile === 'web' && isHostedRuntimeInvocation(options.args)
  if (hostedRuntime) validateInheritedDescriptors()
  const composed = composeProfile(options.profile, options.patchFiles, hostedRuntime)
  const hostedOverlay = hostedRuntime ? hostedRuntimeOverlay(composed.rows) : undefined
  const bootPatches = hostedOverlay === undefined ? allPatches(composed) : [...allPatches(composed), ...hostedOverlay]
  const app: { current?: Context } = {}
  const shutdown = createProcessShutdown(async () => { await app.current?.fiber.dispose() })
  const signalShutdown = new AbortController()
  const interrupt = (code: number): void => {
    signalShutdown.abort()
    shutdown.interrupt(code)
  }
  // Signals own teardown throughout the startup window, not only after boot()
  // settles: an inserted provider can publish before sibling rows finish mounting.
  // SIGTERM is a supervisor's ordinary stop request and exits 0 on every
  // surface — the launcher does not know whether the app considered its work
  // complete; SIGINT is a user interrupt and reports 130.
  process.on('SIGTERM', () => { interrupt(0) })
  process.on('SIGINT', () => { interrupt(130) })
  installFailLoud(NAME, process, async () => {
    await app.current?.fiber.dispose()
  })

  const hostedBoot = hostedRuntime ? hostedBootConfiguration() : undefined
  const rootConfig = hostedBoot?.rootConfig ?? join(composed.profile.dir, PROFILE_ROOT_FILENAME)
  // Recomposition for the live user layers: bundle layers below, overlays
  // above, so a user edit can never displace them. Parsed app arguments are
  // not in here at all — they live in app-provided services that survive a
  // recomposition. BOTH
  // user files are re-read per generation (the HMR watcher hands us only the
  // changed file's patches, which one of the reads duplicates — fresh reads
  // keep the two watchers from stitching in each other's stale copy).
  // Fresh clones per generation: the include pushes `insert` rows into the
  // mounted tree BY REFERENCE and later id-targeted patches mutate those
  // objects in place. Reusing one parsed patch object across applications
  // would bake a user override into the bundle's in-memory insert row, so
  // removing the override could never revert the row to the bundle default.
  const composeLive = (): PatchOptions[] => structuredClone([
    ...composed.bundlePatches,
    ...(hostedRuntime ? [] : loadOptionalPatches(NAME, composed.profile.patchPath) ?? []),
    ...(hostedRuntime ? [] : loadOptionalPatches(NAME, homePatchPath()) ?? []),
    ...composed.overlays,
    ...(hostedOverlay === undefined ? [] : hostedOverlay),
  ])
  // The hosted suffix is launcher protocol, not an app flag: the tree sees
  // the same inner arguments an ordinary invocation would.
  const innerArguments = hostedRuntime
    ? options.args.slice(0, options.args.length - HOSTED_RUNTIME_ARGUMENTS.length)
    : options.args
  // Cloned for the same insert-aliasing reason as composeLive: the boot
  // application must not mutate the objects later reloads recompose from.
  const ctx = await boot(NAME, rootConfig, structuredClone(bootPatches), (hostCtx) => {
    app.current = hostCtx
    // Before any config-tree entry mounts, so plugins resolve all launch-time
    // environment values from the same immutable provenance snapshot.
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
    // The command line and bounded exit request are launcher facts available
    // to every app plugin that injects the argument snapshot.
    provideCmdline(hostCtx, {
      args: innerArguments,
      // Callers that transfer durable ownership await this exact root-disposal
      // barrier.  The shutdown controller retains its bounded escalation;
      // ordinary callers may still intentionally ignore the returned promise.
      exit: code => shutdown.shutdown(code),
    })
  }, hostedBoot?.bareModuleBaseUrl)
  app.current = ctx
  let didPublishHostedRegistry = false
  if (options.profile === 'web') {
    const url = loopbackWebUrl(ctx)
    if (url !== undefined) {
      didPublishHostedRegistry = await publishBoundWebRuntimeRegistry(ctx, url)
    }
  }
  if (hostedRuntime) {
    const desktopReady = ctx.get('fd199DesktopReady') as { signal?: () => Promise<void> } | undefined
    if (desktopReady?.signal !== undefined) {
      // The native first-generation and activated-restart gates must not
      // admit the Host until this exact loopback registry record exists. A
      // prepared adopter intentionally has no desktop-ready capability: it
      // stays fenced until activation and later reports V3 runtime.ready.
      if (!didPublishHostedRegistry) throw new Error('hosted Web runtime registry was not published')
      await desktopReady.signal()
    }
  }
  // A surface can dispose the whole tree while boot or this post-boot watcher
  // setup is still in flight — a signal, or a fast one-shot's appExit. Loader
  // presence and fiber state own liveness; the initial check skips a tree
  // that already exited, and the catch below re-checks for an exit that
  // landed mid-setup. Watching is unconditional: a one-shot surface exits
  // through its bounded shutdown, which disposes the watchers before the
  // loop drains.
  if (!hostedRuntime && !signalShutdown.signal.aborted
    && ctx.fiber.state === FiberState.ACTIVE
    && ctx.get('loader') !== undefined) {
    try {
      // Config-only HMR for the live profile patch layer: the web bundle
      // disables the shared module-reload `hmr` row (its reload lifecycle is
      // untested), so when the composition leaves no HMR service, mount a
      // watch-only instance with no module roots — cordis.patch.yml edits stay
      // live on every long-lived surface. A silent skip would break the
      // documented hot-reload contract. HMR injects the timer service, which a
      // bare custom profile may not mount either.
      if (ctx.get('hmr') === undefined) {
        if (ctx.get('timer') === undefined) {
          await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-timer' })
        }
        await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } })
      }
      await watchUserPatches(ctx, {
        binName: NAME,
        filename: composed.profile.patchPath,
        compose: composeLive,
      })
      await watchUserPatches(ctx, {
        binName: NAME,
        filename: homePatchPath(),
        compose: composeLive,
      })
    } catch (error) {
      suppressShutdownError(ctx, signalShutdown.signal, error)
    }
  }
  return { ctx, shutdown }
}
