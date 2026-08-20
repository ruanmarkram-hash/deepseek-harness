import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readDesktopWindowState, writeDesktopWindowState } from '../src/window-state.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

/** Create an isolated user-data directory for a state-file test. */
function temporaryUserDataDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-desktop-state-'))
  directories.push(directory)
  return directory
}

describe('desktop window state persistence', () => {
  it('restores only the native window state it wrote', () => {
    const userDataPath = temporaryUserDataDirectory()
    writeDesktopWindowState(userDataPath, { height: 900, isMaximized: true, width: 1_400, x: 80, y: 60 })

    expect(readDesktopWindowState(userDataPath)).toEqual({ height: 900, isMaximized: true, width: 1_400, x: 80, y: 60 })
  })

  it('ignores a malformed file instead of passing it to BrowserWindow', () => {
    const userDataPath = temporaryUserDataDirectory()
    writeFileSync(join(userDataPath, 'window-state.json'), '{not-json', 'utf8')

    expect(readDesktopWindowState(userDataPath)).toBeUndefined()
  })
})
