import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { buildMacOSIcon, verifyMacOSIcon } from './macos-icons.ts'

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

  it('declares and copies the shared Host icon before signing', async () => {
    const plist = await readFile(resolve(root, 'native/remote-host-app/Resources/Info.plist'), 'utf8')
    const assembly = await readFile(resolve(root, 'native/remote-host-app/scripts/assemble-host-app.sh'), 'utf8')
    expect(plist).toMatch(/<key>CFBundleIconFile<\/key>\s*<string>DeepSeek.icns<\/string>/)
    const copy = assembly.indexOf('cp "$root/../../apps/desktop/assets/DeepSeek.icns" "$output/Contents/Resources/DeepSeek.icns"')
    expect(copy).toBeGreaterThan(0)
    expect(copy).toBeLessThan(assembly.indexOf('codesign --force --sign "$identity" --identifier com.deepseek.dsh.remote-host-runtime'))
    expect(assembly).toContain('run verify:macos-icons')
  })

  it('keeps the native bundle icon instead of overriding it with an SVG NativeImage', async () => {
    const main = await readFile(resolve(root, 'apps/desktop/src/main.ts'), 'utf8')
    expect(main).not.toContain('nativeImage')
    expect(main).not.toContain('dock?.setIcon')
    expect(main).toContain('data:image/svg+xml;base64,')
  })
})
