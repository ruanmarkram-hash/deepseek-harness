/**
 * Read a UTF-8 request body without buffering past its fixed byte limit.
 *
 * @param request - Request whose body is consumed at most once.
 * @param maxBytes - Maximum accepted encoded body length.
 * @returns Decoded body text, or `undefined` for an invalid or oversized body.
 */
export async function boundedTextBody(request: Request, maxBytes: number): Promise<string | undefined> {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maxBytes)) return undefined
  if (request.body === null) return ''

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      const chunk: unknown = next.value
      if (!(chunk instanceof Uint8Array)) {
        await reader.cancel('body-not-bytes')
        return undefined
      }
      size += chunk.byteLength
      if (size > maxBytes) {
        await reader.cancel('body-too-large')
        return undefined
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    return undefined
  }
}
