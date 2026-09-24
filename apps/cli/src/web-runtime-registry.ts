/**
 * Loopback Web-runtime discovery record for local product clients.
 *
 * The registry contains only the active Web profile's local endpoint and
 * process ownership facts. It is intentionally not a transport, credential
 * store, or public-address advertisement.
 * @module @deepseek-ai/dsh/web-runtime-registry
 */

import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Current on-disk record version. */
export const WEB_RUNTIME_REGISTRY_VERSION = 1
/** Private runtime directory below one active DSH home. */
export const WEB_RUNTIME_DIRECTORY = 'runtime'
/** Filename of the active Web profile record. */
export const WEB_RUNTIME_FILENAME = 'web.json'
/** Owner-only browser launch capability, separate from noncredential discovery. */
export const WEB_RUNTIME_BOOTSTRAP_FILENAME = 'web-bootstrap.json'
/** Maximum bytes accepted from the durable discovery record. */
const WEB_RUNTIME_REGISTRY_MAX_BYTES = 4 * 1024

/** Test hook for replacing the record after its pre-open file-kind check. */
export const internals: { afterRegistryLstat: () => void } = {
  afterRegistryLstat: () => {},
}

/** Exact local Web-runtime facts a desktop client may discover. */
export interface WebRuntimeRegistryRecord {
  /** Version of this JSON record. */
  version: typeof WEB_RUNTIME_REGISTRY_VERSION
  /** Profile that owns this record. */
  profile: 'web'
  /** Exact canonical loopback URL of the bound Web server. */
  url: string
  /** Process that published the current record. */
  pid: number
  /** ISO-8601 instant at which this process published the record. */
  startedAt: string
}

/** Private browser launch capability bound to one exact published runtime. */
export interface WebRuntimeBootstrapRecord {
  /** Exact private record schema version. */
  version: typeof WEB_RUNTIME_REGISTRY_VERSION
  /** The only browser-serving profile supported by this local bootstrap. */
  profile: 'web'
  /** Canonical loopback origin matching the public registry URL exactly. */
  origin: string
  /** Secret-bearing root URL used only for the upstream browser cookie exchange. */
  authenticatedUrl: string
  /** Publisher identity matching current discovery. */
  pid: number
  /** Publisher start instant matching current discovery. */
  startedAt: string
}

/** Inputs supplied by the Web profile after its server has bound. */
export interface PublishWebRuntimeRegistryOptions {
  /** Active Harness home; defaults to the resolved `$DSH_HOME`. */
  home?: string
  /** Exact loopback URL of the bound server. */
  url: string
  /** Publishing process id; defaults to the current process. */
  pid?: number
  /** Publishing instant; defaults to the current instant. */
  startedAt?: Date
}

/** Path of the Web registry under one resolved DSH home. */
export function webRuntimeRegistryPath(home = resolveDshHome()): string {
  return join(home, WEB_RUNTIME_DIRECTORY, WEB_RUNTIME_FILENAME)
}

/**
 * Resolve the private browser bootstrap record under one Harness home.
 * @param home - Resolved Harness home.
 * @returns the owner-only capability file path.
 */
export function webRuntimeBootstrapPath(home = resolveDshHome()): string {
  return join(home, WEB_RUNTIME_DIRECTORY, WEB_RUNTIME_BOOTSTRAP_FILENAME)
}

/** Validate the exact upstream root token exchange without accepting additional URL inputs. */
function isBootstrapUrl(value: unknown, origin: string): value is string {
  if (typeof value !== 'string' || !value.startsWith(`${origin}/?token=`)) return false
  const token = value.slice(`${origin}/?token=`.length)
  return /^[A-Za-z0-9_-]{43}$/.test(token)
    && Buffer.from(token, 'base64url').byteLength === 32
    && Buffer.from(token, 'base64url').toString('base64url') === token
}

/**
 * Parse a bounded private launch record and correlate it with current discovery.
 * @param input - Untrusted file content, never logged on rejection.
 * @param owner - Current noncredential discovery record.
 * @returns the matching launch capability, or undefined for any mismatch.
 */
