import { execFile } from 'node:child_process'
import { renameSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  internals,
  parseWebRuntimeRegistry,
  parseWebRuntimeBootstrap,
  publishWebRuntimeBootstrap,
  publishWebRuntimeRegistry,
  removeOwnedWebRuntimeBootstrap,
  removeOwnedWebRuntimeRegistry,
  webRuntimeRegistryPath,
  webRuntimeBootstrapPath,
} from '../src/web-runtime-registry.ts'

const homes: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  internals.afterRegistryLstat = () => {}
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

// These real-filesystem checks prove the signed Host's POSIX ownership contract.
// Windows rejection is tested separately, without pretending NTFS chmod is POSIX.
describe.skipIf(process.platform === 'win32')('private Web browser bootstrap', () => {
  const token = Buffer.alloc(32, 7).toString('base64url')
  const url = 'http://127.0.0.1:43123'
  const authenticatedUrl = `${url}/?token=${token}`
  async function ownerFixture() {
    const home = await realpath(await testHome())
    const owner = await publishWebRuntimeRegistry({ home, url, pid: 451, startedAt: new Date('2026-08-20T09:00:00.000Z') })
    return { home, owner }
  }

  it('publishes a separate owner-only capability correlated with noncredential discovery', async () => {
    const { home, owner } = await ownerFixture()
    const record = await publishWebRuntimeBootstrap(owner, authenticatedUrl, home)
    expect(parseWebRuntimeBootstrap(await readFile(webRuntimeBootstrapPath(home), 'utf8'), owner)).toEqual(record)
    expect(record).toEqual({ version: 1, profile: 'web', origin: url, authenticatedUrl, pid: owner.pid, startedAt: owner.startedAt })
    expect((await lstat(webRuntimeBootstrapPath(home))).mode & 0o777).toBe(0o600)
    expect((await lstat(join(home, 'runtime'))).mode & 0o777).toBe(0o700)
    expect(await readFile(webRuntimeRegistryPath(home), 'utf8')).not.toContain(token)
  })

  it('roundtrips the real writer through the maintained Desktop shell reader', async () => {
    const home = await realpath(await testHome())
    const owner = await publishWebRuntimeRegistry({ home, url, pid: process.pid })
    await publishWebRuntimeBootstrap(owner, authenticatedUrl, home)
    const reader = new URL('../../../native/remote-host-app/desktop-shell/runtime-discovery.mjs', import.meta.url).href
    const script = `import { discoverRuntime } from ${JSON.stringify(reader)};
      const value = await discoverRuntime(process.argv[1]);
      if (value !== ${JSON.stringify(authenticatedUrl)}) process.exit(1);
      process.stdout.write('ok');`
    const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', script, home])
    expect(result.stdout).toBe('ok')
    expect(result.stderr).toBe('')
  })

  it('rejects origin, process, timestamp, URL and extra-field mismatches', async () => {
    const { home, owner } = await ownerFixture()
    const record = await publishWebRuntimeBootstrap(owner, authenticatedUrl, home)
    for (const patch of [
      { origin: 'http://127.0.0.1:43124' }, { pid: 452 }, { startedAt: '2026-08-20T09:00:01.000Z' },
      { authenticatedUrl: `${authenticatedUrl}&extra=1` }, { authenticatedUrl: `${authenticatedUrl}#fragment` },
      { authenticatedUrl: `${url}/other?token=${token}` }, { authenticatedUrl: `${url}/?token=${token.slice(0, -1)}!` },
      { extra: true },
    ]) expect(parseWebRuntimeBootstrap(JSON.stringify({ ...record, ...patch }), owner)).toBeUndefined()
    expect(parseWebRuntimeBootstrap(' '.repeat(4097), owner)).toBeUndefined()
  })

  it('refuses a stale publisher and preserves the current capability on stale cleanup', async () => {
    const { home, owner } = await ownerFixture()
    await publishWebRuntimeBootstrap(owner, authenticatedUrl, home)
    const replacement = await publishWebRuntimeRegistry({ home, url, pid: 452, startedAt: new Date('2026-08-20T09:01:00.000Z') })
    const current = await publishWebRuntimeBootstrap(replacement, authenticatedUrl, home)
    await expect(publishWebRuntimeBootstrap(owner, authenticatedUrl, home)).rejects.toThrow('owner no longer matches')
    expect(await removeOwnedWebRuntimeBootstrap(owner, home)).toBe(false)
    expect(parseWebRuntimeBootstrap(await readFile(webRuntimeBootstrapPath(home), 'utf8'), replacement)).toEqual(current)
    expect(await removeOwnedWebRuntimeBootstrap(replacement, home)).toBe(true)
    expect(await removeOwnedWebRuntimeBootstrap(replacement, home)).toBe(false)
  })

  it('fails closed for permissive or unwritable runtime directories', async () => {
    const { home, owner } = await ownerFixture()
    for (const mode of [0o755, 0o500]) {
      await chmod(join(home, 'runtime'), mode)
      await expect(publishWebRuntimeBootstrap(owner, authenticatedUrl, home)).rejects.toThrow('runtime directory must be private')
    }
    await chmod(join(home, 'runtime'), 0o700)
    await expect(readFile(webRuntimeBootstrapPath(home))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a symlinked runtime directory', async () => {
    const home = await testHome()
    const target = await testHome()
    await symlink(target, join(home, 'runtime'))
    const owner = { version: 1 as const, profile: 'web' as const, url, pid: 451, startedAt: '2026-08-20T09:00:00.000Z' }
    await expect(publishWebRuntimeBootstrap(owner, authenticatedUrl, home)).rejects.toThrow('runtime directory must be private')
  })

  it('refuses symlinks, special files and permissive capability files without overwriting them', async () => {
    const { home, owner } = await ownerFixture()
    const filename = webRuntimeBootstrapPath(home)
    const target = join(home, 'sentinel')
    await writeFile(target, 'unchanged')
    await symlink(target, filename)
    await expect(publishWebRuntimeBootstrap(owner, authenticatedUrl, home)).rejects.toThrow('capability file is unsafe')
    expect(await removeOwnedWebRuntimeBootstrap(owner, home)).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('unchanged')
    await rm(filename)
    await mkdir(filename)
    await expect(publishWebRuntimeBootstrap(owner, authenticatedUrl, home)).rejects.toThrow('capability file is unsafe')
    await rm(filename, { recursive: true })
    await writeFile(filename, '{}', { mode: 0o644 })
    await expect(publishWebRuntimeBootstrap(owner, authenticatedUrl, home)).rejects.toThrow('capability file is unsafe')
  })

  it('fails without writing a capability when current discovery is missing or not private', async () => {
    const { home, owner } = await ownerFixture()
    await chmod(webRuntimeRegistryPath(home), 0o644)
    await expect(publishWebRuntimeBootstrap(owner, authenticatedUrl, home)).rejects.toThrow('owner no longer matches')
    await rm(webRuntimeRegistryPath(home))
    await expect(publishWebRuntimeBootstrap(owner, authenticatedUrl, home)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(webRuntimeBootstrapPath(home))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

async function testHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-web-runtime-registry-'))
  homes.push(home)
  return home
}

describe('Web runtime registry', () => {
  it.runIf(process.platform === 'win32')('retains public discovery while private bootstrap fails closed without POSIX ownership', async () => {
    const home = await realpath(await testHome())
    const owner = await publishWebRuntimeRegistry({ home, url: 'http://127.0.0.1:43123' })
    const authenticatedUrl = `${owner.url}/?token=${Buffer.alloc(32, 7).toString('base64url')}`
    await expect(publishWebRuntimeBootstrap(owner, authenticatedUrl, home)).rejects.toThrow('runtime directory must be private')
    expect(parseWebRuntimeRegistry(await readFile(webRuntimeRegistryPath(home), 'utf8'))).toEqual(owner)
    await expect(readFile(webRuntimeBootstrapPath(home))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await removeOwnedWebRuntimeRegistry(owner, home)).toBe(true)
  })

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
