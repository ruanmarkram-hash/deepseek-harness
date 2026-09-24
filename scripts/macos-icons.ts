/** Deterministic app icons from the unchanged canonical SVG mark and vector labels. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'

const ROOT = resolve(import.meta.dirname, '..')
const ASSET = 'apps/desktop/assets/DeepSeek.icns'
const LABELS = ['HOST', 'DESKTOP', 'MOBILE'] as const
/** Fixed product labels, drawn without platform fonts. */
export type IconLabel = typeof LABELS[number]
// Monoline capitals in a 52 by 84 unit grid. Curves keep small launcher text readable.
const LETTERS: Record<string, string> = {
  H: 'M0 0V84M52 0V84M0 42H52',
  O: 'M26 0C8 0 0 12 0 26V58C0 76 8 84 26 84S52 76 52 58V26C52 12 44 0 26 0Z',
  S: 'M52 10C42 -4 0 -6 0 20C0 48 52 34 52 62C52 90 12 90 0 74',
  T: 'M0 0H52M26 0V84',
  D: 'M0 0V84H22C44 84 52 70 52 42S44 0 22 0Z',
  E: 'M52 0H0V84H52M0 42H43',
  K: 'M0 0V84M52 0L0 46M19 29L52 84',
  P: 'M0 84V0H25C61 0 61 42 25 42H0',
  M: 'M0 84V0L26 42L52 0V84',
  B: 'M0 0V84H26C61 84 61 42 26 42H0M0 0H26C58 0 58 42 26 42',
  I: 'M8 0H44M26 0V84M8 84H44',
  L: 'M0 0V84H52',
}
const TYPES = new Map([
  ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128],
  ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
])

/**
 * Render the unchanged canonical path inside a fixed, centered icon viewport.
 * @param source The repository's trusted, single-path 50-unit SVG mark.
 * @param size Output pixel width and height.
 * @param label Optional app role; omitted below 64 pixels to preserve the small mark.
 * @param opaque Use a full white canvas for the iOS app icon.
 * @returns PNG with a white tile and blue mark; opaque output has no alpha channel.
 */
export async function renderMacOSIcon(source: string, size: number, label?: IconLabel, opaque = false): Promise<Buffer> {
  assert.match(source, /viewBox="0 0 50 50"/)
  const paths = source.match(/<path\b[^>]*\/>/g)
  assert.ok(paths && paths.length === 1, 'canonical SVG must contain exactly one path')
  const path = paths[0]
  assert.ok(path)
  assert.match(path, /fill="#4D6BFE"/)
  const visibleLabel = label && size >= 64
  const lettering = visibleLabel ? label.split('').map((letter, index) =>
    `<path transform="translate(${index * 80} 0)" d="${LETTERS[letter]}"/>`).join('') : ''
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
    ${opaque ? '<rect width="1024" height="1024" fill="#fff"/>' : ''}
    <rect x="64" y="64" width="896" height="896" rx="196" fill="#fff"/>
    <svg x="172" y="${visibleLabel ? 112 : 172}" width="680" height="680" viewBox="0 0 50 50">${path}</svg>
    ${visibleLabel ? `<g transform="translate(${(1024 - (label.length * 80 - 28)) / 2} 775)" fill="none" stroke="#24345C" stroke-width="14" stroke-linecap="round" stroke-linejoin="round">${lettering}</g>` : ''}
  </svg>`
  const raster = sharp(Buffer.from(svg))
  return (opaque ? raster.removeAlpha() : raster).png().toBuffer()
}

/**
 * Package PNG representations for standard and Retina macOS icon sizes.
 * @param source Canonical SVG contents.
 * @param label Optional app role beneath the mark at launcher sizes.
 * @returns An ICNS resource containing every supported representation.
 */
export async function buildMacOSIcon(source: string, label?: IconLabel): Promise<Buffer> {
  const images = new Map<number, Buffer>()
  const chunks: Buffer[] = []
  for (const [type, size] of TYPES) {
    let png = images.get(size)
    if (!png) {
      png = await renderMacOSIcon(source, size, label)
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
  const assets = new Map<string, Buffer>([[ASSET, await buildMacOSIcon(source)]])
  for (const label of ['HOST', 'DESKTOP'] as const) {
    assets.set(`apps/desktop/assets/DeepSeek-${label}.icns`, await buildMacOSIcon(source, label))
  }
  assets.set('apps/mobile/assets/app-icon.png', await renderMacOSIcon(source, 1024, 'MOBILE', true))
  for (const [asset, generated] of assets) {
    if (asset.endsWith('.icns')) await verifyMacOSIcon(generated)
    if (mode === '--write') await writeFile(resolve(ROOT, asset), generated)
    else assert.ok((await readFile(resolve(ROOT, asset))).equals(generated), `${asset} is stale; run pnpm run build:macos-icons`)
  }
  if (mode === '--check') {
    console.log('App icons: canonical artwork and role variants are current')
    return
  }
  const previews = resolve(ROOT, '.dsh-build/icons.noindex')
  await mkdir(previews, { recursive: true })
  const tiles: { input: Buffer; left: number; top: number }[] = []
  for (const [column, label] of LABELS.entries()) {
    const fullSize = await renderMacOSIcon(source, 1024, label, label === 'MOBILE')
    await writeFile(resolve(previews, `${label}-1024.png`), fullSize)
    for (const [row, size] of [128, 64, 32, 16].entries()) {
      // iOS derives every size from its one opaque asset, unlike macOS ICNS representations.
      const input = label === 'MOBILE' ? await sharp(fullSize).resize(size).png().toBuffer() : await renderMacOSIcon(source, size, label)
      await writeFile(resolve(previews, `${label}-${size}.png`), input)
      tiles.push({ input, left: column * 176 + (176 - size) / 2, top: row * 152 + (152 - size) / 2 })
    }
  }
  await sharp({ create: { width: 528, height: 608, channels: 4, background: '#dce2ea' } }).composite(tiles).png().toFile(resolve(previews, 'contact-sheet.png'))
  console.log(`Wrote app icons; previews: ${previews}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
