import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, shell } from 'electron'
import { desktopMenuTemplate } from './application-menu.js'
import { LocalSessionApi } from './local-session-api.js'
import { DesktopMobileTransport, type DesktopMobileTransportState } from './mobile-live-transport.js'
import { DesktopPairingBridge } from './mobile-pairing.js'
import { trustedDesktopRelayOrigin } from './mobile-relay-config.js'
import { PairingSessionPicker } from './pairing-session-picker.js'
import { pairingWindowDocument, pairingWindowOptions, trustedPairingNavigation } from './pairing-window.js'
import { runtimeCommand } from './runtime-command.js'
import { localHarnessUrl, trustedRuntimeNavigation } from './runtime-url.js'
import { desktopWebPreferences } from './window-security.js'
import { desktopWindowOptions, savedDesktopWindowState, type DesktopWindowState, visibleDesktopWindowState } from './window-presentation.js'
import { readDesktopWindowState, writeDesktopWindowState } from './window-state.js'

const SOURCE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const READY_URL = /dsh web: (http:\/\/[^\s]+)/u
const APPLICATION_NAME = 'DSH Desktop'

let window: BrowserWindow | undefined
let runtime: ChildProcess | undefined
let quitting = false
let expectedRuntimeExit = false
let shutdown: Promise<void> | undefined
let persistedWindowState: DesktopWindowState | undefined
let pairingWindow: BrowserWindow | undefined
let mobileTransport: DesktopMobileTransport | undefined
const sessionPicker = new PairingSessionPicker()

const RUNTIME_SHUTDOWN_TIMEOUT_MS = 5_000

function pickerId(): string {
  return `dshpicker_${randomBytes(16).toString('base64url')}`
}

/** Load the repository's canonical DeepSeek mark for every desktop-owned surface. */
function desktopMarkPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'dsh-icon.svg')
    : join(SOURCE_ROOT, 'website/public/favicon.svg')
}

function desktopMark(): Electron.NativeImage {
  return nativeImage.createFromPath(desktopMarkPath())
}

function desktopMarkDataUrl(): string {
  return `data:image/svg+xml;base64,${readFileSync(desktopMarkPath()).toString('base64')}`
}

function publishMobileState(state: DesktopMobileTransportState): void {
  pairingWindow?.webContents.send('dsh-pairing:state', state)
}

function showMobileDialog(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const parent = pairingWindow ?? window
  return parent === undefined ? dialog.showMessageBox(options) : dialog.showMessageBox(parent, options)
}

function approveMobilePairing(): Promise<boolean> {
  return showMobileDialog({
    type: 'question',
    buttons: ['Reject', 'Allow'],
    defaultId: 0,
    cancelId: 0,
    message: 'Allow this phone to pair with DSH?',
    detail: 'It can view one text-only session and request queued text prompts. It cannot access tools, files, credentials, settings, or computer use.',
  }).then(result => result.response === 1)
}

function approveMobilePrompt(text: string): Promise<boolean> {
  const preview = text.length > 1_024 ? `${text.slice(0, 1_024)}…` : text
  return showMobileDialog({
    type: 'question',
    buttons: ['Reject', 'Send'],
    defaultId: 0,
    cancelId: 0,
    message: 'Send this mobile prompt to DSH?',
    detail: preview,
  }).then(result => result.response === 1)
}

function createMobileTransport(runtimeUrl: URL): DesktopMobileTransport {
  return new DesktopMobileTransport(
    new DesktopPairingBridge({ relayBaseUrl: trustedDesktopRelayOrigin() }),
    new LocalSessionApi(runtimeUrl),
    {
      approvePairing: () => approveMobilePairing(),
      approvePrompt: text => approveMobilePrompt(text),
    },
    undefined,
    publishMobileState,
  )
}

async function openMobilePairing(): Promise<void> {
  if (window === undefined) return
  if (pairingWindow !== undefined) {
    pairingWindow.focus()
    return
  }
  try {
    mobileTransport ??= createMobileTransport(localHarnessUrl(window.webContents.getURL()))
  } catch (error) {
    dialog.showErrorBox('DSH Mobile pairing unavailable', error instanceof Error ? error.message : 'DSH Desktop could not prepare mobile pairing.')
    return
  }
  const pairing = new BrowserWindow(pairingWindowOptions(window))
  const transport = mobileTransport
  pairingWindow = pairing
  sessionPicker.open(pairing, transport)
  pairing.once('ready-to-show', () => { pairing.show() })
  pairing.once('closed', () => {
    sessionPicker.close(pairing)
    if (pairingWindow !== pairing) return
    pairingWindow = undefined
    if (mobileTransport === transport) {
      mobileTransport.close()
      mobileTransport = undefined
    }
  })
  const pairingUrl = `data:text/html;charset=utf-8,${encodeURIComponent(pairingWindowDocument(desktopMarkDataUrl()))}`
  const preventPairingNavigation = (event: Electron.Event, target: string): void => {
    if (!trustedPairingNavigation(target, pairingUrl)) event.preventDefault()
  }
  pairing.webContents.on('will-navigate', preventPairingNavigation)
  pairing.webContents.on('will-redirect', preventPairingNavigation)
  pairing.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  await pairing.loadURL(pairingUrl)
}

ipcMain.handle('dsh-pairing:sessions', async (event) => {
  const transport = mobileTransport
  const pairing = pairingWindow
  if (transport === undefined || pairing === undefined || event.sender !== pairing.webContents) throw new Error('DSH Desktop pairing is unavailable.')
  return sessionPicker.list(pairing, transport, pickerId)
})

