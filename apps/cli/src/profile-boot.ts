/**
 * Shared profile boot for every `dsh` surface: resolve the profile, stack its
 * patch layers (bundle layers in `dsh.profile.bundles` order, the profile's
 * own `cordis.patch.yml`, `--patch` overlays, the telemetry switch), mount the
 * tree over the profile's empty root config, and wire fail-loud plus bounded shutdown.
 *
 * App flags are not the launcher's business: the invocation's inner arguments
 * are provided to the tree through `ctx.cmdlineArgs`, where any injected app
 * plugin may read the same immutable snapshot.
 * @module @deepseek-ai/dsh/profile-boot
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  bundlePatchPaths,
  readProfileManifest,
  resolveBundleDir,
  readProfilePatches,
  createRuntimeResolution,
  initProfile,
  installFailLoud,
  loadOverlayPatches,
  loadProfile,
  PluginPackages,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  resolveProfileDir,
  type ProfileContext,
  type Profile,
  type RuntimeResolution,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline, type AppReady } from '@deepseek-ai/dsh-cmdline'
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts'
import { HOSTED_RUNTIME_ARGUMENTS, isHostedRuntimeInvocation, validateInheritedDescriptors } from '@deepseek-ai/dsh-remote-host-fd199'
import {
  publishWebRuntimeRegistry, removeOwnedWebRuntimeRegistry,
  publishWebRuntimeBootstrap, removeOwnedWebRuntimeBootstrap, type WebRuntimeRegistryRecord,
} from './web-runtime-registry.ts'
import type {} from '@deepseek-ai/dsh-client-connection'
import { HostedSettings } from './hosted-settings.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Hosted ownership transfer waits for complete root disposal before another writer starts. */
    fd199HostedExit?: (code: number) => Promise<void>
  }
}

const NAME = 'dsh'
/** Resolve native-only resources only when the signed hosted composition is requested. */
function hostedRootConfig(): string {
  return realpathSync.native(fileURLToPath(new URL('../config/hosted-root.yml', import.meta.url)))
}

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
  const rows: unknown[] = parsed
  const patches: PatchOptions[] = []
  for (const patch of rows) {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new Error(`${NAME}: hosted runtime patch permits only disabled built-in rows`)
    }
    if (Object.keys(patch).length !== 2 || !('id' in patch) || typeof patch.id !== 'string'
      || !('disabled' in patch) || patch.disabled !== true) {
      throw new Error(`${NAME}: hosted runtime patch permits only disabled built-in rows`)
    }
    patches.push({ id: patch.id, disabled: true })
  }
  return patches
}

/** The sealed files and resolver base a hosted child uses, never DSH_HOME. */
export function hostedBootConfiguration(): { rootConfig: string; bareModuleBaseUrl: string } {
  const rootConfig = hostedRootConfig()
  return { rootConfig, bareModuleBaseUrl: pathToFileURL(rootConfig).href }
}

/**
 * Scope the signed root's imports to the installed dependency graph without reading user profile manifests.
 * @returns installation-only package resolution with the canonical sealed config directory as its sole active profile.
 */
export async function hostedRuntimeResolution(): Promise<RuntimeResolution> {
  const installation = await createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, home: dirname(INSTALL_ANCHOR) })
  return Object.freeze({ ...installation, profileDir: dirname(hostedRootConfig()) })
}

