import { execFile } from 'node:child_process'
import { renameSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  internals,
  parseWebRuntimeRegistry,
  publishWebRuntimeRegistry,
  removeOwnedWebRuntimeRegistry,
  webRuntimeRegistryPath,
} from '../src/web-runtime-registry.ts'

const homes: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  internals.afterRegistryLstat = () => {}
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

async function testHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-web-runtime-registry-'))
  homes.push(home)
  return home
}

describe('Web runtime registry', () => {
  it('atomically publishes a versioned, loopback-only JSON record', async () => {
    const home = await testHome()
    const record = await publishWebRuntimeRegistry({
      home,
      url: 'http://127.0.0.1:43123',
      pid: 451,
      startedAt: new Date('2026-08-20T09:00:00.000Z'),
    })

    expect(record).toEqual({
      version: 1,
      profile: 'web',
      url: 'http://127.0.0.1:43123',
      pid: 451,
      startedAt: '2026-08-20T09:00:00.000Z',
    })
    expect(parseWebRuntimeRegistry(await readFile(webRuntimeRegistryPath(home), 'utf8'))).toEqual(record)
  })

  it('rejects malformed, version-mismatched, public, and credential-bearing records', () => {
    expect(parseWebRuntimeRegistry('{')).toBeUndefined()
    expect(parseWebRuntimeRegistry(JSON.stringify({
      version: 2,
      profile: 'web',
      url: 'http://127.0.0.1:43123',
      pid: 451,
      startedAt: '2026-08-20T09:00:00.000Z',
    }))).toBeUndefined()
    expect(parseWebRuntimeRegistry(JSON.stringify({
      version: 1,
      profile: 'web',
      url: 'https://public.example',
      pid: 451,
      startedAt: '2026-08-20T09:00:00.000Z',
    }))).toBeUndefined()
    expect(parseWebRuntimeRegistry(JSON.stringify({
      version: 1,
      profile: 'web',
      url: 'http://token@127.0.0.1:43123',
      pid: 451,
      startedAt: '2026-08-20T09:00:00.000Z',
    }))).toBeUndefined()
  })

  it('refuses to publish a non-loopback URL', async () => {
    const home = await testHome()
    await expect(publishWebRuntimeRegistry({ home, url: 'https://public.example' }))
      .rejects.toThrow('only an exact 127.0.0.1 URL may be published')
  })

  it('cleans up only the exact process-owned record', async () => {
    const home = await testHome()
    const owner = await publishWebRuntimeRegistry({
      home,
      url: 'http://127.0.0.1:43123',
      pid: 451,
      startedAt: new Date('2026-08-20T09:00:00.000Z'),
    })
    const replacement = await publishWebRuntimeRegistry({
      home,
      url: 'http://127.0.0.1:43124',
      pid: 452,
      startedAt: new Date('2026-08-20T09:01:00.000Z'),
    })

    expect(await removeOwnedWebRuntimeRegistry(owner, home)).toBe(false)
    expect(parseWebRuntimeRegistry(await readFile(webRuntimeRegistryPath(home), 'utf8'))).toEqual(replacement)
    expect(await removeOwnedWebRuntimeRegistry(replacement, home)).toBe(true)
    await expect(readFile(webRuntimeRegistryPath(home), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not delete malformed records during cleanup', async () => {
    const home = await testHome()
    const owner = await publishWebRuntimeRegistry({
      home,
      url: 'http://127.0.0.1:43123',
      pid: 451,
      startedAt: new Date('2026-08-20T09:00:00.000Z'),
    })
    await writeFile(webRuntimeRegistryPath(home), '{"url":"https://public.example"}\n')

    expect(await removeOwnedWebRuntimeRegistry(owner, home)).toBe(false)
    await expect(readFile(webRuntimeRegistryPath(home), 'utf8')).resolves.toContain('public.example')
  })

  it('refuses special files and oversized payloads without reading them', async () => {
    const home = await testHome()
    const owner = await publishWebRuntimeRegistry({
      home,
      url: 'http://127.0.0.1:43123',
      pid: 451,
      startedAt: new Date('2026-08-20T09:00:00.000Z'),
    })
    const filename = webRuntimeRegistryPath(home)
    await rm(filename)
    await mkdir(filename)
    expect(await removeOwnedWebRuntimeRegistry(owner, home)).toBe(false)
    await rm(filename, { recursive: true })
    await writeFile(filename, 'x'.repeat(4_097))
    expect(await removeOwnedWebRuntimeRegistry(owner, home)).toBe(false)
  })

  it('does not block when a regular registry becomes a FIFO after preflight', async () => {
    const home = await testHome()
    const owner = await publishWebRuntimeRegistry({
      home,
      url: 'http://127.0.0.1:43123',
      pid: 451,
      startedAt: new Date('2026-08-20T09:00:00.000Z'),
    })
    const filename = webRuntimeRegistryPath(home)
    const fifo = join(home, 'runtime', 'replacement.fifo')
    await execFileAsync('mkfifo', [fifo])
    internals.afterRegistryLstat = () => { renameSync(fifo, filename) }

    await expect(removeOwnedWebRuntimeRegistry(owner, home)).resolves.toBe(false)
  })
})
