/** Read the signed Host's private browser bootstrap without starting a runtime. */
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const LIMIT = 4096
const unavailable = () => new Error('Start the signed DSH Host runtime, then reopen DSH Desktop.')
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino

/**
 * Resolve DSH_HOME with the same blank and tilde rules as dsh-home-paths.
 * @param configured - Optional environment override.
 * @param accountHome - Operating-system home directory.
 * @returns The normalized absolute Harness home.
 */
export function resolveDesktopHome(configured, accountHome) {
  const selected = configured?.trim() ? configured : join(accountHome, '.dsh')
  if (selected === '~') return resolve(accountHome)
  if (selected.startsWith('~/') || selected.startsWith('~\\')) return resolve(accountHome, selected.slice(2))
  return resolve(selected)
}

function ownerFile(stat, uid) {
  return stat.isFile() && stat.uid === uid && (stat.mode & 0o7777) === 0o600
    && stat.nlink === 1 && stat.size > 0 && stat.size <= LIMIT
}

async function readRecord(filename, uid) {
  const before = await lstat(filename)
  if (!ownerFile(before, uid)) throw unavailable()
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat()
    if (!ownerFile(opened, uid) || !sameFile(before, opened)) throw unavailable()
    const bytes = Buffer.alloc(LIMIT + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const after = await handle.stat()
    const named = await lstat(filename)
    if (bytesRead !== opened.size || !ownerFile(after, uid) || !ownerFile(named, uid)
      || !sameFile(opened, named) || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw unavailable()
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
  } finally {
    await handle.close()
  }
}

function record(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
    && value.version === 1 && value.profile === 'web'
    && Number.isSafeInteger(value.pid) && value.pid > 0
    && typeof value.startedAt === 'string'
    && Number.isFinite(Date.parse(value.startedAt)) && new Date(value.startedAt).toISOString() === value.startedAt
}

function loopback(origin) {
  const match = typeof origin === 'string' && /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u.exec(origin)
  return !!match && Number(match[1]) <= 65535
}

/**
 * Validate a bootstrap against the separately published Web owner record.
 * @param web - Untrusted public discovery record.
 * @param bootstrap - Untrusted private bootstrap record.
 * @returns The exact authenticated URL, or undefined for an invalid or mixed owner.
 */
export function authenticatedRuntimeUrl(web, bootstrap) {
  if (!record(web, ['version', 'profile', 'url', 'pid', 'startedAt']) || !loopback(web.url)
    || !record(bootstrap, ['version', 'profile', 'origin', 'authenticatedUrl', 'pid', 'startedAt'])
    || bootstrap.origin !== web.url || bootstrap.pid !== web.pid || bootstrap.startedAt !== web.startedAt
    || typeof bootstrap.authenticatedUrl !== 'string') return undefined
  const prefix = `${web.url}/?token=`
  if (!bootstrap.authenticatedUrl.startsWith(prefix)) return undefined
  const token = bootstrap.authenticatedUrl.slice(prefix.length)
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)
    || Buffer.from(token, 'base64url').toString('base64url') !== token) return undefined
  return bootstrap.authenticatedUrl
}

/**
 * Read matching private records under an owner-controlled DSH home. All failures
 * produce one token-free diagnostic; this function never repairs permissions.
 * @param home - Absolute DSH home, not the account home.
 * @returns The authenticated URL of the existing live Web owner.
 */
export async function discoverRuntime(home) {
  try {
    const uid = process.getuid()
    if (await realpath(home) !== resolve(home)) throw unavailable()
    const homeStat = await lstat(home)
    if (!homeStat.isDirectory() || homeStat.uid !== uid || (homeStat.mode & 0o022) !== 0) throw unavailable()
    const directory = join(home, 'runtime')
    const before = await lstat(directory)
    if (!before.isDirectory() || before.uid !== uid || (before.mode & 0o7777) !== 0o700) throw unavailable()
    const web = await readRecord(join(directory, 'web.json'), uid)
    const bootstrap = await readRecord(join(directory, 'web-bootstrap.json'), uid)
    const url = authenticatedRuntimeUrl(web, bootstrap)
    const current = await readRecord(join(directory, 'web.json'), uid)
    const after = await lstat(directory)
    if (url === undefined || authenticatedRuntimeUrl(current, bootstrap) !== url
      || !sameFile(before, after) || !after.isDirectory() || after.uid !== uid
      || (after.mode & 0o7777) !== 0o700) throw unavailable()
    process.kill(web.pid, 0)
    return url
  } catch {
    // Filesystem and parser diagnostics may include private record contents.
    throw unavailable()
  }
}

/**
 * Allow renderer navigation only within the chosen loopback origin, without a
 * reusable bootstrap credential. Only the main process loads the initial URL.
 * @param target - Untrusted renderer or redirect target.
 * @param origin - Exact origin established by private record validation.
 * @returns Whether the target stays within the authenticated Web application.
 */
export function trustedNavigation(target, origin) {
  try {
    const url = new URL(target)
    return loopback(origin) && url.origin === origin && !url.username && !url.password
      && !url.searchParams.has('token')
  } catch {
    // Invalid navigation is refused without displaying its untrusted URL.
    return false
  }
}
