import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { desktopWindowState, type DesktopWindowState } from './window-presentation.js'

const WINDOW_STATE_FILE = 'window-state.json'

/** Load a valid prior primary-window state from Electron user data. */
export function readDesktopWindowState(userDataPath: string): DesktopWindowState | undefined {
  const file = join(userDataPath, WINDOW_STATE_FILE)
  try {
    return desktopWindowState(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) return undefined
    throw error
  }
}

/** Store the owned primary-window state atomically before Electron destroys the window. */
export function writeDesktopWindowState(userDataPath: string, state: DesktopWindowState): void {
  const file = join(userDataPath, WINDOW_STATE_FILE)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, 'utf8')
  renameSync(temporary, file)
}

/** Recognize a non-existent state file without treating other filesystem errors as valid state. */
function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
