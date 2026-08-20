import {
  isPairingProtocolError,
  parsePairingBootstrap,
  type DesktopToMobileSessionMessage,
  type MobilePairingCapability,
  type MobileSessionActiveTurn,
  type MobileSessionSnapshotMessage,
} from '@deepseek-ai/dsh-pairing-protocol'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useRef, useState } from 'react'
import {
  AppState,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import {
  MOBILE_FOREGROUND_CAPABILITIES,
  MobilePairingTransport,
  mobileRelayConnectionUrl,
  type MobilePairingSummary,
  type MobileTransportEndReason,
  type MobileTransportState,
} from './transport'

type Screen = 'sessions' | 'conversation' | 'pairing' | 'settings'
type PairingStep = 'paste' | 'waiting'

interface MobileSessionView {
  readonly activeTurn: MobileSessionActiveTurn | null
  readonly handle: string
  readonly messages: readonly MobileSessionSnapshotMessage[]
  readonly title: string
  readonly waitingForDesktop: boolean
}

interface PairingProblem {
  readonly detail: string
  readonly title: string
}

const deepSeekMark = require('./assets/deepseek-mark.png') as number

const mobileCapabilities: readonly { readonly capability: MobilePairingCapability; readonly label: string }[] = [
  { capability: 'session:read', label: 'Read the selected session' },
  { capability: 'session:subscribe', label: 'Follow text updates' },
  { capability: 'turn:send', label: 'Request a text turn' },
]

/** Renders the foreground-only companion for a desktop-selected DSH session. */
export default function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('sessions')
  const [bootstrapInput, setBootstrapInput] = useState('')
  const [draft, setDraft] = useState('')
  const [pairingProblem, setPairingProblem] = useState<PairingProblem | undefined>()
  const [pairingStep, setPairingStep] = useState<PairingStep>('paste')
  const [pairingSummary, setPairingSummary] = useState<MobilePairingSummary | undefined>()
  const [transportState, setTransportState] = useState<MobileTransportState>({ kind: 'ended', reason: 'closed' })
  const [session, setSession] = useState<MobileSessionView | undefined>()
  const transportRef = useRef<MobilePairingTransport | undefined>(undefined)

  if (transportRef.current === undefined) {
    transportRef.current = new MobilePairingTransport({
      onDesktopMessage: message => setSession(current => applyDesktopMessage(current, message)),
      onState: (state) => {
        setTransportState(state)
        if (state.kind === 'connected') {
          setPairingProblem(undefined)
          setPairingSummary(state.summary)
          setPairingStep('waiting')
          setScreen('sessions')
          return
        }
        if (state.kind === 'connecting' || state.kind === 'awaiting-desktop-approval') {
          setPairingProblem(undefined)
          setPairingSummary(state.summary)
          setPairingStep('waiting')
          return
        }
        setSession(undefined)
        setDraft('')
        setPairingSummary(undefined)
        if (state.reason !== 'closed') setPairingProblem(problemForEnd(state.reason))
      },
    })
  }

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') transportRef.current?.close('backgrounded')
    })
    return () => {
      subscription.remove()
      transportRef.current?.close('closed')
    }
  }, [])

  const openPairing = () => setScreen('pairing')
  const startPairing = () => {
    const candidate = bootstrapInput.trim()
    setBootstrapInput('')
    setPairingProblem(undefined)
    try {
      const bootstrap = parsePairingBootstrap(candidate)
      mobileRelayConnectionUrl(bootstrap)
      setPairingSummary(summaryFor(bootstrap))
      setPairingStep('waiting')
      transportRef.current?.start(candidate)
    } catch (error) {
      setPairingStep('paste')
      setPairingProblem(pairingProblemFor(error))
    }
  }
  const resetPairing = () => {
    transportRef.current?.close('closed')
    setBootstrapInput('')
    setPairingProblem(undefined)
    setPairingSummary(undefined)
    setPairingStep('paste')
  }
  const sendText = () => {
    if (session === undefined || draft.trim() === '') return
    const text = draft
    setDraft('')
    try {
      transportRef.current?.sendText(session.handle, text)
      setSession(current => current === undefined ? undefined : { ...current, waitingForDesktop: true })
    } catch {
      setPairingProblem(problemForEnd('network-unavailable'))
    }
  }
  return <SafeAreaView style={styles.page}>
    <StatusBar style="light" />
    {screen === 'sessions' && <SessionsScreen
      onOpenConversation={() => setScreen('conversation')}
      onOpenPairing={openPairing}
      onOpenSettings={() => setScreen('settings')}
      session={session}
      transportState={transportState}
    />}
    {screen === 'conversation' && <ConversationScreen
      draft={draft}
      onBack={() => setScreen('sessions')}
      onChangeDraft={setDraft}
      onOpenPairing={openPairing}
      onSendText={sendText}
      session={session}
      transportState={transportState}
    />}
    {screen === 'settings' && <SettingsScreen
      onBack={() => setScreen('sessions')}
      onDisconnect={resetPairing}
      onOpenPairing={openPairing}
      pairingSummary={pairingSummary}
      transportState={transportState}
    />}
    {screen === 'pairing' && <PairingScreen
      bootstrapInput={bootstrapInput}
      onBack={() => setScreen('sessions')}
      onChangeBootstrap={setBootstrapInput}
      onReset={resetPairing}
      onStart={startPairing}
      pairingProblem={pairingProblem}
      pairingStep={pairingStep}
      summary={pairingSummary}
      transportState={transportState}
    />}
  </SafeAreaView>
}

