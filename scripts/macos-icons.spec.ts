import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { buildMacOSIcon, renderMacOSIcon, verifyMacOSIcon } from './macos-icons.ts'

const root = resolve(import.meta.dirname, '..')
const asset = resolve(root, 'apps/desktop/assets/DeepSeek.icns')

function replaceFirstRepresentation(icon: Buffer, replacement: Buffer): Buffer {
  const header = Buffer.from(icon.subarray(8, 16))
  header.writeUInt32BE(replacement.length + 8, 4)
  const result = Buffer.concat([icon.subarray(0, 8), header, replacement, icon.subarray(8 + icon.readUInt32BE(12))])
  result.writeUInt32BE(result.length, 4)
  return result
}

describe('packaged macOS icons', () => {
  it('ships the canonical mark centered at all standard and Retina resolutions', async () => {
    const source = await readFile(resolve(root, 'website/public/favicon.svg'), 'utf8')
    const committed = await readFile(asset)
    expect(committed.equals(await buildMacOSIcon(source))).toBe(true)
    await verifyMacOSIcon(committed)
  })

  it('rejects the tiny corner mark regression in the actual ICNS payload', async () => {
    const corner = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="white"/><rect width="2" height="2" fill="#4D6BFE"/></svg>')).png().toBuffer()
    await expect(verifyMacOSIcon(replaceFirstRepresentation(await readFile(asset), corner))).rejects.toThrow('mark is too small')
  })

  it('rejects a correctly sized but off-center mark', async () => {
    const shifted = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="10" height="8" fill="#4D6BFE"/></svg>')).png().toBuffer()
    await expect(verifyMacOSIcon(replaceFirstRepresentation(await readFile(asset), shifted))).rejects.toThrow('not centered')
  })

  it('rejects a PNG whose dimensions do not match its ICNS type', async () => {
    const wrongSize = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#4D6BFE' } }).png().toBuffer()
    await expect(verifyMacOSIcon(replaceFirstRepresentation(await readFile(asset), wrongSize))).rejects.toThrow()
  })

  it('rejects missing representations and truncated chunks', async () => {
    const icon = await readFile(asset)
    const missing = Buffer.from(icon.subarray(0, 8 + icon.readUInt32BE(12)))
    missing.writeUInt32BE(missing.length, 4)
    await expect(verifyMacOSIcon(missing)).rejects.toThrow('every normal and Retina size')
    const truncated = Buffer.from(icon.subarray(0, icon.length - 1))
    truncated.writeUInt32BE(truncated.length, 4)
    await expect(verifyMacOSIcon(truncated)).rejects.toThrow('invalid ICNS chunk length')
  })

  it.each(['HOST', 'DESKTOP'] as const)('ships a current %s variant with every representation', async (label) => {
    const source = await readFile(resolve(root, 'website/public/favicon.svg'), 'utf8')
    const committed = await readFile(resolve(root, `apps/desktop/assets/DeepSeek-${label}.icns`))
    expect(committed.equals(await buildMacOSIcon(source, label))).toBe(true)
    await verifyMacOSIcon(committed)
  })

  it.each(['HOST', 'DESKTOP', 'MOBILE'] as const)('keeps %s lettering beneath the whale at launcher sizes', async (label) => {
    const source = await readFile(resolve(root, 'website/public/favicon.svg'), 'utf8')
    for (const size of [64, 128]) {
      const { data, info } = await sharp(await renderMacOSIcon(source, size, label)).raw().toBuffer({ resolveWithObject: true })
      const occupiedColumns = new Set<number>()
      let top = size, bottom = -1
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const offset = (y * size + x) * info.channels
          if (data.readUInt8(offset + 3) > 127 && data.readUInt8(offset) < 100
            && data.readUInt8(offset + 1) < 110 && data.readUInt8(offset + 2) < 150) {
            occupiedColumns.add(x)
            top = Math.min(top, y); bottom = Math.max(bottom, y)
          }
        }
      }
      expect(occupiedColumns.size).toBeGreaterThan(label.length * size / 32)
      expect(top / size).toBeGreaterThan(0.74)
      expect(bottom / size).toBeLessThan(0.86)
      expect((bottom - top + 1) / size).toBeGreaterThan(0.07)
    }
  })

  it.each(['HOST', 'DESKTOP'] as const)('omits %s lettering from tiny macOS representations', async (label) => {
    const source = await readFile(resolve(root, 'website/public/favicon.svg'), 'utf8')
    for (const size of [16, 32]) {
      expect(await renderMacOSIcon(source, size, label)).toEqual(await renderMacOSIcon(source, size))
    }
  })

  it('ships the opaque 1024-pixel Mobile app icon without changing its configured path', async () => {
    const source = await readFile(resolve(root, 'website/public/favicon.svg'), 'utf8')
    const committed = await readFile(resolve(root, 'apps/mobile/assets/app-icon.png'))
    expect(committed).toEqual(await renderMacOSIcon(source, 1024, 'MOBILE', true))
    expect((await sharp(committed).metadata()).hasAlpha).toBe(false)
    const { data, info } = await sharp(committed).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    expect([info.width, info.height]).toEqual([1024, 1024])
    const alpha = data.filter((_, offset) => offset % 4 === 3)
    expect(alpha.every(value => value === 255)).toBe(true)
    expect(await readFile(resolve(root, 'apps/mobile/app.config.ts'), 'utf8')).toContain("icon: './assets/app-icon.png'")
  })

  it('declares and copies the distinct Host icon before signing', async () => {
    const plist = await readFile(resolve(root, 'native/remote-host-app/Resources/Info.plist'), 'utf8')
    const assembly = await readFile(resolve(root, 'native/remote-host-app/scripts/assemble-host-app.sh'), 'utf8')
    expect(plist).toMatch(/<key>CFBundleIconFile<\/key>\s*<string>DeepSeek.icns<\/string>/)
    const copy = assembly.indexOf('cp "$root/../../apps/desktop/assets/DeepSeek-HOST.icns" "$output/Contents/Resources/DeepSeek.icns"')
    expect(copy).toBeGreaterThan(0)
    expect(copy).toBeLessThan(assembly.indexOf('codesign --force --sign "$identity" --identifier com.deepseek.dsh.remote-host-runtime'))
    expect(assembly).toContain('run verify:macos-icons')
  })

  it('packages the Desktop variant into an ignored non-indexed output directory', async () => {
    const config = await readFile(resolve(root, 'native/remote-host-app/desktop-shell/electron-builder.cjs'), 'utf8')
    const ignored = await readFile(resolve(root, 'native/remote-host-app/desktop-shell/.gitignore'), 'utf8')
    expect(config).toContain("icon: join(desktop, 'assets/DeepSeek-DESKTOP.icns')")
    expect(config).toContain("output: join(__dirname, 'release.noindex')")
    expect(ignored.split('\n')).toEqual(expect.arrayContaining(['release/', 'release.noindex/']))
  })

})
