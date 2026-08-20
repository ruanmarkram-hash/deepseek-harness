import { describe, expect, it } from 'vitest'
import { desktopMenuTemplate } from '../src/application-menu.ts'

describe('desktopMenuTemplate', () => {
  it('keeps the macOS application commands and native focus controls available', () => {
    const template = desktopMenuTemplate('DSH Desktop', 'darwin')

    expect(template[0]).toMatchObject({ label: 'DSH Desktop' })
    expect(template.flatMap(item => Array.isArray(item.submenu) ? item.submenu : [])).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'reload' }),
      expect.objectContaining({ role: 'togglefullscreen' }),
      expect.objectContaining({ role: 'zoomIn' }),
    ]))
  })

  it('does not add a macOS application menu on other platforms', () => {
    expect(desktopMenuTemplate('DSH Desktop', 'win32')[0]).toMatchObject({ label: 'File' })
  })
})
