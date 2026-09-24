import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import {
  hostedBootConfiguration, hostedProfilePatches, hostedRuntimeResolution, loadHostedPatchSnapshot, parseHostedPatchSnapshotBytes,
  sealedHostedProfile,
} from '../src/profile-boot.ts'

const originalHash = process.env.DSH_HOSTED_PATCH_SHA256
const originalRelative = process.env.DSH_HOSTED_PATCH_RELATIVE
const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  if (originalHash === undefined) delete process.env.DSH_HOSTED_PATCH_SHA256
  else process.env.DSH_HOSTED_PATCH_SHA256 = originalHash
  if (originalRelative === undefined) delete process.env.DSH_HOSTED_PATCH_RELATIVE
  else process.env.DSH_HOSTED_PATCH_RELATIVE = originalRelative
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function snapshot(body: string): Promise<{ home: string; patch: string }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-hosted-patch-'))
  roots.push(home)
  const patch = join(home, 'rc8-core.patch.yml')
  await writeFile(patch, body)
  process.env.DSH_HOSTED_PATCH_RELATIVE = 'rc8-core.patch.yml'
  process.env.DSH_HOSTED_PATCH_SHA256 = createHash('sha256').update(body).digest('hex')
  return { home, patch }
}

describe('signed hosted patch snapshot', () => {
  it('adds one complete native mobile stack only after the sealed Web profile layers', () => {
    const profile = sealedHostedProfile()
    const fail = (message: string): never => { throw new Error(message) }
    const ordinary = applyEntryPatches([], profile.layers.flatMap(layer => layer.patches), fail)
    expect(ordinary.filter(row => typeof row.name === 'string' && row.name.startsWith('@deepseek-ai/dsh-remote-'))).toEqual([])
    const hosted = applyEntryPatches([], hostedProfilePatches(profile, []), fail)
    const names = [
      '@deepseek-ai/dsh-computer-use',
      '@deepseek-ai/dsh-progress-narration',
      '@deepseek-ai/dsh-experimental-computer-use-policy',
      '@deepseek-ai/dsh-remote-devices',
      '@deepseek-ai/dsh-remote-api',
      '@deepseek-ai/dsh-remote-gateway',
      '@deepseek-ai/dsh-remote-host-v3',
      '@deepseek-ai/dsh-remote-host-fd199',
      '@deepseek-ai/dsh-remote-host-fd199/web-owner',
    ]
    for (const name of names) {
      const rows = hosted.filter(row => row.name === name)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.disabled).not.toBe(true)
    }
    expect(hosted.find(row => row.id === 'remote-host-v3')?.config).toEqual({ enabled: true, hostAppPath: '' })
    expect(hosted.find(row => row.id === 'remote-gateway')?.config).toEqual({
      maxIdempotencyEntriesPerDevice: 2048, maxEventEntriesPerDevice: 4096,
    })
    expect(hosted.some(row => row.name === '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native')).toBe(false)
  })

  it.each(['- null\n', '- false\n', '- []\n'])('rejects non-object overlay entries: %s', (body) => {
    expect(() => parseHostedPatchSnapshotBytes(body, createHash('sha256').update(body).digest('hex')))
      .toThrow('permits only disabled built-in rows')
  })

  it('excludes profile patch content and freezes executable configuration services', () => {
    const patches = hostedProfilePatches({
      name: 'web', dir: '/sealed/config', patchPath: '/sealed/config/hosted-root.yml',
      layers: [{ packageName: 'sealed-base', packageDir: '/sealed/base', patchPaths: ['/sealed/base/cordis.patch.yml'], patches: [{ insert: [{ id: 'safe', name: 'sealed-plugin' }] }] }],
      patches: [{ insert: [{ id: 'escape', name: '/mutable/escape.mjs' }] }],
    }, [{ id: 'safe', disabled: true }])
    expect(JSON.stringify(patches)).not.toContain('escape')
    expect(patches).toContainEqual({ id: 'safe', disabled: true })
    for (const id of ['hmr', 'plugin-manager', 'tool-plugin-manager', 'config-editor', 'settings']) {
      expect(patches).toContainEqual({ id, disabled: true })
    }
    expect(JSON.stringify(patches)).toContain('@deepseek-ai/dsh-remote-host-fd199/web-owner')
  })

  // The signed native Host owns POSIX paths; Windows must not claim a valid
  // native attestation merely because the bytes and relative name match.
  it.skipIf(process.platform === 'win32')('accepts the known RC8 disabled-row overlay', async () => {
    const body = '- id: openbrain-mcp\n  disabled: true\n- id: brave-search-mcp\n  disabled: true\n'
    const { home, patch } = await snapshot(body)
    expect(loadHostedPatchSnapshot([patch], home)).toEqual([
      { id: 'openbrain-mcp', disabled: true },
      { id: 'brave-search-mcp', disabled: true },
    ])
  })

  it.skipIf(process.platform === 'win32')('rejects changed bytes and executable patch features before Loader imports them', async () => {
    const { home, patch } = await snapshot('- id: openbrain-mcp\n  disabled: true\n')
    await writeFile(patch, '- id: openbrain-mcp\n  config: !!js import(\'/tmp/escape.mjs\')\n')
    expect(() => loadHostedPatchSnapshot([patch], home)).toThrow('patch snapshot changed')

    const malicious = '- insert:\n  - id: escape\n    name: ./escape.mjs\n'
    const attacker = await snapshot(malicious)
    expect(() => loadHostedPatchSnapshot([attacker.patch], attacker.home)).toThrow('permits only disabled built-in rows')
  })

  it.runIf(process.platform === 'win32')('rejects a Windows path outside the signed native POSIX contract', async () => {
    const { home, patch } = await snapshot('- id: openbrain-mcp\n  disabled: true\n')
    expect(() => loadHostedPatchSnapshot([patch], home)).toThrow('untrusted patch path')
  })

  it('parses the captured hash-checked bytes, not a second mutable file read', async () => {
    const safe = '- id: openbrain-mcp\n  disabled: true\n'
    const { patch } = await snapshot(safe)
    const captured = safe
    await writeFile(patch, '- insert:\n  - id: escape\n    name: ./escape.mjs\n')
    expect(parseHostedPatchSnapshotBytes(captured, createHash('sha256').update(captured).digest('hex')))
      .toEqual([{ id: 'openbrain-mcp', disabled: true }])
  })

  it('uses a sealed root and sealed bare-module resolver base, not the writable home', async () => {
    const { home } = await snapshot('- id: openbrain-mcp\n  disabled: true\n')
    const hosted = hostedBootConfiguration()
    expect(hosted.rootConfig).not.toContain(home)
    expect(hosted.rootConfig).toContain(join('apps', 'cli', 'config', 'hosted-root.yml'))
    expect(hosted.bareModuleBaseUrl).toMatch(/^file:/)
    expect(hosted.bareModuleBaseUrl).toBe(pathToFileURL(hosted.rootConfig).href)
    expect(hosted.bareModuleBaseUrl).not.toContain('/profiles/')
  })

  it('resolves sealed transitive plugins without reading home manifests or modules', async () => {
    const { home } = await snapshot('- id: openbrain-mcp\n  disabled: true\n')
    const userProfile = join(home, 'profiles', 'web')
    const userModule = join(home, 'node_modules', 'untrusted-host-plugin')
    await mkdir(userProfile, { recursive: true })
    await mkdir(userModule, { recursive: true })
    await writeFile(join(userProfile, 'package.json'), 'invalid user profile must never be parsed')
    await writeFile(join(userProfile, 'cordis.patch.yml'), '- insert:\n  - id: escape\n    name: untrusted-host-plugin\n')
    await writeFile(join(userModule, 'package.json'), '{"name":"untrusted-host-plugin","main":"index.js"}')
    vi.stubEnv('DSH_HOME', home)
    const resolution = await hostedRuntimeResolution()
    expect(resolution.profileDir).toBe(dirname(hostedBootConfiguration().rootConfig))
    expect(resolution.profilesDir).not.toContain(home)
    expect(resolution.linkedRoots).toEqual([])
    expect(resolution.localPackageNames).toEqual([])
    expect(resolution.entries.every(entry => entry.scope === 'installation' && !entry.packageDir.startsWith(home))).toBe(true)
    expect(resolution.entries.some(entry => entry.name === '@deepseek-ai/dsh-typert-registry')).toBe(true)
    expect(resolution.entries.some(entry => entry.name === 'untrusted-host-plugin')).toBe(false)
  })
})
