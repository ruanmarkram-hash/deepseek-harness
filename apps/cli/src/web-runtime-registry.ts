/**
 * Loopback Web-runtime discovery record for local product clients.
 *
 * The registry contains only the active Web profile's local endpoint and
 * process ownership facts. It is intentionally not a transport, credential
 * store, or public-address advertisement.
 * @module @deepseek-ai/dsh/web-runtime-registry
 */

import { constants } from 'node:fs'
import { lstat, mkdir, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Current on-disk record version. */
export const WEB_RUNTIME_REGISTRY_VERSION = 1
/** Private runtime directory below one active DSH home. */
export const WEB_RUNTIME_DIRECTORY = 'runtime'
/** Filename of the active Web profile record. */
export const WEB_RUNTIME_FILENAME = 'web.json'
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

async function readBoundedRegularRegistry(filename: string): Promise<BoundedRegistryRead | undefined> {
  const before = await lstat(filename)
  if (!before.isFile() || before.size > WEB_RUNTIME_REGISTRY_MAX_BYTES) return undefined
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
    const content = Buffer.alloc(opened.size)
    const { bytesRead } = await handle.read(content, 0, content.length, 0)
    return bytesRead === content.length
      ? { content: content.toString('utf8'), dev: opened.dev, ino: opened.ino }
      : undefined
  } finally {
    await handle.close()
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
