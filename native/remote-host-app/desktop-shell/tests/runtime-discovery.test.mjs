/** Private-file fixtures exercise the shipping reader under plain Node. */
import assert from 'node:assert/strict'
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { authenticatedRuntimeUrl, discoverRuntime, resolveDesktopHome, trustedNavigation } from '../runtime-discovery.mjs'

const origin = 'http://127.0.0.1:3080'
const token = Buffer.alloc(32, 7).toString('base64url')
const web = { version: 1, profile: 'web', url: origin, pid: process.pid, startedAt: '2026-09-24T00:00:00.000Z' }
const bootstrap = { version: 1, profile: 'web', origin, authenticatedUrl: `${origin}/?token=${token}`, pid: web.pid, startedAt: web.startedAt }

test('matches Harness blank, relative, and supported tilde home overrides', () => {
  const home = resolve('example-account')
  for (const blank of [undefined, '', '  ']) assert.equal(resolveDesktopHome(blank, home), join(home, '.dsh'))
  assert.equal(resolveDesktopHome('~', home), home)
  assert.equal(resolveDesktopHome('~/custom-dsh', home), join(home, 'custom-dsh'))
  assert.equal(resolveDesktopHome('~\\custom-dsh', home), join(home, 'custom-dsh'))
  assert.equal(resolveDesktopHome('relative-dsh', home), resolve('relative-dsh'))
})

test('accepts only an exact canonical token URL with matching public owner facts', () => {
  assert.equal(authenticatedRuntimeUrl(web, bootstrap), bootstrap.authenticatedUrl)
  for (const changed of [
    { pid: web.pid + 1 }, { startedAt: '2026-09-25T00:00:00.000Z' }, { origin: 'http://127.0.0.1:3081' },
    { version: 2 }, { profile: 'desktop' }, { extra: true }, { authenticatedUrl: `${origin}/?token=${token}&other=1` },
    { authenticatedUrl: `${origin}/?token=${token}#fragment` }, { authenticatedUrl: `${origin}/path?token=${token}` },
    { authenticatedUrl: `${origin}/?token=${token.slice(0, -1)}d` }, { authenticatedUrl: `${origin}/?token=short` },
    { authenticatedUrl: `${origin}/?token=${'%41'.repeat(43)}` },
  ]) assert.equal(authenticatedRuntimeUrl(web, { ...bootstrap, ...changed }), undefined)
  for (const changed of [
    { url: 'http://localhost:3080' }, { url: 'http://127.0.0.1:65536' }, { url: `${origin}/` },
    { url: 'http://127.0.0.1:03080' }, { url: 'http://user@127.0.0.1:3080' }, { pid: 0 },
    { startedAt: '2026-09-24' }, { extra: true }, { version: 2 },
  ]) assert.equal(authenticatedRuntimeUrl({ ...web, ...changed }, bootstrap), undefined)
  assert.equal(authenticatedRuntimeUrl(null, bootstrap), undefined)
  assert.equal(authenticatedRuntimeUrl(web, []), undefined)
})

test('renderer navigation cannot reuse bootstrap credentials or leave the chosen origin', () => {
  for (const target of [`${origin}/`, `${origin}/sessions/one?panel=files#view`]) {
    assert.equal(trustedNavigation(target, origin), true)
  }
  for (const target of [
    bootstrap.authenticatedUrl, `${origin}/?%74oken=secret`, `${origin}/?token=`,
    'http://127.0.0.1:3081/', 'http://localhost:3080/', 'https://example.com/',
    'http://user@127.0.0.1:3080/', 'javascript:alert(1)', 'file:///tmp/index.html', 'not-a-url',
  ]) assert.equal(trustedNavigation(target, origin), false)
})

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-desktop-reader-')))
  t.after(() => rm(home, { recursive: true, force: true }))
  const runtime = join(home, 'runtime')
  await mkdir(runtime, { mode: 0o700 })
  const publicFile = join(runtime, 'web.json')
  const privateFile = join(runtime, 'web-bootstrap.json')
  await writeFile(publicFile, JSON.stringify(web), { mode: 0o600 })
  await writeFile(privateFile, JSON.stringify(bootstrap), { mode: 0o600 })
  return { home, runtime, publicFile, privateFile }
}

test('reads private records for a live owner without starting any process', { skip: process.platform === 'win32' }, async t => {
  const { home } = await fixture(t)
  assert.equal(await discoverRuntime(home), bootstrap.authenticatedUrl)
})

for (const [name, change] of [
  ['world-readable bootstrap', f => chmod(f.privateFile, 0o644)],
  ['world-readable public record', f => chmod(f.publicFile, 0o644)],
  ['searchable runtime directory', f => chmod(f.runtime, 0o755)],
  ['group-writable home', f => chmod(f.home, 0o770)],
  ['oversized bootstrap', f => writeFile(f.privateFile, ' '.repeat(4097))],
  ['malformed private JSON', f => writeFile(f.privateFile, `{"secret":"${token}"`)],
  ['missing bootstrap', f => rm(f.privateFile)],
  ['changed public owner', f => writeFile(f.publicFile, JSON.stringify({ ...web, pid: web.pid + 1 }))],
  ['nonregular bootstrap', async f => { await rm(f.privateFile); await mkdir(f.privateFile) }],
  ['symlink bootstrap', async f => { await rm(f.privateFile); await symlink(f.publicFile, f.privateFile) }],
  ['hardlinked bootstrap', f => link(f.privateFile, join(f.home, 'second-link'))],
  ['symlink runtime', async f => {
    await rm(f.runtime, { recursive: true }); await mkdir(join(f.home, 'other'), { mode: 0o700 })
    await symlink(join(f.home, 'other'), f.runtime)
  }],
]) {
  test(`refuses ${name} with a token-free diagnostic`, { skip: process.platform === 'win32' }, async t => {
    const files = await fixture(t)
    await change(files)
    await assert.rejects(discoverRuntime(files.home), error => {
      assert.equal(error.message, 'Start the signed DSH Host runtime, then reopen DSH Desktop.')
      assert.equal(error.message.includes(token), false)
      return true
    })
  })
}
