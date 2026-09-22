/** Deterministic shared macOS icon packaging from the canonical SVG mark. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'

const ROOT = resolve(import.meta.dirname, '..')
const ASSET = 'apps/desktop/assets/DeepSeek.icns'
const TYPES = new Map([
  ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128],
  ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
])

/**
 * Render the unchanged canonical path inside a fixed, centered icon viewport.
 * @param source The repository's trusted, single-path 50-unit SVG mark.
 * @param size Output pixel width and height.
 * @returns RGBA PNG with a white rounded tile and blue mark.
 */
export async function renderMacOSIcon(source: string, size: number): Promise<Buffer> {
  assert.match(source, /viewBox="0 0 50 50"/)
  const paths = source.match(/<path\b[^>]*\/>/g)
  assert.ok(paths && paths.length === 1, 'canonical SVG must contain exactly one path')
  const path = paths[0]
  assert.ok(path)
  assert.match(path, /fill="#4D6BFE"/)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
    <rect x="64" y="64" width="896" height="896" rx="196" fill="#fff"/>
    <svg x="172" y="172" width="680" height="680" viewBox="0 0 50 50">${path}</svg>
  </svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

/**
 * Package PNG representations for standard and Retina macOS icon sizes.
 * @param source Canonical SVG contents.
 * @returns An ICNS resource containing every supported representation.
 */
export async function buildMacOSIcon(source: string): Promise<Buffer> {
  const images = new Map<number, Buffer>()
  const chunks: Buffer[] = []
  for (const [type, size] of TYPES) {
    let png = images.get(size)
    if (!png) {
      png = await renderMacOSIcon(source, size)
      images.set(size, png)
    }
    const header = Buffer.alloc(8)
    header.write(type)
    header.writeUInt32BE(png.length + 8, 4)
    chunks.push(header, png)
  }
  const header = Buffer.alloc(8)
  header.write('icns')
  header.writeUInt32BE(chunks.reduce((sum, chunk) => sum + chunk.length, 8), 4)
  return Buffer.concat([header, ...chunks])
}

/**
 * Reject missing sizes, malformed chunks, or a tiny/off-center mark in an ICNS.
 * @param icon Packaged ICNS bytes, not a separate preview image.
 */
export async function verifyMacOSIcon(icon: Buffer): Promise<void> {
  assert.equal(icon.toString('ascii', 0, 4), 'icns')
  assert.equal(icon.readUInt32BE(4), icon.length)
  const seen = new Set<string>()
  let offset = 8
  while (offset < icon.length) {
    assert.ok(offset + 8 <= icon.length, 'truncated ICNS chunk header')
    const type = icon.toString('ascii', offset, offset + 4)
    const length = icon.readUInt32BE(offset + 4)
    const size = TYPES.get(type)
    assert.ok(size !== undefined && !seen.has(type), `unexpected ICNS representation ${type}`)
    assert.ok(length > 8 && offset + length <= icon.length, 'invalid ICNS chunk length')
    const { data, info } = await sharp(icon.subarray(offset + 8, offset + length))
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    assert.equal(info.width, size)
    assert.equal(info.height, size)
    assert.equal(info.channels, 4)
    let left = size, right = -1, top = size, bottom = -1, count = 0
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4
        if (data.readUInt8(i + 3) > 127 && data.readUInt8(i + 2) > 190 && data.readUInt8(i) < 170 && data.readUInt8(i + 1) < 190) {
          left = Math.min(left, x); right = Math.max(right, x)
          top = Math.min(top, y); bottom = Math.max(bottom, y)
          count++
        }
      }
    }
    assert.ok(count / (size * size) > 0.10, `${type}: blue mark is too small or absent`)
    assert.ok((right - left + 1) / size > 0.55, `${type}: mark width is too small`)
    assert.ok((bottom - top + 1) / size > 0.40, `${type}: mark height is too small`)
    assert.ok(Math.abs((left + right + 1) / (2 * size) - 0.5) < 0.06, `${type}: mark is not centered horizontally`)
    assert.ok(Math.abs((top + bottom + 1) / (2 * size) - 0.5) < 0.06, `${type}: mark is not centered vertically`)
    assert.ok(left / size > 0.10 && top / size > 0.10 && right / size < 0.90 && bottom / size < 0.90, `${type}: mark lacks padding`)
    assert.equal(data[3], 0, `${type}: rounded tile must have transparent corners`)
    seen.add(type)
    offset += length
  }
  assert.deepEqual([...seen], [...TYPES.keys()], 'ICNS must contain every normal and Retina size')
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  assert.ok(process.argv.length === 3 && (mode === '--write' || mode === '--check'), 'usage: macos-icons.ts --write|--check')
  const source = await readFile(resolve(ROOT, 'website/public/favicon.svg'), 'utf8')
  const generated = await buildMacOSIcon(source)
  await verifyMacOSIcon(generated)
  if (mode === '--write') {
    await writeFile(resolve(ROOT, ASSET), generated)
    const previews = resolve(ROOT, '.dsh-build/icons.noindex')
    await mkdir(previews, { recursive: true })
    await writeFile(resolve(previews, 'DeepSeek.png'), await renderMacOSIcon(source, 1024))
    console.log(`Wrote ${ASSET}; preview: ${previews}/DeepSeek.png`)
  } else {
    const committed = await readFile(resolve(ROOT, ASSET))
    await verifyMacOSIcon(committed)
    assert.ok(committed.equals(generated), 'macOS icon is stale; run pnpm run build:macos-icons')
    console.log('macOS icon: all 11 representations are current, centered and readable')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
