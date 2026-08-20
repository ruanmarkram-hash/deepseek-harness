import type { MenuItemConstructorOptions } from 'electron'

/**
 * Build native menus that keep common desktop navigation and focus shortcuts discoverable.
 *
 * @param applicationName Product name shown by the macOS application menu.
 * @param platform Platform string, injected so the macOS menu can be tested.
 * @returns Electron menu template without renderer-to-host commands.
 */
export function desktopMenuTemplate(applicationName: string, platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []
  if (platform === 'darwin') {
    template.push({
      label: applicationName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }
  template.push(
    {
      label: 'File',
      submenu: [{ role: 'close' }],
    },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(platform === 'darwin' ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])],
    },
  )
  return template
}
