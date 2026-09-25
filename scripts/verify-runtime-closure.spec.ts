import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadCordisYaml } from './cordis-yaml.ts'
import { verifyRuntimeClosure, verifyStagedRuntimeClosure } from './verify-runtime-closure.ts'

const roots: string[] = []

function fixture(files: Record<string, string | Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-closure-'))
  roots.push(root)
  for (const [relative, value] of Object.entries(files)) {
    const preset = /^preset:(.+)$/.exec(relative)
    const path = join(root, preset === null ? relative : `packages/bundle/web-app/presets/${preset[1]}.patch.yml`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, preset === null ? (typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`) : JSON.stringify([{ insert: [{ name: '@deepseek-ai/dsh-agent-preset', config: { id: preset[1], plugins: typeof value === 'string' ? loadCordisYaml(value) : value } }] }]))
  }
  return root
}

const platforms = {
  'linux-x64': { tag: 'manylinux_2_28_x86_64', executable: 'runtime-linux-x64' },
  'linux-arm64': { tag: 'manylinux_2_28_aarch64', executable: 'runtime-linux-arm64' },
  'macos-arm64': { tag: 'macosx_14_0_arm64', executable: 'runtime-macos-arm64' },
  'macos-x64': { tag: 'macosx_14_0_x86_64', executable: 'runtime-macos-x64' },
  'win-x64': { tag: 'win_amd64', executable: 'runtime-win-x64.exe' },
}

function workspace(root: string, name: string, manifest: Record<string, unknown>): void {
  const packageName = name.replace('@scope/', '')
  const path = join(root, 'packages/core', packageName, 'package.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ name, ...manifest }, null, 2)}\n`)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('verifyRuntimeClosure', () => {
  it('checks required transitive workspace packages in the sealed tree without ancestor fallback', async () => {
    const root = fixture({
      'packages/core/entry/package.json': { name: '@scope/entry' },
      'packages/core/service/package.json': { name: '@scope/service' },
      'packages/core/leaf/package.json': { name: '@scope/leaf' },
      'staged/package.json': { dependencies: { '@scope/entry': 'workspace:*' } },
      'staged/node_modules/@scope/entry/package.json': { name: '@scope/entry', dependencies: { '@scope/service': 'workspace:*' } },
      'staged/node_modules/@scope/service/package.json': { name: '@scope/service', dependencies: { '@scope/leaf': 'workspace:*' } },
      'node_modules/@scope/leaf/package.json': { name: '@scope/leaf' },
    })
    expect(await verifyStagedRuntimeClosure(root, join(root, 'staged'))).toEqual([
      '@scope/service -> @scope/leaf is missing from the staged runtime',
    ])
    const leaf = join(root, 'staged/node_modules/@scope/leaf')
    mkdirSync(leaf, { recursive: true })
    writeFileSync(join(leaf, 'package.json'), JSON.stringify({ name: '@scope/leaf' }))
    expect(await verifyStagedRuntimeClosure(root, join(root, 'staged'))).toEqual([])
  })

  it('requires workspace peers but excludes dev dependencies, optional peers, and unrelated private apps', async () => {
    const root = fixture({
      'packages/core/service/package.json': { name: '@scope/service' },
      'packages/core/peer/package.json': { name: '@scope/peer' },
      'packages/core/dev/package.json': { name: '@scope/dev' },
      'packages/core/optional/package.json': { name: '@scope/optional' },
      'apps/private/package.json': { name: '@scope/private', private: true, dependencies: { '@scope/dev': 'workspace:*' } },
      'staged/package.json': { dependencies: { '@scope/service': 'workspace:*' } },
      'staged/node_modules/@scope/service/package.json': {
        name: '@scope/service', devDependencies: { '@scope/dev': 'workspace:*' },
        peerDependencies: { '@scope/peer': 'workspace:*', '@scope/optional': 'workspace:*' },
        peerDependenciesMeta: { '@scope/optional': { optional: true } },
      },
    })
    expect(await verifyStagedRuntimeClosure(root, join(root, 'staged'))).toEqual([
      '@scope/service -> @scope/peer is missing from the staged runtime',
    ])
    const peer = join(root, 'staged/node_modules/@scope/peer')
    mkdirSync(peer, { recursive: true })
    writeFileSync(join(peer, 'package.json'), JSON.stringify({ name: '@scope/peer' }))
    expect(await verifyStagedRuntimeClosure(root, join(root, 'staged'))).toEqual([])
  })

  it('leaves application-owned alternate profiles outside the declared shared-package closure', async () => {
    const root = fixture({
      'apps/cli/package.json': { name: '@scope/cli' },
      'packages/bundle/alternate/package.json': { name: '@scope/alternate' },
      'staged/package.json': { dependencies: { '@scope/cli': 'workspace:*' } },
      'staged/node_modules/@scope/cli/package.json': { name: '@scope/cli', dependencies: { '@scope/alternate': 'workspace:*' } },
    })
    expect(await verifyStagedRuntimeClosure(root, join(root, 'staged'))).toEqual([])
  })

  it('requires only plugins active for each published target', async () => {
    const root = fixture({
      'python/sdk-runtime/package.json': { name: 'runtime', dependencies: { '@scope/shared': 'workspace:^' } },
      'python/sdk-runtime/platforms.json': platforms,
      'preset:standard': `
- id: tools
  name: cordis:group
  group: true
  config:
    - id: shared
      name: '@scope/shared'
    - id: linux
      name: '@scope/linux'
      disabled: !!js process.platform !== 'linux'
    - id: macos
      name: '@scope/macos'
      disabled: !!js process.platform !== 'darwin'
    - id: windows
      name: '@scope/windows'
      disabled: !!js process.platform !== 'win32'
`,
    })

    const result = await verifyRuntimeClosure(root)

    expect(result.presetCount).toBe(1)
    expect(result.failures).toEqual([
      'standard preset -> @scope/linux (linux-arm64, linux-x64)',
      'standard preset -> @scope/macos (macos-arm64, macos-x64)',
      'standard preset -> @scope/windows (win-x64)',
    ])
  })

  it('treats an unsupported disabled expression as active on every target', async () => {
    const root = fixture({
      'python/sdk-runtime/package.json': { name: 'runtime', dependencies: {} },
      'python/sdk-runtime/platforms.json': platforms,
      'preset:standard': `
- id: conditional
  name: '@scope/conditional'
  disabled: !!js process.env.DSH_DISABLE_CONDITIONAL === '1'
`,
    })

    const result = await verifyRuntimeClosure(root)

    expect(result.failures).toEqual([
      'standard preset -> @scope/conditional (linux-arm64, linux-x64, macos-arm64, macos-x64, win-x64)',
    ])
  })

  it('does not interpret an ordinary plugin array config as nested Loader entries', async () => {
    const root = fixture({
      'python/sdk-runtime/package.json': { name: 'runtime', dependencies: { '@scope/plugin': 'workspace:^' } },
      'python/sdk-runtime/platforms.json': platforms,
      'preset:standard': `
- id: plugin
  name: '@scope/plugin'
  config:
    - name: '@scope/config-value'
`,
    })

    const result = await verifyRuntimeClosure(root)

    expect(result.failures).toEqual([])
  })

  it('requires preset plugins to be linked from the workspace', async () => {
    const root = fixture({
      'python/sdk-runtime/package.json': { name: 'runtime', dependencies: { '@scope/plugin': '1.2.3' } },
      'python/sdk-runtime/platforms.json': platforms,
      'preset:standard': `
- id: plugin
  name: '@scope/plugin'
`,
    })

    const result = await verifyRuntimeClosure(root)

    expect(result.failures).toEqual([
      'standard preset -> @scope/plugin [runtime dependency is "1.2.3"; expected workspace:] (linux-arm64, linux-x64, macos-arm64, macos-x64, win-x64)',
    ])
  })

  it('fails when no shipped preset is discovered', async () => {
    const root = fixture({
      'python/sdk-runtime/package.json': { name: 'runtime', dependencies: {} },
      'python/sdk-runtime/platforms.json': platforms,
    })

    const result = await verifyRuntimeClosure(root)

    expect(result.presetCount).toBe(0)
    expect(result.failures).toEqual([
      'no agent presets matched packages/bundle/web-app/presets/*.patch.yml',
    ])
  })

  it('fails when the runtime platform manifest has no targets', async () => {
    const root = fixture({
      'python/sdk-runtime/package.json': { name: 'runtime', dependencies: {} },
      'python/sdk-runtime/platforms.json': {},
      'preset:standard': '[]\n',
    })

    const result = await verifyRuntimeClosure(root)

    expect(result.failures).toEqual([
      'python/sdk-runtime/platforms.json defines no runtime targets',
    ])
  })

  it('retains the required workspace-peer closure check', async () => {
    const root = fixture({
      'python/sdk-runtime/package.json': { name: 'runtime', dependencies: { '@scope/root': 'workspace:^' } },
      'python/sdk-runtime/platforms.json': platforms,
      'preset:minimal': '[]\n',
    })
    workspace(root, '@scope/root', {
      peerDependencies: { '@scope/required': 'workspace:^', '@scope/optional': 'workspace:^' },
      peerDependenciesMeta: { '@scope/optional': { optional: true } },
    })
    workspace(root, '@scope/required', {})
    workspace(root, '@scope/optional', {})

    const result = await verifyRuntimeClosure(root)

    expect(result.workspacePackageCount).toBe(1)
    expect(result.failures).toEqual(['runtime -> @scope/root -> @scope/required'])
  })
})