/** Maps parsed protocol failures without exposing a QR payload or bearer token. */
function pairingProblemFor(error: unknown): PairingProblem {
  if (!isPairingProtocolError(error)) return { title: 'Could not pair this phone', detail: 'Use a new code from DSH desktop and try again.' }
  if (error.code === 'PAIRING_QR_EXPIRED') return { title: 'This pairing code expired', detail: 'Pairing codes are short-lived. Generate another code on the desktop.' }
  if (error.code === 'PAIRING_QR_UNSUPPORTED_VERSION') return { title: 'This code needs a newer app', detail: 'Update DSH desktop and DSH Mobile, then generate a new code.' }
  if (error.code === 'PAIRING_CAPABILITY_DENIED') return { title: 'This code requests an unavailable capability', detail: 'Mobile can only read and follow a selected session and send text.' }
  return { title: 'This pairing code is not valid', detail: 'Paste the complete current code from DSH desktop. It was not saved.' }
}

/** Converts a local transport ending into a specific, non-sensitive recovery state. */
function problemForEnd(reason: MobileTransportEndReason): PairingProblem {
  if (reason === 'backgrounded') return { title: 'Pairing ended in the background', detail: 'DSH Mobile stays foreground-only. Pair again when you return to the app.' }
  if (reason === 'expired') return { title: 'Pairing code expired', detail: 'Generate a fresh code on your desktop.' }
  if (reason === 'desktop-unavailable') return { title: 'Desktop is unavailable', detail: 'Keep DSH desktop open, then create a new pairing code.' }
  if (reason === 'network-unavailable') return { title: 'Connection ended', detail: 'Check your network and pair again from DSH desktop.' }
  if (reason === 'protocol-invalid') return { title: 'Pairing was stopped safely', detail: 'Use a fresh code from a current DSH desktop.' }
  if (reason === 'relay-v2-unavailable') return { title: 'Mobile relay unavailable', detail: 'Use a current DSH Mobile build and pair again from your desktop.' }
  return { title: 'Desktop did not accept this phone', detail: 'Review the request on DSH desktop, then use a new pairing code.' }
}

function summaryFor(bootstrap: ReturnType<typeof parsePairingBootstrap>): MobilePairingSummary {
  return {
    relayHost: new URL(bootstrap.relayUrl).host,
    pairingSuffix: bootstrap.pairingId.slice(-6),
    expiresAt: bootstrap.expiresAt,
    capabilities: MOBILE_FOREGROUND_CAPABILITIES,
  }
}

/** Replaces or incrementally updates only the safe desktop-projected session content. */
export function applyDesktopMessage(
  current: MobileSessionView | undefined,
  message: DesktopToMobileSessionMessage,
): MobileSessionView | undefined {
  if (message.type === 'session-snapshot') {
    return {
      activeTurn: message.activeTurn,
      handle: message.sessionHandle,
      messages: message.messages,
      title: message.title,
      waitingForDesktop: false,
    }
  }
  if (current === undefined || current.handle !== message.sessionHandle) return current
  if (message.type === 'text-delta') {
    const existing = current.messages.find(item => item.id === message.turnId)
    const messages = existing === undefined
      ? [...current.messages, { id: message.turnId, role: 'assistant' as const, text: message.delta }]
      : current.messages.map(item => item.id === message.turnId ? { ...item, text: item.text + message.delta } : item)
    return { ...current, messages, waitingForDesktop: false }
  }
  if (message.type === 'turn-state') {
    return { ...current, activeTurn: { id: message.turnId, state: message.state }, waitingForDesktop: false }
  }
  return { ...current, waitingForDesktop: false }
}