export function parseWebRuntimeBootstrap(input: string, owner: WebRuntimeRegistryRecord): WebRuntimeBootstrapRecord | undefined {
  if (Buffer.byteLength(input) > WEB_RUNTIME_REGISTRY_MAX_BYTES) return undefined
  let value: unknown
  try { value = JSON.parse(input) } catch { return undefined }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 6
    || !Object.keys(record).every(key => ['version', 'profile', 'origin', 'authenticatedUrl', 'pid', 'startedAt'].includes(key))
    || record.version !== WEB_RUNTIME_REGISTRY_VERSION || record.profile !== 'web'
    || !isLoopbackWebUrl(record.origin) || record.origin !== owner.url
    || !isPid(record.pid) || record.pid !== owner.pid
    || !isStartedAt(record.startedAt) || record.startedAt !== owner.startedAt
    || !isBootstrapUrl(record.authenticatedUrl, record.origin)) return undefined
  return { version: WEB_RUNTIME_REGISTRY_VERSION, profile: 'web', origin: record.origin,
    authenticatedUrl: record.authenticatedUrl, pid: record.pid, startedAt: record.startedAt }
}

/** Whether a URL is the sole local URL the registry may carry. */
function isLoopbackWebUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u.exec(value)
  return match !== null && Number(match[1]) <= 65_535
}

/** Whether a value is a finite positive integer process id. */
function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Whether a value is the canonical ISO instant emitted by `Date#toISOString`. */
function isStartedAt(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const instant = new Date(value)
  return !Number.isNaN(instant.valueOf()) && instant.toISOString() === value
}

/** Parse one untrusted durable registry record, rejecting extra fields. */
export function parseWebRuntimeRegistry(input: string): WebRuntimeRegistryRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(input)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 5 || !keys.every(key => ['version', 'profile', 'url', 'pid', 'startedAt'].includes(key))) return undefined
  if (record.version !== WEB_RUNTIME_REGISTRY_VERSION
    || record.profile !== 'web'
    || !isLoopbackWebUrl(record.url)
    || !isPid(record.pid)
    || !isStartedAt(record.startedAt)) return undefined
  return {
    version: WEB_RUNTIME_REGISTRY_VERSION,
    profile: 'web',
    url: record.url,
    pid: record.pid,
    startedAt: record.startedAt,
  }
}

/** Build the complete durable record for one bound Web server. */
function createRecord(options: PublishWebRuntimeRegistryOptions): WebRuntimeRegistryRecord {
  if (!isLoopbackWebUrl(options.url)) {
    throw new Error('dsh web runtime registry: only an exact 127.0.0.1 URL may be published')
  }
  const pid = options.pid ?? process.pid
  if (!isPid(pid)) throw new Error('dsh web runtime registry: pid must be a positive safe integer')
  const startedAt = (options.startedAt ?? new Date()).toISOString()
  return {
    version: WEB_RUNTIME_REGISTRY_VERSION,
    profile: 'web',
    url: options.url,
    pid,
    startedAt,
  }
}

/** Compare the complete owner identity rather than a reusable process id alone. */
function owns(record: WebRuntimeRegistryRecord, owner: WebRuntimeRegistryRecord): boolean {
  return record.pid === owner.pid && record.startedAt === owner.startedAt
}

/**
 * Read one small regular registry file without following a replaced symlink
 * or waiting on a special file. The pre-open lstat and descriptor fstat must
 * identify the same regular inode before its bounded payload is read.
 */
interface BoundedRegistryRead {
  content: string
  dev: number
  ino: number
}

async function readBoundedRegularRegistry(filename: string, privateFile = false): Promise<BoundedRegistryRead | undefined> {
  const before = await lstat(filename)
  if (!before.isFile() || before.size > WEB_RUNTIME_REGISTRY_MAX_BYTES) return undefined
  if (privateFile && (before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600)) return undefined
  internals.afterRegistryLstat()
  let handle
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ELOOP') return undefined
    throw error
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile()
      || opened.size > WEB_RUNTIME_REGISTRY_MAX_BYTES
      || opened.dev !== before.dev
      || opened.ino !== before.ino) return undefined
    if (privateFile && (opened.uid !== process.getuid?.() || (opened.mode & 0o777) !== 0o600)) return undefined
    const content = Buffer.alloc(opened.size)
    const { bytesRead } = await handle.read(content, 0, content.length, 0)
    return bytesRead === content.length
      ? { content: content.toString('utf8'), dev: opened.dev, ino: opened.ino }
      : undefined
  } finally {
    await handle.close()
  }
}

/** Require a same-user, non-symlink home and private runtime directory before touching launch capabilities. */
async function assertPrivateRuntimeDirectory(home: string): Promise<void> {
  const root = await lstat(home)
  const runtime = await lstat(join(home, WEB_RUNTIME_DIRECTORY))
  const uid = process.getuid?.()
  if (uid === undefined || await realpath(home) !== resolve(home)
    || !root.isDirectory() || root.uid !== uid || (root.mode & 0o022) !== 0
    || !runtime.isDirectory() || runtime.uid !== uid || (runtime.mode & 0o777) !== 0o700) {
    throw new Error('dsh web bootstrap: runtime directory must be private and owned by the current user')
  }
}

