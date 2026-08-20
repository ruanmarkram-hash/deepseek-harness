const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

/** Parse a DSH runtime URL and reject every non-loopback or non-HTTP origin. */
export function localHarnessUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`DSH Desktop rejected non-local Harness URL ${JSON.stringify(value)}.`)
  }
  return url
}

/** Whether a navigation stays on the local runtime origin that started this window. */
export function trustedRuntimeNavigation(value: string, origin: string): boolean {
  try {
    return new URL(value).origin === origin
  } catch {
    return false
  }
}
