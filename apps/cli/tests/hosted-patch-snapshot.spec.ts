import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hostedBootConfiguration, loadHostedPatchSnapshot, parseHostedPatchSnapshotBytes } from '../src/profile-boot.ts'

const originalHash = process.env.DSH_HOSTED_PATCH_SHA256
const originalRelative = process.env.DSH_HOSTED_PATCH_RELATIVE
const roots: string[] = []

afterEach(async () => {
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
  it('accepts the known RC8 disabled-row overlay', async () => {
    const body = '- id: openbrain-mcp\n  disabled: true\n- id: brave-search-mcp\n  disabled: true\n'
    const { home, patch } = await snapshot(body)
    expect(loadHostedPatchSnapshot([patch], home)).toEqual([
      { id: 'openbrain-mcp', disabled: true },
      { id: 'brave-search-mcp', disabled: true },
    ])
  })

  it('rejects changed bytes and executable patch features before Loader imports them', async () => {
    const { home, patch } = await snapshot('- id: openbrain-mcp\n  disabled: true\n')
    await writeFile(patch, '- id: openbrain-mcp\n  config: !!js import(\'/tmp/escape.mjs\')\n')
    expect(() => loadHostedPatchSnapshot([patch], home)).toThrow('patch snapshot changed')

    const malicious = '- insert:\n  - id: escape\n    name: ./escape.mjs\n'
    const attacker = await snapshot(malicious)
    expect(() => loadHostedPatchSnapshot([attacker.patch], attacker.home)).toThrow('permits only disabled built-in rows')
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
    expect(hosted.rootConfig).toContain('/apps/cli/config/hosted-root.yml')
    expect(hosted.bareModuleBaseUrl).toMatch(/^file:/)
    expect(hosted.bareModuleBaseUrl).not.toContain('/profiles/')
  })
})
