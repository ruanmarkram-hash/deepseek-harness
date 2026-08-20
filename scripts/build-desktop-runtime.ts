/**
 * Stage the symlink-free DSH Web runtime embedded in the macOS desktop app.
 * @module scripts/build-desktop-runtime
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const DEPLOY_ROOT_PACKAGE = '@deepseek-ai/dsh-desktop-runtime'
const DEPLOY_SOURCE_NODE_MODULES = 'apps/desktop-runtime/node_modules'
const STAGING_DIRECTORY = '.dsh-build/desktop-runtime'
const APPLICATION_DIRECTORY = '.dsh-build/desktop-app'
const DESKTOP_ENTRY = 'node_modules/@deepseek-ai/dsh/lib/bin.js'

/** The application resource path containing the deployed DSH runtime. */
export function desktopRuntimeStagingPath(root: string = ROOT): string {
  return resolve(root, STAGING_DIRECTORY)
}

/** The disposable Electron application directory consumed by electron-builder. */
export function desktopApplicationStagingPath(root: string = ROOT): string {
  return resolve(root, APPLICATION_DIRECTORY)
}

/** The built DSH CLI entry inside a deployed runtime. */
export function desktopRuntimeEntryPath(staging: string): string {
  return join(staging, DESKTOP_ENTRY)
}

/** Whether a staging path is strictly below the repository root. */
export function isSafeDesktopRuntimeStagingPath(root: string, staging: string): boolean {
  const fromRoot = relative(resolve(root), resolve(staging))
  return fromRoot !== '' && !fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !fromRoot.includes(`${sep}..${sep}`)
}

/** The exact deploy invocation that produces a closed on-disk runtime. */
export function desktopRuntimeDeployArgs(staging: string): string[] {
  return [
    '--filter',
    DEPLOY_ROOT_PACKAGE,
    'deploy',
    '--legacy',
    '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    staging,
  ]
}

/** Run a subprocess and label a nonzero exit with its purpose. */
async function run(label: string, command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun()
        return
      }
      reject(new Error(`build-desktop-runtime: ${label} failed (code ${String(code)}, signal ${String(signal)}).`))
    })
  })
}

/** Copy direct workspace packages that pnpm legacy deploy left at its source root. */
async function restoreLegacyHoists(staging: string): Promise<void> {
  const manifestPath = join(staging, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
  const sourceNodeModules = join(ROOT, DEPLOY_SOURCE_NODE_MODULES)
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(staging, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(sourceNodeModules, dependency)
    if (!existsSync(source)) {
      throw new Error(`build-desktop-runtime: deployed dependency ${dependency} is missing from ${destination} and ${source}.`)
    }
    const nestedNodeModules = join(source, 'node_modules')
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}${sep}`),
    })
  }
}

/** Find the first symbolic link below a directory. */
async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Replace workspace links with files and remove unusable package-manager bin links. */
async function materializeRuntimeLinks(staging: string): Promise<void> {
  const nodeModules = join(staging, 'node_modules')
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
      remaining = await findSymlink(nodeModules)
      continue
    }
    const source = await realpath(remaining)
    const nestedNodeModules = join(source, 'node_modules')
    await rm(remaining, { recursive: true, force: true })
    await cp(source, remaining, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}${sep}`),
    })
    remaining = await findSymlink(nodeModules)
  }
}

/** Build DSH artifacts and stage the closed runtime consumed by electron-builder extraResources. */
export async function buildDesktopRuntime(): Promise<void> {
  const staging = desktopRuntimeStagingPath()
  if (!isSafeDesktopRuntimeStagingPath(ROOT, staging)) {
    throw new Error(`build-desktop-runtime: refusing to clear unsafe staging directory ${staging}.`)
  }
  await run('official build', 'pnpm', ['run', 'build:official'])
  await rm(staging, { recursive: true, force: true })
  let deploymentFailed = false
  try {
    await run('deploy', 'pnpm', desktopRuntimeDeployArgs(staging))
    await restoreLegacyHoists(staging)
    await materializeRuntimeLinks(staging)
    if (!existsSync(desktopRuntimeEntryPath(staging))) {
      throw new Error(`build-desktop-runtime: staged DSH entry ${desktopRuntimeEntryPath(staging)} is missing.`)
    }
  } catch (error) {
    deploymentFailed = true
    throw error
  } finally {
    // `pnpm deploy --prod` records production-only workspace state even when a
    // later staging validation fails. Never leave the developer checkout there.
    try {
      await run('restore workspace dependencies', 'pnpm', ['install', '--frozen-lockfile', '--force'])
    } catch (restoreError) {
      if (!deploymentFailed) throw restoreError
      console.error('build-desktop-runtime: also failed to restore workspace dependencies after staging failure.', restoreError)
    }
  }
}

/** Copy the compiled Electron main process into an isolated package directory. */
export async function stageDesktopApplication(): Promise<void> {
  const appDirectory = desktopApplicationStagingPath()
  if (!isSafeDesktopRuntimeStagingPath(ROOT, appDirectory)) {
    throw new Error(`build-desktop-runtime: refusing to clear unsafe app directory ${appDirectory}.`)
  }
  const sourceDirectory = join(ROOT, 'apps/desktop')
  const sourceDist = join(sourceDirectory, 'dist')
  if (!existsSync(sourceDist)) throw new Error('build-desktop-runtime: desktop main process is not built; run its build script first.')
  const sourceManifest = JSON.parse(await readFile(join(sourceDirectory, 'package.json'), 'utf8')) as Record<string, unknown>
  const { devDependencies: _devDependencies, scripts: _scripts, ...applicationManifest } = sourceManifest
  await rm(appDirectory, { recursive: true, force: true })
  await mkdir(appDirectory, { recursive: true })
  await cp(sourceDist, join(appDirectory, 'dist'), { recursive: true })
  await writeFile(join(appDirectory, 'package.json'), `${JSON.stringify(applicationManifest, null, 2)}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void (async () => {
    await buildDesktopRuntime()
    await stageDesktopApplication()
  })().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