ipcMain.handle('dsh-pairing:start', async (event, selection: unknown) => {
  const transport = mobileTransport
  const pairing = pairingWindow
  if (transport === undefined || pairing === undefined || event.sender !== pairing.webContents) throw new Error('DSH Desktop pairing is unavailable.')
  const session = sessionPicker.take(pairing, transport, selection)
  if (session === undefined) throw new Error('DSH Desktop rejected the session selection.')
  return transport.start(session)
})

ipcMain.handle('dsh-pairing:close', (event) => {
  const pairing = pairingWindow
  if (pairing === undefined || event.sender !== pairing.webContents) throw new Error('DSH Desktop pairing is unavailable.')
  pairing.close()
})

/** Resolve whether the runtime exits before the graceful-shutdown timeout. */
function exitsGracefully(exited: Promise<void>): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(false)
    }, RUNTIME_SHUTDOWN_TIMEOUT_MS)
    void exited.then(() => {
      clearTimeout(timeout)
      resolve(true)
    })
  })
}

/** Resolve the local Harness process without accepting a renderer-provided executable path. */
/** Start the bundled development runtime and resolve when its local URL is published. */
function startRuntime(): Promise<URL> {
  expectedRuntimeExit = false
  const command = runtimeCommand({
    appDataPath: app.getPath('userData'),
    executablePath: process.execPath,
    inheritedEnv: process.env,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    runtimeOverride: process.env.DSH_DESKTOP_RUNTIME,
    sourceRoot: SOURCE_ROOT,
  })
  const child = spawn(command.command, [...command.args], {
    cwd: command.cwd,
    env: command.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runtime = child

  return new Promise<URL>((resolve, reject) => {
    let output = ''
    let settled = false
    const settle = (callback: () => void): void => {
      if (settled) return
      settled = true
      callback()
    }
    const inspect = (chunk: Buffer): void => {
      output = `${output}${chunk.toString('utf8')}`.slice(-16_384)
      const match = READY_URL.exec(output)
      if (match?.[1] === undefined) return
      try {
        settle(() => {
          resolve(localHarnessUrl(match[1]))
        })
      } catch (error) {
        settle(() => {
          reject(error instanceof Error ? error : new Error(String(error)))
        })
      }
    }
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    child.once('error', (error) => {
      settle(() => {
        reject(error)
      })
    })
    child.once('exit', (code, signal) => {
      if (!settled) {
        settle(() => {
          reject(new Error(`Harness exited before it was ready (code ${String(code)}, signal ${String(signal)}).`))
        })
      }
      else if (!quitting && !expectedRuntimeExit) {
        window?.destroy()
        dialog.showErrorBox('DSH Desktop stopped', 'The local DeepSeek Harness runtime exited. Reopen DSH Desktop to start a new session.')
      }
    })
  })
}

/** Open the local DSH client with renderer-to-host privileges disabled. */
async function openHarnessWindow(): Promise<void> {
  await shutdown
  const runtimeUrl = await startRuntime()
  sessionPicker.close()
  pairingWindow?.close()
  mobileTransport?.close()
  mobileTransport = undefined
  const trustedOrigin = runtimeUrl.origin
  window = new BrowserWindow({
    ...desktopWindowOptions(persistedWindowState, process.platform),
    icon: desktopMark(),
    webPreferences: desktopWebPreferences,
  })
  if (persistedWindowState?.isMaximized) window.maximize()
  const preventExternalNavigation = (event: Electron.Event, target: string): void => {
    if (!trustedRuntimeNavigation(target, trustedOrigin)) event.preventDefault()
  }
  window.webContents.on('will-navigate', preventExternalNavigation)
  window.webContents.on('will-redirect', preventExternalNavigation)
  window.webContents.setWindowOpenHandler(({ url }) => {
    const target = new URL(url)
    if (target.protocol === 'https:' || target.protocol === 'mailto:') void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.once('ready-to-show', () => {
    window?.show()
  })
  window.on('close', () => {
    const target = window
    if (target === undefined) return
    persistedWindowState = savedDesktopWindowState(target.getBounds(), target.getNormalBounds(), target.isMaximized())
    try {
      writeDesktopWindowState(app.getPath('userData'), persistedWindowState)
    } catch (error) {
      console.error('DSH Desktop could not save its window placement.', error)
    }
  })
  window.once('closed', () => {
    pairingWindow?.close()
    window = undefined
    void stopRuntime()
  })
  await window.loadURL(runtimeUrl.toString())
}

/** Wait for a child exit, escalating after a bounded graceful-shutdown window. */
async function stopRuntime(): Promise<void> {
  if (shutdown !== undefined) {
    await shutdown
    return
  }
  const child = runtime
  if (child === undefined) return
  expectedRuntimeExit = true
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve()
      })
    })
  shutdown = (async () => {
    child.kill('SIGTERM')
    const graceful = await exitsGracefully(exited)
    if (!graceful && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    if (runtime === child) runtime = undefined
  })().finally(() => {
    shutdown = undefined
  })
  await shutdown
}

app.on('before-quit', () => {
  quitting = true
})
app.on('before-quit', (event) => {
  if (runtime === undefined) return
  event.preventDefault()
  void stopRuntime().then(() => {
    app.quit()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void openHarnessWindow().catch(showStartupFailure)
})

function showStartupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  dialog.showErrorBox('DSH Desktop could not start', message)
  app.quit()
}

void app.whenReady().then(() => {
  app.setName(APPLICATION_NAME)
  if (process.platform === 'darwin') app.dock?.setIcon(desktopMark())
  persistedWindowState = visibleDesktopWindowState(readDesktopWindowState(app.getPath('userData')), screen.getAllDisplays().map(({ workArea }) => workArea))
  Menu.setApplicationMenu(Menu.buildFromTemplate(
    desktopMenuTemplate(APPLICATION_NAME, process.platform, () => { void openMobilePairing() }),
  ))
  return openHarnessWindow()
}).catch(showStartupFailure)
