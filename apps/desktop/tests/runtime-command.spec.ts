import { describe, expect, it } from 'vitest'
import { runtimeCommand } from '../src/runtime-command.ts'

const options = {
  appDataPath: '/user/Library/Application Support/DSH Desktop',
  executablePath: '/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop',
  inheritedEnv: {
    DEEPSEEK_API_KEY: 'available-to-runtime',
    DSH_DESKTOP_RUNTIME: '/untrusted-when-packaged',
    ELECTRON_NO_ASAR: '1',
    NODE_OPTIONS: '--require /untrusted.js',
  },
  resourcesPath: '/Applications/DSH Desktop.app/Contents/Resources',
  sourceRoot: '/repo/',
} as const

describe('runtimeCommand', () => {
  it('launches the packaged DSH runtime from application resources with an app-owned home', () => {
    const command = runtimeCommand({ ...options, isPackaged: true })

    expect(command).toMatchObject({
      command: options.executablePath,
      cwd: '/Applications/DSH Desktop.app/Contents/Resources/dsh-runtime',
      args: [
        '--expose-internals',
        '/Applications/DSH Desktop.app/Contents/Resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
        'web',
        '--no-open',
        '--port',
        '0',
      ],
    })
    expect(command.env).toMatchObject({
      DEEPSEEK_API_KEY: 'available-to-runtime',
      DSH_HOME: '/user/Library/Application Support/DSH Desktop/dsh',
      ELECTRON_RUN_AS_NODE: '1',
    })
    expect(command.env.NODE_OPTIONS).toBeUndefined()
    expect(command.env.ELECTRON_NO_ASAR).toBeUndefined()
    expect(command.env.DSH_DESKTOP_RUNTIME).toBeUndefined()
  })

  it('allows an explicit external runtime only during source development', () => {
    const command = runtimeCommand({ ...options, isPackaged: false, runtimeOverride: '/usr/local/bin/dsh' })

    expect(command).toMatchObject({
      command: '/usr/local/bin/dsh',
      cwd: '/repo/',
      args: ['web', '--no-open', '--port', '0'],
    })
    expect(command.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('uses Electron Node mode only for the source-tree runtime', () => {
    const command = runtimeCommand({ ...options, isPackaged: false, runtimeOverride: undefined })

    expect(command).toMatchObject({
      command: options.executablePath,
      cwd: '/repo/',
      args: ['--expose-internals', '--import', 'tsx/esm', '/repo/apps/cli/src/bin.ts', 'web', '--no-open', '--port', '0'],
    })
    expect(command.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})
