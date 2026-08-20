import { join, relative, resolve, sep } from 'node:path'

const PACKAGED_RUNTIME_DIRECTORY = 'dsh-runtime'
const PACKAGED_RUNTIME_ENTRY = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
const ELECTRON_NODE_FLAGS = ['--expose-internals'] as const

/** Inputs owned by the Electron main process when launching the DSH runtime. */
export interface RuntimeCommandOptions {
  readonly appDataPath: string
  readonly executablePath: string
  readonly inheritedEnv: NodeJS.ProcessEnv
  readonly isPackaged: boolean
  readonly resourcesPath: string
  readonly sourceRoot: string
  readonly runtimeOverride?: string
}

/** A fixed runtime command that never accepts a renderer-supplied executable path. */
export interface RuntimeCommand {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

/** Resolve a resource child without allowing the resource root to be escaped. */
function resourceChild(resourcesPath: string, ...segments: string[]): string {
  const root = resolve(resourcesPath)
  const candidate = resolve(root, ...segments)
  const fromRoot = relative(root, candidate)
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`DSH Desktop rejected a packaged runtime path outside ${root}.`)
  }
  return candidate
}

/** Preserve user configuration while removing host controls that change Electron or Node execution. */
function runtimeEnvironment(environment: NodeJS.ProcessEnv, dshHome: string, runAsNode: boolean): NodeJS.ProcessEnv {
  const runtimeEnv: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(environment)) {
    if (name === 'NODE_OPTIONS' || name === 'DSH_DESKTOP_RUNTIME' || name.startsWith('ELECTRON_')) continue
    runtimeEnv[name] = value
  }
  runtimeEnv.DSH_HOME = dshHome
  if (runAsNode) runtimeEnv.ELECTRON_RUN_AS_NODE = '1'
  return runtimeEnv
}

/** Resolve the local DSH web process for source development or a packaged app. */
export function runtimeCommand(options: RuntimeCommandOptions): RuntimeCommand {
  const dshHome = join(options.appDataPath, 'dsh')
  if (options.isPackaged) {
    const runtimeDirectory = resourceChild(options.resourcesPath, PACKAGED_RUNTIME_DIRECTORY)
    return {
      command: options.executablePath,
      args: [
        ...ELECTRON_NODE_FLAGS,
        resourceChild(runtimeDirectory, PACKAGED_RUNTIME_ENTRY),
        'web',
        '--no-open',
        '--port',
        '0',
      ],
      cwd: runtimeDirectory,
      env: runtimeEnvironment(options.inheritedEnv, dshHome, true),
    }
  }
  if (options.runtimeOverride !== undefined && options.runtimeOverride !== '') {
    return {
      command: options.runtimeOverride,
      args: ['web', '--no-open', '--port', '0'],
      cwd: options.sourceRoot,
      env: runtimeEnvironment(options.inheritedEnv, dshHome, false),
    }
  }
  return {
    command: options.executablePath,
    args: [
      ...ELECTRON_NODE_FLAGS,
      '--import',
      'tsx/esm',
      join(options.sourceRoot, 'apps/cli/src/bin.ts'),
      'web',
      '--no-open',
      '--port',
      '0',
    ],
    cwd: options.sourceRoot,
    env: runtimeEnvironment(options.inheritedEnv, dshHome, true),
  }
}
