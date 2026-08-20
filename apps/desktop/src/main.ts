import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { runtimeCommand } from './runtime-command.js'
import { localHarnessUrl, trustedRuntimeNavigation } from './runtime-url.js'
import { desktopWebPreferences } from './window-security.js'

const SOURCE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const READY_URL = /dsh web: (http:\/\/[^\s]+)/u

let window: BrowserWindow | undefined
let runtime: ChildProcess | undefined
let quitting = false
let expectedRuntimeExit = false
let shutdown: Promise<void> | undefined

const RUNTIME_SHUTDOWN_TIMEOUT_MS = 5_000

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
  const trustedOrigin = runtimeUrl.origin
  window = new BrowserWindow({
    minHeight: 640,
    minWidth: 960,
    title: 'DSH Desktop',
    webPreferences: desktopWebPreferences,
  })
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
  window.once('closed', () => {
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

void app.whenReady().then(openHarnessWindow).catch(showStartupFailure)
