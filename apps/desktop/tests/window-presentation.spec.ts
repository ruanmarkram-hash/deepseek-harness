import { describe, expect, it } from 'vitest'
import { desktopWindowOptions, desktopWindowState, savedDesktopWindowState, visibleDesktopWindowState } from '../src/window-presentation.ts'

describe('desktopWindowState', () => {
  it('accepts a complete persisted state for the primary native window', () => {
    expect(desktopWindowState({ height: 900, isMaximized: false, width: 1_400, x: 80, y: 60 })).toEqual({
      height: 900,
      isMaximized: false,
      width: 1_400,
      x: 80,
      y: 60,
    })
  })

  it.each([
    { height: 639, isMaximized: false, width: 1_200 },
    { height: 800, isMaximized: 'false', width: 1_200 },
    { height: 800, isMaximized: false, width: 959 },
    { height: 800, isMaximized: false, width: 1_200, x: 1.5 },
  ])('rejects invalid stored state %#', (value) => {
    expect(desktopWindowState(value)).toBeUndefined()
  })
})

describe('desktopWindowOptions', () => {
  it('uses a compact macOS title bar and a focused default working size', () => {
    expect(desktopWindowOptions(undefined, 'darwin')).toMatchObject({
      backgroundColor: '#181817',
      height: 820,
      minHeight: 640,
      minWidth: 960,
      show: false,
      titleBarStyle: 'hiddenInset',
      width: 1_240,
    })
  })

  it('restores valid placement without applying the macOS title bar to other platforms', () => {
    expect(desktopWindowOptions({ height: 900, isMaximized: true, width: 1_400, x: 80, y: 60 }, 'win32')).toMatchObject({
      height: 900,
      width: 1_400,
      x: 80,
      y: 60,
    })
    expect(desktopWindowOptions({ height: 900, isMaximized: true, width: 1_400 }, 'win32')).not.toHaveProperty('titleBarStyle')
  })
})

describe('savedDesktopWindowState', () => {
  it('preserves the normal window placement while the current window is maximized', () => {
    expect(savedDesktopWindowState(
      { height: 1_080, width: 1_920, x: 0, y: 0 },
      { height: 860, width: 1_320, x: 100, y: 80 },
      true,
    )).toEqual({ height: 860, isMaximized: true, width: 1_320, x: 100, y: 80 })
  })
})

describe('visibleDesktopWindowState', () => {
  const state = { height: 860, isMaximized: false, width: 1_320, x: 100, y: 80 }

  it('retains a saved placement when it overlaps a current display work area', () => {
    expect(visibleDesktopWindowState(state, [{ height: 1_080, width: 1_920, x: 0, y: 0 }])).toEqual(state)
  })

  it('drops saved coordinates when no current display work area contains the window', () => {
    expect(visibleDesktopWindowState(state, [{ height: 1_080, width: 1_920, x: 2_000, y: 0 }])).toEqual({
      height: 860,
      isMaximized: false,
      width: 1_320,
    })
  })

  it('drops a partial placement instead of handing Electron an incomplete location', () => {
    expect(visibleDesktopWindowState({ ...state, y: undefined }, [{ height: 1_080, width: 1_920, x: 0, y: 0 }])).toEqual({
      height: 860,
      isMaximized: false,
      width: 1_320,
    })
  })

  it('keeps an off-origin placement visible on a secondary monitor', () => {
    expect(visibleDesktopWindowState({ ...state, x: -1_200 }, [
      { height: 1_080, width: 1_920, x: 0, y: 0 },
      { height: 1_080, width: 1_280, x: -1_280, y: 0 },
    ])).toMatchObject({ x: -1_200, y: 80 })
  })
})
