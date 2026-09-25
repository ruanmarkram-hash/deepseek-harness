/** Host-attached Electron renderer. The signed native Host alone owns the runtime. */
import { homedir } from 'node:os'
import { app, BrowserWindow, dialog, Menu, session } from 'electron'
import { discoverRuntime, resolveDesktopHome, trustedNavigation } from './runtime-discovery.mjs'

app.setName('DSH Desktop')
let window
let opening = false

async function openWindow() {
  if (opening || window) return
  opening = true
  try {
    const home = resolveDesktopHome(process.env.DSH_HOME, homedir())
    const bootstrap = await discoverRuntime(home)
    const origin = new URL(bootstrap).origin
    const isolated = session.fromPartition('dsh-signed-host-attached')
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    window = new BrowserWindow({
      width: 1440, height: 960, minWidth: 900, minHeight: 600, show: false,
      title: 'DSH Desktop', backgroundColor: '#111111',
      webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false },
    })
    const created = window
    const preventExternal = (event, target) => {
      if (!trustedNavigation(target, origin)) event.preventDefault()
    }
    created.webContents.on('will-navigate', preventExternal)
    created.webContents.on('will-frame-navigate', event => preventExternal(event, event.url))
    created.webContents.on('will-redirect', preventExternal)
    created.webContents.on('will-attach-webview', event => event.preventDefault())
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    created.once('ready-to-show', () => created.show())
    created.once('closed', () => { if (window === created) window = undefined })
    await created.loadURL(bootstrap)
  } catch {
    // Never show loadURL or filesystem errors: they can contain the token.
    dialog.showErrorBox('DSH Desktop could not connect', 'Start the signed DSH Host runtime, then reopen DSH Desktop.')
    app.quit()
  } finally {
    opening = false
  }
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus() })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('activate', () => { void openWindow() })
  void app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]))
    return openWindow()
  })
}