/** Shows the connected state without treating an absent desktop snapshot as cached data. */
function SessionsScreen({
  onOpenConversation,
  onOpenPairing,
  onOpenSettings,
  session,
  transportState,
}: {
  onOpenConversation: () => void
  onOpenPairing: () => void
  onOpenSettings: () => void
  session: MobileSessionView | undefined
  transportState: MobileTransportState
}): React.JSX.Element {
  const connected = transportState.kind === 'connected'
  return <View style={styles.screen}>
    <ScrollView contentContainerStyle={styles.sessionsContent} showsVerticalScrollIndicator={false}>
      <View style={styles.topBar}>
        <Brand />
        <Pressable accessibilityLabel="Open settings" accessibilityRole="button" onPress={onOpenSettings} style={styles.iconButton}>
          <Text style={styles.iconButtonText}>•••</Text>
        </Pressable>
      </View>
      <View style={styles.headingBlock}>
        <Text style={styles.eyebrow}>MOBILE COMPANION</Text>
        <Text style={styles.title}>Your session</Text>
        <Text style={styles.subtitle}>Stay in the thread. Tools, approvals, files, and computer use stay on your desktop.</Text>
      </View>
      <ConnectionBanner connected={connected} onOpenPairing={onOpenPairing} transportState={transportState} />
      {session === undefined
        ? <EmptySession onOpenPairing={onOpenPairing} transportState={transportState} />
        : <>
          <View style={styles.sectionHeading}>
            <Text style={styles.sectionTitle}>Selected on desktop</Text>
            <Text style={styles.sectionMeta}>LIVE</Text>
          </View>
          <View style={styles.sessionList}>
            <Pressable accessibilityLabel={`Open session ${session.title}`} accessibilityRole="button" onPress={onOpenConversation} style={({ pressed }) => [styles.sessionRow, pressed && styles.pressed]}>
              <View style={styles.sessionAvatar}>
                <Image accessibilityIgnoresInvertColors source={deepSeekMark} style={styles.sessionMark} />
              </View>
              <View style={styles.sessionCopy}>
                <Text numberOfLines={1} style={styles.sessionTitle}>{session.title}</Text>
                <Text numberOfLines={1} style={styles.sessionDetail}>{session.activeTurn?.state === 'running' ? 'Responding on desktop' : `${session.messages.length} safe text messages`}</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          </View>
        </>}
    </ScrollView>
    <BottomNavigation active="sessions" onOpenSessions={() => undefined} onOpenSettings={onOpenSettings} />
  </View>
}

/** Gives an absent snapshot a direct recovery path instead of preview content. */
function EmptySession({
  onOpenPairing,
  transportState,
}: {
  onOpenPairing: () => void
  transportState: MobileTransportState
}): React.JSX.Element {
  const waiting = transportState.kind === 'connecting' || transportState.kind === 'awaiting-desktop-approval'
  const connected = transportState.kind === 'connected'
  return <View style={styles.emptyState}>
    <Image accessibilityIgnoresInvertColors source={deepSeekMark} style={styles.emptyMark} />
    <Text style={styles.emptyTitle}>{connected ? 'Waiting for a desktop session' : waiting ? 'Waiting for desktop approval' : 'Pair a desktop to continue'}</Text>
    <Text style={styles.emptyCopy}>{connected ? 'Choose an existing session in DSH desktop. Its safe text history will appear here.' : waiting ? 'The desktop must confirm this phone before it can send any session data.' : 'This app does not show cached or preview conversations.'}</Text>
    {!connected && !waiting && <Pressable accessibilityRole="button" onPress={onOpenPairing} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}><Text style={styles.primaryButtonText}>Pair a desktop</Text></Pressable>}
  </View>
}