/**
 * Publish the current runtime's browser launch capability in an owner-only atomic record.
 * @param owner - Previously published current runtime record.
 * @param authenticatedUrl - URL returned by Connection.authenticatedUrl for this owner.
 * @param home - Resolved Harness home containing the private runtime directory.
 * @returns the published capability; unsafe paths and stale owners fail without publication.
 */
export async function publishWebRuntimeBootstrap(
  owner: WebRuntimeRegistryRecord, authenticatedUrl: string, home = resolveDshHome(),
): Promise<WebRuntimeBootstrapRecord> {
  const record = parseWebRuntimeBootstrap(JSON.stringify({ version: WEB_RUNTIME_REGISTRY_VERSION, profile: 'web',
    origin: owner.url, authenticatedUrl, pid: owner.pid, startedAt: owner.startedAt }), owner)
  if (record === undefined) throw new Error('dsh web bootstrap: invalid runtime launch capability')
  await assertPrivateRuntimeDirectory(home)
  return withFileLock(webRuntimeRegistryPath(home), async () => {
    await assertPrivateRuntimeDirectory(home)
    const existing = await readBoundedRegularRegistry(webRuntimeRegistryPath(home), true)
    const current = existing === undefined ? undefined : parseWebRuntimeRegistry(existing.content)
    if (current === undefined || !owns(current, owner) || current.url !== owner.url) {
      throw new Error('dsh web bootstrap: runtime discovery owner no longer matches')
    }
    const filename = webRuntimeBootstrapPath(home)
    try {
      if (await readBoundedRegularRegistry(filename, true) === undefined) {
        throw new Error('dsh web bootstrap: existing capability file is unsafe')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await writeFileAtomic(filename, `${JSON.stringify(record)}\n`, { mode: 0o600, dirMode: 0o700 })
    return record
  })
}

/**
 * Remove only a private bootstrap capability matching the retiring runtime.
 * @param owner - Exact runtime identity whose capability may be removed.
 * @param home - Resolved Harness home containing the private runtime directory.
 * @returns whether the matching regular file was removed; newer capabilities remain intact.
 */
export async function removeOwnedWebRuntimeBootstrap(
  owner: WebRuntimeRegistryRecord, home = resolveDshHome(),
): Promise<boolean> {
  try {
    await assertPrivateRuntimeDirectory(home)
    return await withFileLock(webRuntimeRegistryPath(home), async () => {
      await assertPrivateRuntimeDirectory(home)
      const filename = webRuntimeBootstrapPath(home)
      const existing = await readBoundedRegularRegistry(filename, true)
      if (existing === undefined || parseWebRuntimeBootstrap(existing.content, owner) === undefined) return false
      const current = await lstat(filename)
      if (!current.isFile() || current.dev !== existing.dev || current.ino !== existing.ino) return false
      await unlink(filename)
      return true
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Publish one private, atomically replaced Web runtime record. */
export async function publishWebRuntimeRegistry(options: PublishWebRuntimeRegistryOptions): Promise<WebRuntimeRegistryRecord> {
  const record = createRecord(options)
  const home = options.home ?? resolveDshHome()
  const filename = webRuntimeRegistryPath(home)
  await mkdir(join(home, WEB_RUNTIME_DIRECTORY), { recursive: true, mode: 0o700 })
  await withFileLock(filename, async () => {
    await writeFileAtomic(filename, `${JSON.stringify(record)}\n`, { mode: 0o600, dirMode: 0o700 })
  })
  return record
}

/**
 * Remove the Web record only when it is still the record this process
 * published. A newer `dsh web` invocation always wins a shared DSH home.
 */
export async function removeOwnedWebRuntimeRegistry(
  owner: WebRuntimeRegistryRecord,
  home = resolveDshHome(),
): Promise<boolean> {
  const filename = webRuntimeRegistryPath(home)
  try {
    return await withFileLock(filename, async () => {
      let existing: BoundedRegistryRead | undefined
      try {
        existing = await readBoundedRegularRegistry(filename)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
      if (existing === undefined) return false
      const record = parseWebRuntimeRegistry(existing.content)
      if (record === undefined || !owns(record, owner)) return false
      const current = await lstat(filename)
      if (!current.isFile() || current.dev !== existing.dev || current.ino !== existing.ino) return false
      await unlink(filename)
      return true
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
