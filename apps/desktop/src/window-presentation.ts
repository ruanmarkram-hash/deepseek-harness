import type { BrowserWindowConstructorOptions } from 'electron'

/** Persisted dimensions and placement for the primary DSH Desktop window. */
export interface DesktopWindowState {
  height: number
  isMaximized: boolean
  width: number
  x?: number
  y?: number
}

/** A display work area used to determine whether saved placement remains visible. */
export interface DesktopDisplayWorkArea {
  height: number
  width: number
  x: number
  y: number
}

const MAX_WINDOW_DIMENSION = 16_384
const MIN_WINDOW_HEIGHT = 640
const MIN_WINDOW_WIDTH = 960

/** Validate the small owned-on-disk state before applying it to a native window. */
export function desktopWindowState(value: unknown): DesktopWindowState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const state = value as Record<string, unknown>
  if (!integerBetween(state.width, MIN_WINDOW_WIDTH, MAX_WINDOW_DIMENSION)
    || !integerBetween(state.height, MIN_WINDOW_HEIGHT, MAX_WINDOW_DIMENSION)
    || typeof state.isMaximized !== 'boolean') return undefined
  if (state.x !== undefined && !integerBetween(state.x, -MAX_WINDOW_DIMENSION, MAX_WINDOW_DIMENSION)) return undefined
  if (state.y !== undefined && !integerBetween(state.y, -MAX_WINDOW_DIMENSION, MAX_WINDOW_DIMENSION)) return undefined
  return {
    height: state.height,
    isMaximized: state.isMaximized,
    width: state.width,
    ...(state.x === undefined ? {} : { x: state.x }),
    ...(state.y === undefined ? {} : { y: state.y }),
  }
}

/**
 * Build the native host presentation without changing the DSH renderer.
 *
 * @param state Last valid persisted window state.
 * @param platform Platform string, injected so host conventions can be tested.
 * @returns BrowserWindow options for a compact, focused work surface.
 */
export function desktopWindowOptions(state: DesktopWindowState | undefined, platform: NodeJS.Platform): BrowserWindowConstructorOptions {
  return {
    backgroundColor: '#181817',
    minHeight: MIN_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    show: false,
    title: 'DSH Desktop',
    ...(platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    ...(state === undefined
      ? { height: 820, width: 1_240 }
      : {
        height: state.height,
        width: state.width,
        ...(state.x === undefined ? {} : { x: state.x }),
        ...(state.y === undefined ? {} : { y: state.y }),
      }),
  }
}

/**
 * Retain saved coordinates only when their window rectangle meets a current display work area.
 *
 * @param state Valid persisted state.
 * @param workAreas Work areas reported by Electron after the app is ready.
 * @returns State with placement coordinates removed when the saved rectangle is off-screen.
 */
export function visibleDesktopWindowState(
  state: DesktopWindowState | undefined,
  workAreas: readonly DesktopDisplayWorkArea[],
): DesktopWindowState | undefined {
  if (state === undefined || (state.x === undefined && state.y === undefined)) return state
  if (state.x === undefined || state.y === undefined) {
    return {
      height: state.height,
      isMaximized: state.isMaximized,
      width: state.width,
    }
  }
  const rectangle: DesktopDisplayWorkArea = {
    height: state.height,
    width: state.width,
    x: state.x,
    y: state.y,
  }
  const isVisible = workAreas.some(area => rectanglesIntersect(rectangle, area))
  if (isVisible) return state
  return {
    height: state.height,
    isMaximized: state.isMaximized,
    width: state.width,
  }
}

/**
 * Capture the placement a non-maximized window should return to on its next launch.
 *
 * @param bounds Current outer bounds.
 * @param normalBounds Bounds Electron retains beneath a maximized window.
 * @param isMaximized Whether the window is currently maximized.
 * @returns Persistable window placement and maximize state.
 */
export function savedDesktopWindowState(
  bounds: DesktopDisplayWorkArea,
  normalBounds: DesktopDisplayWorkArea,
  isMaximized: boolean,
): DesktopWindowState {
  const savedBounds = isMaximized ? normalBounds : bounds
  return {
    height: savedBounds.height,
    isMaximized,
    width: savedBounds.width,
    x: savedBounds.x,
    y: savedBounds.y,
  }
}

/** Test whether a value is an integer in the inclusive supported range. */
function integerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
}

/** Test whether two non-empty outer rectangles overlap. */
function rectanglesIntersect(first: DesktopDisplayWorkArea, second: DesktopDisplayWorkArea): boolean {
  return first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y
}