/** Builds a hosted profile solely from package names resolved at the sealed CLI anchor. */
export function sealedHostedProfile(): Profile {
  const rootConfig = hostedRootConfig()
  const profileDirectory = dirname(rootConfig)
  const layers = HOSTED_WEB_BUNDLES.map((packageName) => {
    const packageDir = resolveBundleDir(NAME, packageName, INSTALL_ANCHOR, profileDirectory)
    const bundle = readProfileManifest(NAME, packageDir).dsh?.bundle
    if (bundle === undefined) throw new Error(`${NAME}: hosted bundle has no patch declaration`)
    const patchPaths = bundlePatchPaths(packageDir, bundle)
    return { packageName, packageDir, patchPaths, patches: patchPaths.flatMap(path => loadOverlayPatches(NAME, path)) }
  })
  return { name: 'web', dir: profileDirectory, layers, patchPath: rootConfig, patches: [] }
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
  publish(this: void, url: string): Promise<WebRuntimeRegistryRecord>
  /** Remove the record only if it still belongs to its publisher. */
  remove(this: void, owner: WebRuntimeRegistryRecord): Promise<boolean>
  /** Write a private browser-auth bootstrap before advertising readiness. */
  publishBootstrap?(this: void, owner: WebRuntimeRegistryRecord): Promise<void>
  /** Remove the private bootstrap before removing its public owner record. */
  removeBootstrap?(this: void, owner: WebRuntimeRegistryRecord): Promise<boolean>
}

/** Root lifecycle capabilities needed to publish owner-scoped discovery. */
export interface WebRuntimeRegistryOwner {
  readonly fiber: { readonly state: FiberState }
  readonly logger: { warn(error: Error): void }
  effect(setup: () => () => Promise<void>, label: string): unknown
}

const webRuntimeRegistryLifecycle: WebRuntimeRegistryLifecycle = {
  publish: async url => publishWebRuntimeRegistry({ url }),
  remove: removeOwnedWebRuntimeRegistry,
}

/**
 * Ordinary Windows Web publishes noncredential discovery only: POSIX ownership
 * cannot protect a launch capability there. Hosted mode always requires the
 * private bootstrap and fails closed when its filesystem contract is absent.
 * @param registry - complete public and private lifecycle operations.
 * @param hostedRuntime - whether native hosted readiness requires bootstrap.
 * @param platform - operating system owning filesystem permission semantics.
 * @returns the lifecycle supported by this launch mode and platform.
 */
