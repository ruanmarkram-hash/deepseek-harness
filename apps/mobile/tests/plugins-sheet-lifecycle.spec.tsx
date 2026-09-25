// @vitest-environment jsdom
import { createRequire } from 'node:module'
import { act, createElement, forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

const platform = vi.hoisted(() => ({
  onState: undefined as ((state: { readonly kind: 'connected'; readonly connectionEpoch: number }) => void) | undefined,
  request: vi.fn(),
}))

vi.mock('expo-status-bar', () => ({ StatusBar: () => null }))
vi.mock('expo-camera', () => ({ CameraView: () => null, useCameraPermissions: () => [undefined, vi.fn()] }))
vi.mock('expo-crypto', () => ({ getRandomValues: (bytes: Uint8Array) => bytes.fill(7) }))
vi.mock('../native-identity', () => ({
  nativeMobileIdentityProvider: {},
  nativeMobileRemoteStateStore: { resetCursorForFreshProjection: async () => undefined },
}))
vi.mock('../mobile-remote-socket', () => ({ mobileRemoteSocketFactory: {} }))
vi.mock('../remote', () => ({
  MobileRemoteClient: class {
    constructor(options: { onState: typeof platform.onState }) { platform.onState = options.onState }
    request = platform.request
    disconnect(): void { /* Test owns connection state. */ }
  },
}))
vi.mock('react-native', () => {
  const Box = ({ children }: { children?: ReactNode }) => createElement('div', null, children)
  const ScrollView = forwardRef((props: { children?: ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ scrollTo: () => undefined }))
    return createElement(Box, props)
  })
  return {
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    Image: () => null, KeyboardAvoidingView: Box, SafeAreaView: Box, ScrollView, Text: Box, View: Box,
    TextInput: () => null,
    Pressable: ({ children, onPress, disabled, accessibilityLabel }: {
      children?: ReactNode
      onPress?: () => void
      disabled?: boolean
      accessibilityLabel?: string
    }) => createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children),
    Platform: { select: () => undefined }, StyleSheet: { create: (value: unknown) => value },
    useWindowDimensions: () => ({ width: 400 }),
  }
})

let root: Root | undefined
let container: HTMLDivElement | undefined

async function mount(): Promise<void> {
  const require = createRequire(import.meta.url)
  /* oxlint-disable typescript/no-deprecated -- Metro's require(PNG) needs a temporary Node asset loader. */
  const previous = require.extensions['.png']
  require.extensions['.png'] = (module) => { module.exports = 1 }
  try {
    const { default: App } = await import('../App')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => { root?.render(createElement(App)) })
  } finally {
    if (previous === undefined) delete require.extensions['.png']
    else require.extensions['.png'] = previous
  }
  /* oxlint-enable typescript/no-deprecated */
  await act(async () => { platform.onState?.({ kind: 'connected', connectionEpoch: 1 }) })
}

async function click(label: string): Promise<void> {
  const button = [...(container?.querySelectorAll('button') ?? [])].find(value => value.getAttribute('aria-label') === label)
  expect(button, label).toBeDefined()
  await act(async () => { button?.click() })
}

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  container?.remove()
  container = undefined
  platform.onState = undefined
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it('waits for a toggle started by a closed sheet before the reopened sheet reads Host state', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let resolveToggle: ((value: unknown) => void) | undefined
  let hostEnabled = true
  platform.request.mockImplementation((method: string) => method === 'plugins.list'
    ? Promise.resolve({ ok: true, value: { plugins: [{ id: 'optional', name: 'Optional', source: 'bundled', enabled: hostEnabled, required: false }] } })
    : new Promise((resolve) => { resolveToggle = resolve }))
  await mount()
  await click('Open plugins')
  await vi.waitFor(() => { expect(container?.querySelector('[aria-label="Optional: on"]')).not.toBeNull() })
  await click('Optional: on')
  expect(resolveToggle).toBeDefined()
  await click('Close sheet')
  await click('Open plugins')
  expect(platform.request.mock.calls.map((call: unknown[]) => call[0])).toEqual(['plugins.list', 'plugins.setEnabled'])
  expect(container?.querySelector('[aria-label="Optional: on"]')).toBeNull()
  await act(async () => {
    hostEnabled = false
    resolveToggle?.({ ok: true, value: { plugin: { id: 'optional', name: 'Optional', source: 'bundled', enabled: false, required: false } } })
  })
  await vi.waitFor(() => { expect(container?.querySelector('[aria-label="Optional: off"]')).not.toBeNull() })
  expect(platform.request.mock.calls.map((call: unknown[]) => call[0])).toEqual(['plugins.list', 'plugins.setEnabled', 'plugins.list'])
})