/** Renders an immersive session with only the desktop-approved text controls. */
function ConversationScreen({
  draft,
  onBack,
  onChangeDraft,
  onOpenPairing,
  onSendText,
  session,
  transportState,
}: {
  draft: string
  onBack: () => void
  onChangeDraft: (text: string) => void
  onOpenPairing: () => void
  onSendText: () => void
  session: MobileSessionView | undefined
  transportState: MobileTransportState
}): React.JSX.Element {
  if (session === undefined) return <KeyboardAvoidingView behavior={Platform.select({ ios: 'padding', default: undefined })} style={styles.screen}>
    <View style={styles.conversationTopBar}><BackButton onBack={onBack} /><View style={styles.topBarSpacer} /></View>
    <EmptySession onOpenPairing={onOpenPairing} transportState={transportState} />
  </KeyboardAvoidingView>
  const running = session.activeTurn?.state === 'running'
  const connected = transportState.kind === 'connected'
  return <KeyboardAvoidingView behavior={Platform.select({ ios: 'padding', default: undefined })} style={styles.screen}>
    <View style={styles.conversationTopBar}>
      <BackButton onBack={onBack} />
      <View style={styles.conversationTitleWrap}><Text numberOfLines={1} style={styles.conversationTitle}>{session.title}</Text><Text style={styles.conversationStatus}>{connected ? running ? 'RESPONDING' : 'LIVE' : 'DISCONNECTED'}</Text></View>
      <View style={styles.topBarSpacer} />
    </View>
    <ScrollView contentContainerStyle={styles.conversationContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      {!connected && <View style={styles.conversationNotice}><Text style={styles.conversationNoticeTitle}>Connection ended</Text><Text style={styles.conversationNoticeText}>This session is no longer live. Pair a desktop again before you send another message.</Text><Pressable accessibilityRole="button" onPress={onOpenPairing} style={styles.noticeAction}><Text style={styles.noticeActionText}>Pair again</Text></Pressable></View>}
      <Text style={styles.dayLabel}>DESKTOP-SELECTED SESSION</Text>
      {session.messages.map(message => <View key={message.id} style={message.role === 'user' ? styles.userMessage : styles.assistantMessage}><Text style={message.role === 'user' ? styles.userMessageText : styles.assistantMessageText}>{message.text}</Text></View>)}
      {session.waitingForDesktop && <Text accessibilityLiveRegion="polite" style={styles.requestStatus}>Request sent. Waiting for desktop approval.</Text>}
      {running && <View style={styles.typingRow}>
        <View style={styles.typingDot} />
        <Text style={styles.typingText}>DSH is responding on desktop</Text>
      </View>}
    </ScrollView>
    <View style={styles.composerShell}>
      <View style={styles.composer}>
        <TextInput accessibilityLabel="Message selected DSH session" editable={connected && !running} multiline onChangeText={onChangeDraft} placeholder={connected ? 'Message DSH' : 'Pair desktop to message'} placeholderTextColor={colors.muted} style={styles.composerInput} value={draft} />
        <Pressable accessibilityLabel="Send text request to desktop" accessibilityRole="button" disabled={!connected || running || draft.trim() === ''} onPress={onSendText} style={({ pressed }) => [styles.sendButton, (!connected || running || draft.trim() === '') && styles.disabledSendButton, pressed && styles.pressed]}><Text style={styles.sendButtonText}>↑</Text></Pressable>
      </View>
      <Text style={styles.composerHint}>{connected ? 'Desktop approves every text request.' : 'Message delivery is unavailable while disconnected.'}</Text>
    </View>
  </KeyboardAvoidingView>
}

/** Pairs only from a transient, desktop-issued QR bootstrap. */
function PairingScreen({
  bootstrapInput,
  onBack,
  onChangeBootstrap,
  onReset,
  onStart,
  pairingProblem,
  pairingStep,
  summary,
  transportState,
}: {
  bootstrapInput: string
  onBack: () => void
  onChangeBootstrap: (value: string) => void
  onReset: () => void
  onStart: () => void
  pairingProblem: PairingProblem | undefined
  pairingStep: PairingStep
  summary: MobilePairingSummary | undefined
  transportState: MobileTransportState
}): React.JSX.Element {
  const waiting = pairingStep === 'waiting' && transportState.kind !== 'connected'
  return <View style={styles.screen}>
    <View style={styles.settingsTopBar}><BackButton onBack={onBack} /></View>
    <ScrollView contentContainerStyle={styles.pairingContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <Brand />
      <Text style={styles.eyebrow}>SECURE DESKTOP PAIRING</Text>
      <Text style={styles.title}>{transportState.kind === 'connected' ? 'Phone accepted' : waiting ? 'Await desktop approval' : 'Pair this phone'}</Text>
      <Text style={styles.subtitle}>{transportState.kind === 'connected' ? 'This foreground connection can show only the desktop-selected text session.' : waiting ? 'The trusted desktop verifies this phone and decides whether to accept it.' : 'Paste the short-lived code created in DSH desktop. The code is never saved.'}</Text>
      {pairingStep === 'paste' && <>
        <View style={styles.qrPlaceholder}>
          <Image accessibilityIgnoresInvertColors source={deepSeekMark} style={styles.pairingMark} />
          <Text style={styles.qrTitle}>Use a desktop-issued code</Text>
          <Text style={styles.qrDetail}>Camera scanning is not enabled. Paste the current code directly from DSH desktop.</Text>
        </View>
        <Text style={styles.fieldLabel}>DESKTOP PAIRING CODE</Text>
        <TextInput accessibilityLabel="Paste desktop pairing code" autoCapitalize="none" autoCorrect={false} multiline onChangeText={onChangeBootstrap} placeholder="dsh-pairing:v2:…" placeholderTextColor={colors.muted} spellCheck={false} style={styles.bootstrapInput} textAlignVertical="top" value={bootstrapInput} />
        <Text style={styles.inputNote}>
          The code is parsed in memory, then the raw text is immediately cleared. It is never logged or stored.
        </Text>
        {pairingProblem && <ProblemCard problem={pairingProblem} />}
        <Pressable accessibilityRole="button" disabled={bootstrapInput.trim() === ''} onPress={onStart} style={({ pressed }) => [styles.primaryButton, bootstrapInput.trim() === '' && styles.disabledButton, pressed && styles.pressed]}><Text style={styles.primaryButtonText}>Pair securely</Text></Pressable>
      </>}
      {pairingStep === 'waiting' && summary && <>
        <View style={styles.waitingMark}>
          <View style={styles.waitingRing}>
            <Image accessibilityIgnoresInvertColors source={deepSeekMark} style={styles.waitingLogo} />
          </View>
        </View>
        <Text style={styles.waitingTitle}>{transportState.kind === 'connected' ? 'Desktop accepted this phone' : 'Waiting for desktop approval'}</Text>
        <Text style={styles.waitingCopy}>{transportState.kind === 'connected' ? 'Choose an existing session on desktop to begin the live, text-only view.' : 'No session data or message control is available until the desktop verifies and accepts this request.'}</Text>
        <BootstrapFacts summary={summary} />
        <CapabilityBoundary />
        {pairingProblem && <ProblemCard problem={pairingProblem} />}
        <Pressable accessibilityRole="button" onPress={onReset} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{transportState.kind === 'connected' ? 'Disconnect this phone' : 'Use another code'}</Text></Pressable>
      </>}
    </ScrollView>
  </View>
}

/** Lists non-secret pairing facts while keeping the relay token and keys invisible. */
function BootstrapFacts({ summary }: { summary: MobilePairingSummary }): React.JSX.Element {
  return <View style={styles.settingsCard}>
    <SettingFact title="Relay" value={summary.relayHost} />
    <View style={styles.settingsDivider} />
    <SettingFact title="Pairing code" value={`…${summary.pairingSuffix}`} />
    <View style={styles.settingsDivider} />
    <SettingFact title="Expires" value={new Date(summary.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} />
  </View>
}

/** States the small mobile allowlist and the desktop-only authority it excludes. */
function CapabilityBoundary(): React.JSX.Element {
  return <>
    <Text style={styles.settingsSectionLabel}>MOBILE ALLOWLIST</Text>
    <View style={styles.settingsCard}>
      {mobileCapabilities.map((item, index) => <View key={item.capability}>
        <SettingFact title={item.label} value={item.capability} />
        {index < mobileCapabilities.length - 1 && <View style={styles.settingsDivider} />}
      </View>)}
    </View>
    <Text style={styles.settingsSectionLabel}>DESKTOP ONLY</Text>
    <View style={styles.desktopOnlyCard}>
      <Text style={styles.desktopOnlyTitle}>Execution and approvals remain on desktop</Text>
      <Text style={styles.desktopOnlyText}>
        No computer use, tool approvals, files, credentials, workspace or settings changes,
        attachments, session creation, or cancellation are available on this phone.
      </Text>
    </View>
  </>
}

/** Shows connection ownership and a clear disconnection action. */
function SettingsScreen({
  onBack,
  onDisconnect,
  onOpenPairing,
  pairingSummary,
  transportState,
}: {
  onBack: () => void
  onDisconnect: () => void
  onOpenPairing: () => void
  pairingSummary: MobilePairingSummary | undefined
  transportState: MobileTransportState
}): React.JSX.Element {
  const connected = transportState.kind === 'connected'
  const waiting = transportState.kind === 'connecting' || transportState.kind === 'awaiting-desktop-approval'
  return <View style={styles.screen}>
    <View style={styles.settingsTopBar}><BackButton onBack={onBack} /></View>
    <ScrollView contentContainerStyle={styles.settingsContent} showsVerticalScrollIndicator={false}>
      <Text style={styles.title}>Connection</Text>
      <Text style={styles.subtitle}>
        DSH Mobile is a foreground-only companion. It does not retain a pairing after it closes or backgrounds.
      </Text>
      <Text style={styles.settingsSectionLabel}>DESKTOP</Text>
      <View style={styles.settingsCard}>
        <View style={styles.settingsRow}><View style={styles.settingsRowCopy}><Text style={styles.settingsRowTitle}>{connected ? 'Desktop accepted' : waiting ? 'Awaiting desktop approval' : 'Not connected'}</Text><Text style={styles.settingsRowDetail}>{pairingSummary === undefined ? 'No mobile relay credential is retained.' : `Pairing …${pairingSummary.pairingSuffix}`}</Text></View><View style={[styles.connectionPill, connected && styles.connectedPill]}><Text style={[styles.connectionPillText, connected && styles.connectedPillText]}>{connected ? 'LIVE' : waiting ? 'WAITING' : 'OFFLINE'}</Text></View></View>
        <View style={styles.settingsDivider} />
        <Text style={styles.settingsExplanation}>{connected ? 'Disconnecting erases the QR credential, pairing key, and session cipher from memory.' : 'Pair from a short-lived desktop code. The desktop explicitly approves every text request.'}</Text>
        <Pressable accessibilityRole="button" onPress={connected || waiting ? onDisconnect : onOpenPairing} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}><Text style={styles.primaryButtonText}>{connected || waiting ? 'End pairing' : 'Pair a desktop'}</Text></Pressable>
      </View>
      <CapabilityBoundary />
    </ScrollView>
    <BottomNavigation active="settings" onOpenSessions={onBack} onOpenSettings={() => undefined} />
  </View>
}

function Brand(): React.JSX.Element {
  return <View style={styles.brandRow}>
    <Image accessibilityIgnoresInvertColors source={deepSeekMark} style={styles.brandMark} />
    <Text style={styles.brand}>DSH</Text>
  </View>
}

function BackButton({ onBack }: { onBack: () => void }): React.JSX.Element {
  return <Pressable accessibilityLabel="Back to sessions" accessibilityRole="button" onPress={onBack} style={styles.backButton}><Text style={styles.backChevron}>‹</Text><Text style={styles.backText}>Sessions</Text></Pressable>
}

function ProblemCard({ problem }: { problem: PairingProblem }): React.JSX.Element {
  return <View accessibilityLiveRegion="polite" style={styles.problemCard}><Text style={styles.problemTitle}>{problem.title}</Text><Text style={styles.problemDetail}>{problem.detail}</Text></View>
}

function ConnectionBanner({
  connected,
  onOpenPairing,
  transportState,
}: {
  connected: boolean
  onOpenPairing: () => void
  transportState: MobileTransportState
}): React.JSX.Element {
  const waiting = transportState.kind === 'connecting' || transportState.kind === 'awaiting-desktop-approval'
  return <View style={styles.connectionBanner}><View style={[styles.statusDot, connected && styles.liveDot, waiting && styles.waitingDot]} /><View style={styles.offlineCopy}><Text style={styles.offlineTitle}>{connected ? 'Desktop paired' : waiting ? 'Pairing in progress' : 'Desktop not paired'}</Text><Text style={styles.offlineText}>{connected ? 'Live data is limited to one desktop-selected text session.' : waiting ? 'No mobile session data is available until desktop acceptance.' : 'Session history appears only after secure desktop pairing.'}</Text></View>{!connected && !waiting && <Pressable accessibilityLabel="Pair a desktop" accessibilityRole="button" onPress={onOpenPairing} style={styles.compactButton}><Text style={styles.compactButtonText}>Pair</Text></Pressable>}</View>
}

function SettingFact({ title, value }: { title: string; value: string }): React.JSX.Element {
  return <View style={styles.factRow}><Text style={styles.factTitle}>{title}</Text><Text style={styles.factValue}>{value}</Text></View>
}

function BottomNavigation({ active, onOpenSessions, onOpenSettings }: { active: 'sessions' | 'settings'; onOpenSessions: () => void; onOpenSettings: () => void }): React.JSX.Element {
  return <View style={styles.bottomNavigation}><Pressable accessibilityRole="tab" accessibilityState={{ selected: active === 'sessions' }} onPress={onOpenSessions} style={styles.navItem}><Text style={[styles.navGlyph, active === 'sessions' && styles.navActive]}>◌</Text><Text style={[styles.navLabel, active === 'sessions' && styles.navActive]}>Sessions</Text></Pressable><Pressable accessibilityRole="tab" accessibilityState={{ selected: active === 'settings' }} onPress={onOpenSettings} style={styles.navItem}><Text style={[styles.navGlyph, active === 'settings' && styles.navActive]}>◐</Text><Text style={[styles.navLabel, active === 'settings' && styles.navActive]}>Settings</Text></Pressable></View>
}

const colors = {
  accent: '#4D6BFE',
  border: '#292D38',
  card: '#15171D',
  ink: '#F2F4FA',
  muted: '#9097A8',
  page: '#0B0D12',
  soft: '#C8CEDB',
  userMessage: '#242A3B',
} as const

const styles = StyleSheet.create({
  assistantMessage: { alignSelf: 'flex-start', backgroundColor: colors.card, borderColor: colors.border, borderRadius: 20, borderTopLeftRadius: 5, borderWidth: 1, maxWidth: '86%', paddingHorizontal: 15, paddingVertical: 12 }, assistantMessageText: { color: colors.ink, fontSize: 16, lineHeight: 24 }, backButton: { alignItems: 'center', flexDirection: 'row', minHeight: 36 }, backChevron: { color: colors.ink, fontSize: 34, fontWeight: '300', lineHeight: 34, marginRight: 2 }, backText: { color: colors.soft, fontSize: 15, fontWeight: '600' },
  bootstrapInput: { backgroundColor: '#11141B', borderColor: '#3A4050', borderRadius: 14, borderWidth: 1, color: colors.ink, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 13, lineHeight: 19, minHeight: 110, padding: 14 }, bottomNavigation: { backgroundColor: '#101218', borderColor: colors.border, borderTopWidth: 1, flexDirection: 'row', justifyContent: 'space-around', paddingBottom: 9, paddingTop: 10 }, brand: { color: colors.ink, fontSize: 15, fontWeight: '800', letterSpacing: 1.1 }, brandMark: { height: 25, width: 25 }, brandRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  chevron: { color: colors.muted, fontSize: 25, fontWeight: '300' }, compactButton: { alignItems: 'center', borderColor: '#454B5B', borderRadius: 10, borderWidth: 1, minWidth: 56, paddingHorizontal: 10, paddingVertical: 8 }, compactButtonText: { color: colors.ink, fontSize: 13, fontWeight: '700' }, composer: { alignItems: 'flex-end', backgroundColor: '#161922', borderColor: '#363D4E', borderRadius: 22, borderWidth: 1, flexDirection: 'row', minHeight: 54, paddingBottom: 6, paddingLeft: 15, paddingRight: 6, paddingTop: 6 }, composerHint: { color: colors.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 4, paddingTop: 8, textAlign: 'center' }, composerInput: { color: colors.ink, flex: 1, fontSize: 16, lineHeight: 22, maxHeight: 108, minHeight: 38, paddingBottom: 7, paddingRight: 10, paddingTop: 7 }, composerShell: { backgroundColor: colors.page, borderTopColor: '#171A21', borderTopWidth: 1, paddingBottom: 12, paddingHorizontal: 16, paddingTop: 10 },
  connectedPill: { backgroundColor: '#17261D' }, connectedPillText: { color: '#9CCAA9' }, connectionBanner: { alignItems: 'center', backgroundColor: '#11141B', borderColor: colors.border, borderRadius: 17, borderWidth: 1, flexDirection: 'row', gap: 11, padding: 14 }, connectionPill: { backgroundColor: '#252933', borderRadius: 9, paddingHorizontal: 8, paddingVertical: 5 }, connectionPillText: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 0.7 }, conversationContent: { gap: 13, paddingBottom: 30, paddingHorizontal: 16, paddingTop: 14 }, conversationNotice: { backgroundColor: '#211A18', borderColor: '#5E4238', borderRadius: 16, borderWidth: 1, gap: 6, marginBottom: 8, padding: 15 }, conversationNoticeText: { color: '#E5C2B5', fontSize: 14, lineHeight: 20 }, conversationNoticeTitle: { color: '#F4D3C5', fontSize: 15, fontWeight: '700' }, conversationStatus: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1 }, conversationTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' }, conversationTitleWrap: { alignItems: 'center', flex: 1, gap: 2, paddingHorizontal: 8 }, conversationTopBar: { alignItems: 'center', borderBottomColor: '#181B22', borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', minHeight: 57, paddingHorizontal: 16 },
  dayLabel: { alignSelf: 'center', color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.1 }, desktopOnlyCard: { backgroundColor: '#171B28', borderColor: '#303A5D', borderRadius: 16, borderWidth: 1, gap: 6, padding: 15 }, desktopOnlyText: { color: '#BBC5E7', fontSize: 14, lineHeight: 20 }, desktopOnlyTitle: { color: '#D9E0FC', fontSize: 15, fontWeight: '700' }, disabledButton: { backgroundColor: '#4A4D58' }, disabledSendButton: { backgroundColor: '#414651' },
  emptyCopy: { color: colors.muted, fontSize: 15, lineHeight: 22, maxWidth: 315, textAlign: 'center' }, emptyMark: { height: 46, marginBottom: 3, width: 46 }, emptyState: { alignItems: 'center', backgroundColor: '#10131A', borderColor: colors.border, borderRadius: 20, borderWidth: 1, gap: 10, marginTop: 34, paddingHorizontal: 28, paddingVertical: 32 }, emptyTitle: { color: colors.ink, fontSize: 19, fontWeight: '700', textAlign: 'center' }, eyebrow: { color: '#9EB0FF', fontSize: 11, fontWeight: '800', letterSpacing: 1.3 }, factRow: { gap: 5, paddingVertical: 3 }, factTitle: { color: colors.ink, fontSize: 15, fontWeight: '600' }, factValue: { color: colors.muted, fontSize: 14 }, fieldLabel: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.1 }, headingBlock: { gap: 10, paddingBottom: 25, paddingTop: 27 }, iconButton: { alignItems: 'center', borderColor: colors.border, borderRadius: 12, borderWidth: 1, height: 36, justifyContent: 'center', width: 42 }, iconButtonText: { color: colors.soft, fontSize: 16, letterSpacing: 1, marginTop: -5 }, inputNote: { color: colors.muted, fontSize: 12, lineHeight: 18 }, liveDot: { backgroundColor: '#76B98B' },
  navActive: { color: colors.ink }, navGlyph: { color: colors.muted, fontSize: 17, lineHeight: 18 }, navItem: { alignItems: 'center', gap: 3, minWidth: 94, paddingVertical: 2 }, navLabel: { color: colors.muted, fontSize: 11, fontWeight: '600' }, noticeAction: { alignSelf: 'flex-start', marginTop: 3, paddingVertical: 4 }, noticeActionText: { color: '#F4D3C5', fontSize: 14, fontWeight: '700' }, offlineCopy: { flex: 1, gap: 3 }, offlineText: { color: colors.muted, fontSize: 13, lineHeight: 18 }, offlineTitle: { color: colors.ink, fontSize: 14, fontWeight: '700' }, page: { backgroundColor: colors.page, flex: 1 }, pairingContent: { gap: 15, paddingBottom: 34, paddingHorizontal: 20, paddingTop: 12 }, pairingMark: { height: 54, width: 54 }, pressed: { opacity: 0.72 }, primaryButton: { alignItems: 'center', backgroundColor: colors.ink, borderRadius: 12, marginTop: 3, paddingHorizontal: 18, paddingVertical: 13 }, primaryButtonText: { color: colors.page, fontSize: 15, fontWeight: '800' }, problemCard: { backgroundColor: '#27191D', borderColor: '#75414B', borderRadius: 14, borderWidth: 1, gap: 5, padding: 14 }, problemDetail: { color: '#E7B7BD', fontSize: 13, lineHeight: 19 }, problemTitle: { color: '#F6C9CF', fontSize: 14, fontWeight: '700' }, qrDetail: { color: colors.muted, fontSize: 13, lineHeight: 19, textAlign: 'center' }, qrPlaceholder: { alignItems: 'center', backgroundColor: '#10131A', borderColor: '#313847', borderRadius: 20, borderStyle: 'dashed', borderWidth: 1, gap: 8, paddingHorizontal: 30, paddingVertical: 25 }, qrTitle: { color: colors.ink, fontSize: 16, fontWeight: '700' }, requestStatus: { alignSelf: 'center', color: '#B6C4FF', fontSize: 13, fontWeight: '600', paddingTop: 4 },
  screen: { backgroundColor: colors.page, flex: 1 }, secondaryButton: { alignItems: 'center', borderColor: '#454B5B', borderRadius: 12, borderWidth: 1, paddingVertical: 13 }, secondaryButtonText: { color: colors.soft, fontSize: 15, fontWeight: '700' }, sectionHeading: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginTop: 30, paddingBottom: 5 }, sectionMeta: { color: '#9EB0FF', fontSize: 10, fontWeight: '800', letterSpacing: 1 }, sectionTitle: { color: colors.ink, fontSize: 16, fontWeight: '700' }, sendButton: { alignItems: 'center', backgroundColor: colors.accent, borderRadius: 17, height: 34, justifyContent: 'center', width: 34 }, sendButtonText: { color: '#F7F8FF', fontSize: 23, fontWeight: '600', lineHeight: 25, marginTop: -2 }, sessionAvatar: { alignItems: 'center', backgroundColor: '#202637', borderRadius: 13, height: 36, justifyContent: 'center', width: 36 }, sessionCopy: { flex: 1, gap: 4, minWidth: 0 }, sessionDetail: { color: colors.muted, fontSize: 13 }, sessionList: { backgroundColor: colors.card, borderColor: colors.border, borderRadius: 18, borderWidth: 1, overflow: 'hidden' }, sessionMark: { height: 24, width: 24 }, sessionRow: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 70, paddingHorizontal: 14 }, sessionTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' }, sessionsContent: { paddingBottom: 28, paddingHorizontal: 20 }, settingsCard: { backgroundColor: colors.card, borderColor: colors.border, borderRadius: 18, borderWidth: 1, gap: 14, padding: 16 }, settingsContent: { paddingBottom: 30, paddingHorizontal: 20 }, settingsDivider: { backgroundColor: colors.border, height: 1 }, settingsExplanation: { color: colors.muted, fontSize: 14, lineHeight: 20 }, settingsRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, settingsRowCopy: { flex: 1, gap: 4, paddingRight: 12 }, settingsRowDetail: { color: colors.muted, fontSize: 14 }, settingsRowTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' }, settingsSectionLabel: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.1, marginBottom: 8, marginTop: 28 }, settingsTopBar: { minHeight: 57, paddingHorizontal: 20, paddingTop: 4 }, statusDot: { backgroundColor: '#737783', borderRadius: 5, height: 9, width: 9 }, subtitle: { color: colors.muted, fontSize: 15, lineHeight: 22, marginBottom: 26, marginTop: 8 }, title: { color: colors.ink, fontSize: 31, fontWeight: '700', letterSpacing: -0.6 }, topBar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 58, paddingTop: 2 }, topBarSpacer: { width: 66 }, typingDot: { backgroundColor: colors.accent, borderRadius: 4, height: 8, width: 8 }, typingRow: { alignItems: 'center', alignSelf: 'flex-start', flexDirection: 'row', gap: 8, paddingHorizontal: 3, paddingTop: 2 }, typingText: { color: colors.muted, fontSize: 13 }, userMessage: { alignSelf: 'flex-end', backgroundColor: colors.userMessage, borderRadius: 20, borderTopRightRadius: 5, maxWidth: '82%', paddingHorizontal: 15, paddingVertical: 12 }, userMessageText: { color: colors.ink, fontSize: 16, lineHeight: 24 }, waitingDot: { backgroundColor: '#C8A96B' }, waitingLogo: { height: 30, width: 30 }, waitingCopy: { color: colors.muted, fontSize: 14, lineHeight: 21, textAlign: 'center' }, waitingMark: { alignItems: 'center', marginBottom: 5, marginTop: 10 }, waitingRing: { alignItems: 'center', backgroundColor: '#151A2A', borderColor: '#3E4A76', borderRadius: 31, borderWidth: 1, height: 62, justifyContent: 'center', width: 62 }, waitingTitle: { color: colors.ink, fontSize: 20, fontWeight: '700', textAlign: 'center' },
})