export function webRuntimeRegistryForPlatform(
  registry: WebRuntimeRegistryLifecycle, hostedRuntime: boolean, platform = process.platform,
): WebRuntimeRegistryLifecycle {
  return !hostedRuntime && platform === 'win32'
    ? { publish: registry.publish, remove: registry.remove }
    : registry
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
  ctx: WebRuntimeRegistryOwner,
  url: string,
  registry: WebRuntimeRegistryLifecycle = webRuntimeRegistryLifecycle,
): Promise<boolean> {
  let owner: WebRuntimeRegistryRecord | undefined
  const removeOwner = async (): Promise<void> => {
    if (owner === undefined) return
    try {
      try { await registry.removeBootstrap?.(owner) }
      finally { await registry.remove(owner) }
    } catch (error) {
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    }
  }
  try {
    owner = await registry.publish(url)
    await registry.publishBootstrap?.(owner)
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

/** Launcher-owned readiness signal committed only after boot and host setup succeed. */
function createAppReady(): { service: AppReady; commit(): void } {
  let ready = false
  const listeners = new Set<() => void>()
  return {
    service: {
      onReady(listener) {
        if (ready) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    commit() {
      if (ready) return
      ready = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}

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

/** The empty root entry list every profile tree patches over. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** Root config filename inside a profile directory. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/**
 * Initialize a missing profile from one shipped template. This copies only
 * the template's bundle list; local state from the
 * same-named shipped profile is not read, and no inheritance metadata is
 * persisted. Shipped profile names are reserved, and the target directory is
 * claimed exclusively so existing or concurrent state is never reused.
 * @param name - the new profile name.
 * @param fromDefaultProfile - shipped profile template to copy.
 * @param home - Harness home containing the profile directory.
 * @throws when the template is unknown, the target name is shipped, or the target directory exists.
 */
export function initializeProfileFromDefault(
  name: string,
  fromDefaultProfile: string,
  home: string = resolveDshHome(),
): void {
  const dir = resolveProfileDir(name, home)
  const template = Object.hasOwn(PROFILE_TEMPLATES, fromDefaultProfile)
    ? PROFILE_TEMPLATES[fromDefaultProfile]
    : undefined
  if (template === undefined) {
    const expected = Object.keys(PROFILE_TEMPLATES).sort().map(value => JSON.stringify(value)).join(', ')
    throw new Error(
      `${NAME}: unknown default profile ${JSON.stringify(fromDefaultProfile)}; expected one of ${expected}`,
    )
  }
  if (Object.hasOwn(PROFILE_TEMPLATES, name)) {
    throw new Error(
      `${NAME}: profile ${JSON.stringify(name)} is shipped and cannot be a custom profile target; `
      + 'omit --from-default-profile to use it',
    )
  }
  mkdirSync(dirname(dir), { recursive: true })
  try {
    mkdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      throw new Error(
        `${NAME}: profile ${JSON.stringify(name)} already exists at ${manifestPath}; `
        + 'omit --from-default-profile to use it',
      )
    }
    throw new Error(
      `${NAME}: profile directory ${dir} already exists; choose an unused profile name`,
    )
  }
  try {
    initProfile(dir, template.bundles)
  } catch (error) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${NAME}: profile initialization failed and ${dir} could not be removed`,
      )
    }
    throw error
  }
}
/**
 * Load a resolved profile for `name` and (re)write the empty root config. The
 * root is always rewritten: the whole composition is patch layers, and the
 * vendored Loader's tree write-back (a plugin self-disposing persists the
 * current tree) can bake composed rows into this file — which would duplicate
 * every bundle insert on the next boot. The file exists on disk only because
 * the Loader needs a real include root to anchor `baseUrl` at the profile
 * directory (the config dump anchors on the same file, so both compose over
 * the identical base).
 * @param name - the profile name.
 * @param userLayer - `false` skips parsing `cordis.patch.yml` (the default dump).
 * @param fromDefaultProfile - shipped template used once to initialize a missing profile.
 * @returns the loaded profile.
 * @throws when explicit initialization names an unknown template or an existing profile.
 */
export function prepareProfile(name: string, userLayer = true, fromDefaultProfile?: string): Profile {
  if (fromDefaultProfile !== undefined) initializeProfileFromDefault(name, fromDefaultProfile)
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, { userLayer })
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return profile
}

/** One profile's patch layers, in application order. */
interface ComposedProfile {
  profile: Profile
  /** Immutable runtime resolution computed before any plugin imports. */
  resolution: RuntimeResolution
  /** Command-line overlay contents, frozen for this invocation. */
  overlays: PatchOptions[]
}

/** Fixed native-Host extensions and restrictions applied after the sealed bundle layers. */
export function hostedRuntimeOverlay(): PatchOptions[] {
  return [{
    insert: [
      { id: 'computer-use', name: '@deepseek-ai/dsh-computer-use' },
      { id: 'progress-narration', name: '@deepseek-ai/dsh-progress-narration' },
      { id: 'native-computer-use-policy', name: '@deepseek-ai/dsh-experimental-computer-use-policy' },
      { id: 'remote-devices', name: '@deepseek-ai/dsh-remote-devices' },
      { id: 'remote-api', name: '@deepseek-ai/dsh-remote-api' },
      { id: 'remote-gateway', name: '@deepseek-ai/dsh-remote-gateway', config: { maxIdempotencyEntriesPerDevice: 2048, maxEventEntriesPerDevice: 4096 } },
      { id: 'remote-host-v3', name: '@deepseek-ai/dsh-remote-host-v3', config: { enabled: true, hostAppPath: '' } },
      { id: 'remote-host-fd199', name: '@deepseek-ai/dsh-remote-host-fd199' },
      { id: 'remote-host-fd199-web-owner', name: '@deepseek-ai/dsh-remote-host-fd199/web-owner' },
    ],
  }, ...['plugin-manager', 'tool-plugin-manager', 'hmr', 'config-editor', 'settings'].map(id => ({ id, disabled: true }))]
}

/** Freeze hosted composition without consulting writable profile or home patch layers. */
export function hostedProfilePatches(profile: Profile, overlays: readonly PatchOptions[]): PatchOptions[] {
  return structuredClone([
    ...profile.layers.flatMap(layer => layer.patches),
    ...overlays,
    ...hostedRuntimeOverlay(),
  ])
}

/**
 * Load `name` and compose its effective patch stack: bundle layers in
 * `dsh.profile.bundles` order (a base-backed profile gets the base bundle's
 * platform-gated shell rows), the profile's user layer, the home-level user
 * layer (`$DSH_HOME/cordis.patch.yml` — machine-local preferences that apply
 * to every profile, so it outranks the per-profile layer), `--patch` overlays,
 * then the telemetry switch.
 * @param name - the profile name.
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @param fromDefaultProfile - shipped template for a missing named profile.
 * @param resolvedProfile - application-owned profile and installation.
 * @returns the profile and its patch layers.
 */
async function composeProfile(
  name: string,
  patchFiles: readonly string[],
  fromDefaultProfile?: string,
  resolvedProfile?: ResolvedProfileRuntime,
  hostedRuntime = false,
): Promise<ComposedProfile> {
  if (hostedRuntime) {
    const profile = sealedHostedProfile()
    // The resolver has no writable profile or shared-home anchor in hosted mode.
    const resolution = await hostedRuntimeResolution()
    return { profile, resolution, overlays: loadHostedPatchSnapshot(patchFiles) }
  }
  const profile = resolvedProfile?.profile ?? prepareProfile(name, true, fromDefaultProfile)
  if (resolvedProfile !== undefined) writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  const resolutionOptions = { installAnchor: resolvedProfile?.installAnchor ?? INSTALL_ANCHOR, profile }
  const resolution = await createRuntimeResolution(resolutionOptions)
  const overlays = patchFiles.flatMap(file => loadOverlayPatches(NAME, resolve(file)))
  return { profile, resolution, overlays }
}

/** An application-owned profile and its independent installation fallback. */
export interface ResolvedProfileRuntime {
  /** Profile already loaded from the application's own directory. */
  profile: Profile
  /** Absolute package.json path of the application's dsh installation. */
  installAnchor: string
}

/** Options for {@link runProfile}. */
export interface RunProfileOptions {
  /** This run's frozen environment snapshot, provided before any entry mounts. */
  environment: LaunchEnvironmentSnapshot
  /** The profile name to boot. */
  profile: string
  /** Loaded application profile; bypasses named profile initialization when supplied. */
  resolvedProfile?: ResolvedProfileRuntime | undefined
  /** Shipped template used once to initialize a missing profile. */
  fromDefaultProfile?: string | undefined
  /** `--patch` overlay paths, in argv order. */
  patchFiles: readonly string[]
  /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`. */
  args: readonly string[]
  /** Application-owned package runtime, scoped to plugin package operations. */
  packageManager?: ProfileContext['packageManager']
}

/**
 * Boot one profile invocation end to end and leave process lifetime to the
 * mounted plugins (or to a one-shot runner the composition mounts).
 * @param options - environment snapshot, profile name, overlays, and the booted app's own arguments.
 * @returns the settled root context and the shutdown controller.
 * @throws after disposing startup resources; cleanup failures retain the original error.
 */
export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  const hostedRuntime = options.profile === 'web' && isHostedRuntimeInvocation(options.args)
  if (hostedRuntime) validateInheritedDescriptors()
  // Before the first plugin mounts and before anything can issue a request: Node's fetch ignores the
  // proxy environment on its own, so every profile would otherwise connect directly. Resolving from
  // the launcher's snapshot — not `process.env` — is what lets a proxy declared in a `.env` layer
  // work, which the NODE_USE_ENV_PROXY flag cannot do because Node samples the environment at start.
  const disposeProxy = await installProxyFromEnvironment(
    options.environment,
    (message) => { process.stderr.write(`${NAME}: ${message}\n`) },
  )

  const app: { current?: Context } = {}
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => disposal ??= (async () => {
    const failures: unknown[] = []
    for (const release of [() => app.current?.fiber.dispose(), disposeProxy]) {
      try { await release() } catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'dsh: profile cleanup failed')
  })()
  try {
    const composed = await composeProfile(
      options.profile, options.patchFiles, options.fromDefaultProfile, options.resolvedProfile, hostedRuntime,
    )
    const appReady = createAppReady()
    const shutdown = createProcessShutdown(dispose)
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
    const profileContext: ProfileContext = {
      name: options.profile,
      ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
      dir: composed.profile.dir, patchPath: composed.profile.patchPath,
      installAnchor: options.resolvedProfile?.installAnchor ?? INSTALL_ANCHOR,
      startedBundles: composed.profile.layers.map(layer => layer.packageName),
      cwd: process.cwd(), home: resolveDshHome(),
      overlays: composed.overlays, telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
    }
    const sealedPatches = hostedRuntime
      ? hostedProfilePatches(composed.profile, composed.overlays)
      : readProfilePatches(NAME, profileContext, composed.profile)
    const hostedSettings = hostedRuntime ? new HostedSettings(resolveDshHome(), sealedPatches) : undefined
    const patches = hostedSettings?.patches() ?? sealedPatches
    const ctx = await boot(NAME, rootConfig, patches, async (hostCtx) => {
      app.current = hostCtx
      hostCtx.provide('profileContext', profileContext)
      if (hostedRuntime) hostCtx.provide('fd199HostedExit', code => shutdown.shutdown(code))
      await hostedSettings?.install(hostCtx)
      // Before any config-tree entry mounts, so plugins resolve all launch-time
      // environment values from the same immutable launch snapshot.
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
      await hostCtx.plugin(PluginPackages, {
        resolution: composed.resolution,
      })
      // The command line and bounded exit request are launcher facts available
      // to every app plugin that injects the argument snapshot.
      provideCmdline(hostCtx, {
        args: hostedRuntime ? options.args.slice(0, -HOSTED_RUNTIME_ARGUMENTS.length) : options.args,
        exit: (code) => { void shutdown.shutdown(code) },
        ready: appReady.service,
      })
    }, hostedBoot?.bareModuleBaseUrl)
    app.current = ctx
    await hostedSettings?.commitValidated(ctx)
    let didPublishHostedRegistry = false
    if (options.profile === 'web') {
      const url = loopbackWebUrl(ctx)
      if (url !== undefined) didPublishHostedRegistry = await publishBoundWebRuntimeRegistry(ctx, url, webRuntimeRegistryForPlatform({
        ...webRuntimeRegistryLifecycle,
        publishBootstrap: async (owner) => {
          await publishWebRuntimeBootstrap(owner, ctx.connection.authenticatedUrl(owner.url))
        },
        removeBootstrap: removeOwnedWebRuntimeBootstrap,
      }, hostedRuntime))
    }
    if (hostedRuntime) {
      if (!didPublishHostedRegistry) throw new Error('hosted Web runtime registry and bootstrap were not published')
      const desktopReady = ctx.get('fd199DesktopReady') as { signal?: () => Promise<void> } | undefined
      if (desktopReady?.signal !== undefined) {
        await desktopReady.signal()
      }
    }
    if (!signalShutdown.signal.aborted
      && ctx.fiber.state === FiberState.ACTIVE
      && ctx.get('loader') !== undefined) {
      appReady.commit()
    }
    return { ctx, shutdown }
  } catch (error) {
    try { await dispose() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'dsh: profile startup and cleanup failed')
    }
    throw error
  }
}
