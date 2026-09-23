// @vitest-environment jsdom
import { createRequire } from 'node:module'
import { act, createElement, forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { x25519 } from '@noble/curves/ed25519.js'
import { NativeMobileRemoteStateStore } from '../mobile-remote-state'
import { MobileConnectionNotices } from '../mobile-connection-view'

const platform = vi.hoisted(() => ({
  listeners: new Set<(state: 'background' | 'active' | 'inactive') => void>(),
  store: undefined as NativeMobileRemoteStateStore | undefined,
  createSocket: vi.fn(),
  presence: vi.fn(async () => undefined),
}))

vi.mock('expo-status-bar', () => ({ StatusBar: () => null }))
vi.mock('expo-camera', () => ({ CameraView: () => null, useCameraPermissions: () => [undefined, vi.fn()] }))
vi.mock('expo-crypto', () => ({ getRandomValues: (bytes: Uint8Array) => bytes.fill(7) }))
vi.mock('../native-identity', () => ({
  get nativeMobileRemoteStateStore() { return platform.store },
  nativeMobileIdentityProvider: {
    clearUserPresence: () => undefined,
    requireUserPresence: platform.presence,
    deviceIdentity: async () => ({
      deviceId: 'device_identifier_123', signingPublicKey: 'a'.repeat(43),
      agreement: { publicKey: Buffer.from(x25519.getPublicKey(new Uint8Array(32).fill(9))).toString('base64url'),
        deriveSharedSecret: (peer: string) => x25519.getSharedSecret(new Uint8Array(32).fill(9), Buffer.from(peer, 'base64url')) },
    }),
  },
}))
vi.mock('../mobile-remote-socket', () => ({ mobileRemoteSocketFactory: { create: platform.createSocket } }))

// Native widgets and AppState are the platform boundary; App hooks, handlers,
// connection actions, notice ownership and MobileRemoteClient execute unchanged.
vi.mock('react-native', () => {
  const Box = ({ children }: { children?: ReactNode }) => createElement('div', null, children)
  const ScrollView = forwardRef((_props: { children?: ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ scrollTo: () => undefined }))
    return createElement(Box, _props)
  })
  return {
    AppState: { addEventListener: (_name: string, listener: (state: 'background' | 'active' | 'inactive') => void) => {
      platform.listeners.add(listener)
      return { remove: () => { platform.listeners.delete(listener) } }
    } },
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
let finishClear: (() => void) | undefined

async function mount(): Promise<void> {
  // Metro loads PNGs as native resource handles; Node only supplies that handle.
  const require = createRequire(import.meta.url)
  /* oxlint-disable typescript/no-deprecated -- Metro's require(PNG) needs a temporary Node asset loader for this mounted-App test. */
  const previous = require.extensions['.png']
  require.extensions['.png'] = (module) => { module.exports = 1 }
  try {
    const { default: App } = await import('../App')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    // Workspace React DOM declarations target React 18; mobile resolves React 19 for both runtimes.
    await act(async () => { root?.render(createElement(App) as unknown as Parameters<Root['render']>[0]) })
  } finally {
    if (previous === undefined) delete require.extensions['.png']
    else require.extensions['.png'] = previous
  }
  /* oxlint-enable typescript/no-deprecated */
}

async function click(label: string): Promise<void> {
  const button = [...(container?.querySelectorAll('button') ?? [])].find(value => value.textContent === label)
  expect(button, label).toBeDefined()
  await act(async () => { button?.click() })
}

async function appState(state: 'background' | 'active'): Promise<void> {
  await act(async () => { for (const listener of platform.listeners) listener(state) })
}

async function pairedStore(): Promise<void> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let record: string | null = null
  platform.store = new NativeMobileRemoteStateStore({
    loadRemoteState: async () => record,
    saveRemoteState: async (value) => { record = value },
    clearRemoteState: async () => { await new Promise<void>((resolve) => { finishClear = resolve }); record = null },
  })
  await platform.store.saveInvitation({
    config: { clientAuthToken: 'a'.repeat(32), connectionEpoch: 1, deviceEnrollmentId: 'device_enrollment_identifier_123',
      hostDeviceId: 'host_device_identifier_123', hostEnrollmentId: 'host_enrollment_identifier_123',
      hostStaticAgreementPublicKey: Buffer.from(x25519.getPublicKey(new Uint8Array(32).fill(7))).toString('base64url'),
      routeGeneration: 1, routeId: 'remote_route_identifier_123' },
    expiresAt: '2026-09-01T00:00:00.000Z',
    identityProvider: { clearUserPresence: () => undefined, requireUserPresence: async () => undefined,
      deviceIdentity: async () => { throw new Error('unused') } },
  })
}

afterEach(async () => {
  finishClear?.()
  finishClear = undefined
  await act(async () => { root?.unmount() })
  root = undefined
  container?.remove()
  platform.listeners.clear()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('mounted mobile lifecycle', () => {
  it('keeps the background reason and handshake stage through unmount and remount', async () => {
    await pairedStore()
    let finishReceive: (() => void) | undefined
    platform.createSocket.mockImplementation(async () => ({
      send: () => undefined,
      close: () => { finishReceive?.() },
      async *receive() { await new Promise<void>((resolve) => { finishReceive = resolve }) },
    }))
    await mount()
    await click('Connect to Host')
    await vi.waitFor(() => { expect(finishReceive).toBeDefined() })
    await appState('background')
    expect(container?.textContent).toContain('Interrupted at host-handshake.')
    await act(async () => { root?.unmount() })
    container?.remove()
    await mount()
    expect(container?.textContent).toContain('The app reported background.')
    expect(container?.textContent).toContain('Interrupted at host-handshake.')
    expect(container?.textContent).not.toContain('The app screen was unloaded.')
    await appState('active')
    expect(platform.presence).toHaveBeenCalledOnce()
  })

  it('keeps background evidence arriving during a deferred Forget', async () => {
    await pairedStore()
    const observed = vi.spyOn(MobileConnectionNotices.prototype, 'current', 'get')
    platform.createSocket.mockImplementation(async () => { throw new Error('Socket unavailable') })
    await mount()
    await click('Connect to Host')
    await click('Forget invitation')
    await click('Forget and disconnect')
    expect(finishClear).toBeDefined()
    await appState('background')
    expect(observed.mock.results.at(-1)?.value).toMatchObject({ interruption: { reason: 'background', stage: undefined } })
    await act(async () => { finishClear?.() })
    expect(observed.mock.results.at(-1)?.value).toEqual({ failure: undefined, interruption: { reason: 'background', stage: undefined } })
    expect(await platform.store?.restore()).toBeUndefined()
  })
})
