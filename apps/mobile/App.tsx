import {
  isPairingProtocolError,
  parsePairingBootstrap,
  type MobilePairingCapability,
} from '@deepseek-ai/dsh-pairing-protocol'
import { StatusBar } from 'expo-status-bar'
import { useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'

type Screen = 'sessions' | 'conversation' | 'pairing' | 'settings'
type PairingStep = 'paste' | 'request' | 'waiting'
type ConnectionView = 'unpaired-preview' | 'paired-shell-preview'

const previewSessions = [
  { id: 'workspace', title: 'Prepare the workspace', detail: 'A local interface preview' },
  { id: 'review', title: 'Review a change', detail: 'Pair a desktop to load history' },
  { id: 'handoff', title: 'Continue a handoff', detail: 'No remote session is connected' },
] as const

interface BootstrapSummary {
  readonly relayHost: string
  readonly pairingSuffix: string
  readonly expiresAt: number
  readonly capabilities: readonly MobilePairingCapability[]
}

interface PairingProblem {
  readonly title: string
  readonly detail: string
}

const mobileCapabilities: readonly { readonly capability: MobilePairingCapability; readonly label: string }[] = [
  { capability: 'session:read', label: 'Read existing sessions' },
  { capability: 'session:subscribe', label: 'Receive live session updates' },
  { capability: 'turn:send', label: 'Send text to an existing session' },
  { capability: 'turn:cancel', label: 'Cancel the current turn' },
]

/** Renders a local mobile shell and a non-networked preview of secure desktop pairing. */
export default function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('sessions')
  const [selectedSession, setSelectedSession] = useState<(typeof previewSessions)[number]>(previewSessions[0])
  const [draft, setDraft] = useState('')
  const [connectionView, setConnectionView] = useState<ConnectionView>('unpaired-preview')
  const [pairingStep, setPairingStep] = useState<PairingStep>('paste')
  const [bootstrapInput, setBootstrapInput] = useState('')
  const [bootstrapSummary, setBootstrapSummary] = useState<BootstrapSummary | undefined>()
  const [pairingProblem, setPairingProblem] = useState<PairingProblem | undefined>()

  const openPairing = () => setScreen('pairing')
  const resetPairing = () => {
    setBootstrapInput('')
    setBootstrapSummary(undefined)
    setPairingProblem(undefined)
    setPairingStep('paste')
    setConnectionView('unpaired-preview')
  }
  const validateBootstrap = () => {
    const candidate = bootstrapInput.trim()
    setBootstrapInput('')
    setPairingProblem(undefined)
    try {
      const bootstrap = parsePairingBootstrap(candidate)
      setBootstrapSummary({
        relayHost: new URL(bootstrap.relayUrl).host,
        pairingSuffix: bootstrap.pairingId.slice(-6),
        expiresAt: bootstrap.expiresAt,
        capabilities: bootstrap.capabilities,
      })
      setPairingStep('request')
    } catch (error) {
      setPairingStep('paste')
      setPairingProblem(pairingProblemFor(error))
    }
  }

  return <SafeAreaView style={styles.page}>
    <StatusBar style="light" />
    {screen === 'sessions' && <SessionsScreen connectionView={connectionView} onOpenConversation={(session) => { setSelectedSession(session); setScreen('conversation') }} onOpenPairing={openPairing} onOpenSettings={() => setScreen('settings')} />}
    {screen === 'conversation' && <ConversationScreen connectionView={connectionView} draft={draft} onBack={() => setScreen('sessions')} onChangeDraft={setDraft} onOpenPairing={openPairing} session={selectedSession} />}
    {screen === 'settings' && <SettingsScreen onBack={() => setScreen('sessions')} onOpenPairing={openPairing} />}
    {screen === 'pairing' && <PairingScreen
      bootstrapInput={bootstrapInput}
      bootstrapSummary={bootstrapSummary}
      onBack={() => setScreen('sessions')}
      onChangeBootstrap={setBootstrapInput}
      onOpenPairedPreview={() => { setConnectionView('paired-shell-preview'); setScreen('sessions') }}
      onRequest={() => setPairingStep('waiting')}
      onReset={resetPairing}
      onValidate={validateBootstrap}
      pairingProblem={pairingProblem}
      pairingStep={pairingStep}
    />}
  </SafeAreaView>
}

/** Maps failures without reflecting the pasted QR payload or relay token into the UI. */
function pairingProblemFor(error: unknown): PairingProblem {
  if (!isPairingProtocolError(error)) return { title: 'Could not validate this pairing code', detail: 'Paste a new code from DSH desktop and try again.' }
  if (error.code === 'PAIRING_QR_EXPIRED') return { title: 'This pairing code expired', detail: 'Pairing codes are short-lived. Generate another code on the desktop.' }
  if (error.code === 'PAIRING_QR_UNSUPPORTED_VERSION') return { title: 'This code is from an unsupported version', detail: 'Update DSH desktop or use a current desktop-generated code.' }
  if (error.code === 'PAIRING_CAPABILITY_DENIED') return { title: 'This code requests a mobile capability that is not allowed', detail: 'Mobile can only read and follow sessions, send text turns, and cancel a turn.' }
  return { title: 'This pairing code is not valid', detail: 'Paste the complete code from DSH desktop. It has not been saved.' }
}

/** Shows local session previews while clearly separating them from a live paired desktop. */
function SessionsScreen({
  connectionView,
  onOpenConversation,
  onOpenPairing,
  onOpenSettings,
}: {
  connectionView: ConnectionView
  onOpenConversation: (session: typeof previewSessions[number]) => void
  onOpenPairing: () => void
  onOpenSettings: () => void
}): React.JSX.Element {
  const pairedShellPreview = connectionView === 'paired-shell-preview'
  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.sessionsContent} showsVerticalScrollIndicator={false}>
        <View style={styles.topBar}>
          <View style={styles.brandRow}>
            <View style={styles.brandMark}>
              <Text style={styles.brandMarkText}>D</Text>
            </View>
            <Text style={styles.brand}>DSH</Text>
          </View>
          <Pressable
            accessibilityLabel="Open settings"
            accessibilityRole="button"
            onPress={onOpenSettings}
            style={styles.iconButton}
          >
            <Text style={styles.iconButtonText}>•••</Text>
          </Pressable>
        </View>
        <View style={styles.headingBlock}>
          <Text style={styles.eyebrow}>
            {pairedShellPreview ? 'PAIRED-SHELL PREVIEW' : 'MOBILE WORKSPACE'}
          </Text>
          <Text style={styles.title}>Your sessions</Text>
          <Text style={styles.subtitle}>
            {pairedShellPreview
              ? 'This renders the paired session shell without connecting a desktop.'
              : 'Stay in the thread, then take privileged work back to your desktop.'}
          </Text>
        </View>
        <View
          accessibilityLabel={pairedShellPreview ? 'Paired shell preview only' : 'Desktop not paired'}
          style={styles.connectionBanner}
        >
          <View style={[styles.statusDot, pairedShellPreview && styles.previewDot]} />
          <View style={styles.offlineCopy}>
            <Text style={styles.offlineTitle}>
              {pairedShellPreview ? 'Paired shell preview' : 'Desktop not paired'}
            </Text>
            <Text style={styles.offlineText}>
              {pairedShellPreview
                ? 'No device, account, session, or relay is connected.'
                : 'Session history appears only after secure desktop pairing.'}
            </Text>
          </View>
          <Pressable
            accessibilityLabel="Open desktop pairing"
            accessibilityRole="button"
            onPress={onOpenPairing}
            style={styles.compactButton}
          >
            <Text style={styles.compactButtonText}>{pairedShellPreview ? 'Review' : 'Pair'}</Text>
          </Pressable>
        </View>
        <View style={styles.sectionHeading}>
          <Text style={styles.sectionTitle}>Session browser</Text>
          <Text style={styles.sectionMeta}>LOCAL PREVIEW</Text>
        </View>
        <Text style={styles.sectionDescription}>
          These sample rows are never synced. The paired shell does not grant desktop control.
        </Text>
        <View style={styles.sessionList}>
          {previewSessions.map((session, index) => <Pressable
            accessibilityHint="Opens a local preview conversation"
            accessibilityLabel={`Open preview session ${session.title}`}
            accessibilityRole="button"
            key={session.id}
            onPress={() => onOpenConversation(session)}
            style={({ pressed }) => [
              styles.sessionRow,
              index < previewSessions.length - 1 && styles.sessionDivider,
              pressed && styles.pressed,
            ]}
          >
            <View style={styles.sessionAvatar}>
              <Text style={styles.sessionAvatarText}>{session.title.slice(0, 1)}</Text>
            </View>
            <View style={styles.sessionCopy}>
              <Text numberOfLines={1} style={styles.sessionTitle}>{session.title}</Text>
              <Text numberOfLines={1} style={styles.sessionDetail}>{session.detail}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>)}
        </View>
      </ScrollView>
      <BottomNavigation active="sessions" onOpenSessions={() => undefined} onOpenSettings={onOpenSettings} />
    </View>
  )
}

/** Renders a full-screen session presentation without representing local sample messages as desktop data. */
function ConversationScreen({ connectionView, draft, onBack, onChangeDraft, onOpenPairing, session }: {
  connectionView: ConnectionView
  draft: string
  onBack: () => void
  onChangeDraft: (text: string) => void
  onOpenPairing: () => void
  session: typeof previewSessions[number]
}): React.JSX.Element {
  const pairedShellPreview = connectionView === 'paired-shell-preview'
  return <KeyboardAvoidingView behavior={Platform.select({ ios: 'padding', default: undefined })} style={styles.screen}>
    <View style={styles.conversationTopBar}><Pressable accessibilityLabel="Back to sessions" accessibilityRole="button" onPress={onBack} style={styles.backButton}><Text style={styles.backChevron}>‹</Text><Text style={styles.backText}>Sessions</Text></Pressable><View style={styles.conversationTitleWrap}><Text numberOfLines={1} style={styles.conversationTitle}>{session.title}</Text><Text style={styles.conversationStatus}>{pairedShellPreview ? 'PAIRED-SHELL PREVIEW' : 'LOCAL PREVIEW'}</Text></View><View style={styles.topBarSpacer} /></View>
    <ScrollView contentContainerStyle={styles.conversationContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <View style={styles.conversationNotice}><Text style={styles.conversationNoticeTitle}>{pairedShellPreview ? 'The paired shell is visual only' : 'This device is not paired'}</Text><Text style={styles.conversationNoticeText}>{pairedShellPreview ? 'It has no session data or desktop connection. The next transport slice replaces this preview after desktop acceptance.' : 'DSH cannot load or send session data until the desktop accepts a secure pairing request.'}</Text><Pressable accessibilityRole="button" onPress={onOpenPairing} style={styles.noticeAction}><Text style={styles.noticeActionText}>Review pairing</Text></Pressable></View>
      <Text style={styles.dayLabel}>LOCAL PREVIEW</Text>
      <View style={styles.assistantMessage}>
        <Text style={styles.assistantMessageText}>
          This is where DSH responses, progress, and limited session actions appear when a paired
          desktop streams a session to this phone.
        </Text>
      </View>
      <View style={styles.userMessage}>
        <Text style={styles.userMessageText}>Can I continue this session from my phone?</Text>
      </View>
      <View style={styles.assistantMessage}>
        <Text style={styles.assistantMessageText}>
          Yes, after desktop approval. Computer use, privacy prompts, files, credentials, and
          workspace changes remain desktop-only.
        </Text>
      </View>
    </ScrollView>
    <View style={styles.composerShell}><View style={styles.composer}><TextInput accessibilityLabel="Local message draft" multiline onChangeText={onChangeDraft} placeholder="Message DSH" placeholderTextColor={colors.muted} style={styles.composerInput} value={draft} /><Pressable accessibilityHint="Opens pairing because message transport is unavailable" accessibilityLabel="Pair a desktop before sending" accessibilityRole="button" onPress={onOpenPairing} style={({ pressed }) => [styles.sendButton, pressed && styles.pressed]}><Text style={styles.sendButtonText}>↑</Text></Pressable></View><Text style={styles.composerHint}>{draft.trim() === '' ? 'Message delivery is unavailable in this preview.' : 'This draft stays only in the open preview.'}</Text></View>
  </KeyboardAvoidingView>
}

/** Lets the user validate a manually pasted bootstrap, then makes desktop acceptance explicit. */
function PairingScreen({
  bootstrapInput,
  bootstrapSummary,
  onBack,
  onChangeBootstrap,
  onOpenPairedPreview,
  onRequest,
  onReset,
  onValidate,
  pairingProblem,
  pairingStep,
}: {
  bootstrapInput: string
  bootstrapSummary: BootstrapSummary | undefined
  onBack: () => void
  onChangeBootstrap: (value: string) => void
  onOpenPairedPreview: () => void
  onRequest: () => void
  onReset: () => void
  onValidate: () => void
  pairingProblem: PairingProblem | undefined
  pairingStep: PairingStep
}): React.JSX.Element {
  return <View style={styles.screen}>
    <View style={styles.settingsTopBar}><Pressable accessibilityLabel="Back to sessions" accessibilityRole="button" onPress={onBack} style={styles.backButton}><Text style={styles.backChevron}>‹</Text><Text style={styles.backText}>Sessions</Text></Pressable></View>
    <ScrollView contentContainerStyle={styles.pairingContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <Text style={styles.eyebrow}>SECURE DESKTOP PAIRING</Text>
      <Text style={styles.title}>{pairingTitle(pairingStep)}</Text>
      <Text style={styles.subtitle}>{pairingSubtitle(pairingStep)}</Text>
      {pairingStep === 'paste' && <>
        <View style={styles.qrPlaceholder}>
          <Text style={styles.qrCorner}>⌁</Text>
          <Text style={styles.qrTitle}>Camera pairing comes next</Text>
          <Text style={styles.qrDetail}>
            Paste a code from DSH desktop to validate the flow without camera access.
          </Text>
        </View>
        <Text style={styles.fieldLabel}>DESKTOP PAIRING CODE</Text><TextInput accessibilityLabel="Paste desktop pairing code" autoCapitalize="none" autoCorrect={false} multiline onChangeText={onChangeBootstrap} placeholder="dsh-pairing:v1:…" placeholderTextColor={colors.muted} spellCheck={false} style={styles.bootstrapInput} textAlignVertical="top" value={bootstrapInput} />
        <Text style={styles.inputNote}>
          The pasted value is validated in memory, then cleared. It is never logged or stored on
          this phone.
        </Text>
        {pairingProblem && <View accessibilityLiveRegion="polite" style={styles.problemCard}><Text style={styles.problemTitle}>{pairingProblem.title}</Text><Text style={styles.problemDetail}>{pairingProblem.detail}</Text></View>}
        <Pressable accessibilityRole="button" disabled={bootstrapInput.trim() === ''} onPress={onValidate} style={({ pressed }) => [styles.primaryButton, bootstrapInput.trim() === '' && styles.disabledButton, pressed && styles.pressed]}><Text style={styles.primaryButtonText}>Validate pairing code</Text></Pressable>
      </>}
      {pairingStep === 'request' && bootstrapSummary && <>
        <BootstrapFacts summary={bootstrapSummary} /><CapabilityBoundary /><Text style={styles.localOnlyNote}>The code has been parsed locally. No relay connection or desktop request has been made by this build.</Text><Pressable accessibilityRole="button" onPress={onRequest} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}><Text style={styles.primaryButtonText}>Prepare pairing request</Text></Pressable><Pressable accessibilityRole="button" onPress={onReset} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Use another code</Text></Pressable>
      </>}
      {pairingStep === 'waiting' && bootstrapSummary && <>
        <View style={styles.waitingMark}><View style={styles.waitingRing}><View style={styles.waitingCenter} /></View></View><Text style={styles.waitingTitle}>Blocked until desktop accepts</Text><Text style={styles.waitingCopy}>Only the trusted desktop can approve this phone. This local foundation has no relay I/O, so it cannot receive that approval or pretend one happened.</Text><BootstrapFacts summary={bootstrapSummary} /><Pressable accessibilityRole="button" onPress={onOpenPairedPreview} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}><Text style={styles.secondaryButtonText}>Open paired-shell preview</Text></Pressable><Text style={styles.previewExplain}>This opens a visual preview only. It never changes the blocked pairing state or connects a desktop.</Text><Pressable accessibilityRole="button" onPress={onReset} style={styles.textButton}><Text style={styles.textButtonText}>Start over</Text></Pressable>
      </>}
    </ScrollView>
  </View>
}

/** Displays only non-secret bootstrap facts after the raw code has been cleared. */
function BootstrapFacts({ summary }: { summary: BootstrapSummary }): React.JSX.Element {
  return <View style={styles.settingsCard}><View style={styles.settingsRow}><View style={styles.settingsRowCopy}><Text style={styles.settingsRowTitle}>Relay</Text><Text style={styles.settingsRowDetail}>{summary.relayHost}</Text></View><View style={styles.previewPill}><Text style={styles.previewPillText}>LOCAL</Text></View></View><View style={styles.settingsDivider} /><SettingFact title="Pairing code" value={`…${summary.pairingSuffix}`} /><View style={styles.settingsDivider} /><SettingFact title="Requested scope" value={`${summary.capabilities.length} mobile operations`} /><View style={styles.settingsDivider} /><SettingFact title="Expires" value={new Date(summary.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} /></View>
}

/** States the fixed mobile allowlist and desktop-only authority that remains excluded. */
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
      <Text style={styles.desktopOnlyTitle}>Computer use and approvals stay on the desktop</Text>
      <Text style={styles.desktopOnlyText}>
        No file access, credentials, workspace changes, settings, attachments, arbitrary session
        creation, or computer-use approvals are available on mobile.
      </Text>
    </View>
  </>
}

/** Lists static app settings and routes pairing through the pairing-first screen. */
function SettingsScreen({ onBack, onOpenPairing }: { onBack: () => void; onOpenPairing: () => void }): React.JSX.Element {
  return <View style={styles.screen}><View style={styles.settingsTopBar}><Pressable accessibilityLabel="Back to sessions" accessibilityRole="button" onPress={onBack} style={styles.backButton}><Text style={styles.backChevron}>‹</Text><Text style={styles.backText}>Sessions</Text></Pressable></View><ScrollView contentContainerStyle={styles.settingsContent} showsVerticalScrollIndicator={false}><Text style={styles.title}>Settings</Text><Text style={styles.subtitle}>This phone has no live DSH connection.</Text><Text style={styles.settingsSectionLabel}>CONNECTION</Text><View style={styles.settingsCard}><View style={styles.settingsRow}><View style={styles.settingsRowCopy}><Text style={styles.settingsRowTitle}>Paired desktop</Text><Text style={styles.settingsRowDetail}>Not connected</Text></View><View style={styles.unavailablePill}><Text style={styles.unavailablePillText}>OFFLINE</Text></View></View><View style={styles.settingsDivider} /><Text style={styles.settingsExplanation}>Pair from a desktop-issued, short-lived code. Desktop approval remains required before this phone can receive a session.</Text><Pressable accessibilityRole="button" onPress={onOpenPairing} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}><Text style={styles.primaryButtonText}>Pair a desktop</Text></Pressable></View><CapabilityBoundary /></ScrollView><BottomNavigation active="settings" onOpenSessions={onBack} onOpenSettings={() => undefined} /></View>
}

/** Displays one immutable capability or connection fact. */
function SettingFact({ title, value }: { title: string; value: string }): React.JSX.Element {
  return <View style={styles.factRow}><Text style={styles.factTitle}>{title}</Text><Text style={styles.factValue}>{value}</Text></View>
}

/** Keeps top-level navigation visible without adding a navigation dependency. */
function BottomNavigation({ active, onOpenSessions, onOpenSettings }: { active: 'sessions' | 'settings'; onOpenSessions: () => void; onOpenSettings: () => void }): React.JSX.Element {
  return <View style={styles.bottomNavigation}><Pressable accessibilityRole="tab" accessibilityState={{ selected: active === 'sessions' }} onPress={onOpenSessions} style={styles.navItem}><Text style={[styles.navGlyph, active === 'sessions' && styles.navActive]}>◌</Text><Text style={[styles.navLabel, active === 'sessions' && styles.navActive]}>Sessions</Text></Pressable><Pressable accessibilityRole="tab" accessibilityState={{ selected: active === 'settings' }} onPress={onOpenSettings} style={styles.navItem}><Text style={[styles.navGlyph, active === 'settings' && styles.navActive]}>◐</Text><Text style={[styles.navLabel, active === 'settings' && styles.navActive]}>Settings</Text></Pressable></View>
}

function pairingTitle(step: PairingStep): string {
  if (step === 'request') return 'Review desktop request'
  if (step === 'waiting') return 'Await desktop approval'
  return 'Pair this phone'
}

function pairingSubtitle(step: PairingStep): string {
  if (step === 'request') return 'The desktop decides what this phone can do before any session is available.'
  if (step === 'waiting') return 'A phone cannot self-authorize. Desktop confirmation is required.'
  return 'Paste a short-lived code generated by the DSH desktop.'
}

const colors = { accent: '#f3a63b', border: '#2e3038', card: '#1a1b21', ink: '#f6f6f8', muted: '#989ba6', page: '#0d0e12', soft: '#c7c9d1', userMessage: '#2a2d36' } as const

const styles = StyleSheet.create({
  assistantMessage: { alignSelf: 'flex-start', backgroundColor: colors.card, borderColor: colors.border, borderRadius: 20, borderTopLeftRadius: 5, borderWidth: 1, maxWidth: '86%', paddingHorizontal: 15, paddingVertical: 12 }, assistantMessageText: { color: colors.ink, fontSize: 16, lineHeight: 23 }, backButton: { alignItems: 'center', flexDirection: 'row', minHeight: 36 }, backChevron: { color: colors.ink, fontSize: 34, fontWeight: '300', lineHeight: 34, marginRight: 2 }, backText: { color: colors.soft, fontSize: 15, fontWeight: '600' },
  bootstrapInput: { backgroundColor: '#15161c', borderColor: '#464956', borderRadius: 14, borderWidth: 1, color: colors.ink, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 13, lineHeight: 19, minHeight: 110, padding: 14 }, bottomNavigation: { backgroundColor: '#13141a', borderColor: colors.border, borderTopWidth: 1, flexDirection: 'row', justifyContent: 'space-around', paddingBottom: 9, paddingTop: 10 }, brand: { color: colors.ink, fontSize: 15, fontWeight: '800', letterSpacing: 1.1 }, brandMark: { alignItems: 'center', backgroundColor: colors.accent, borderRadius: 7, height: 24, justifyContent: 'center', width: 24 }, brandMarkText: { color: colors.page, fontSize: 14, fontWeight: '900' }, brandRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  chevron: { color: colors.muted, fontSize: 25, fontWeight: '300' }, compactButton: { alignItems: 'center', borderColor: '#484a55', borderRadius: 10, borderWidth: 1, minWidth: 56, paddingHorizontal: 10, paddingVertical: 8 }, compactButtonText: { color: colors.ink, fontSize: 13, fontWeight: '700' }, composer: { alignItems: 'flex-end', backgroundColor: '#1b1c23', borderColor: '#3c3e49', borderRadius: 22, borderWidth: 1, flexDirection: 'row', minHeight: 54, paddingBottom: 6, paddingLeft: 15, paddingRight: 6, paddingTop: 6 }, composerHint: { color: colors.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 4, paddingTop: 8, textAlign: 'center' }, composerInput: { color: colors.ink, flex: 1, fontSize: 16, lineHeight: 22, maxHeight: 108, minHeight: 38, paddingBottom: 7, paddingRight: 10, paddingTop: 7 }, composerShell: { backgroundColor: colors.page, borderTopColor: '#191a20', borderTopWidth: 1, paddingBottom: 12, paddingHorizontal: 16, paddingTop: 10 }, connectionBanner: { alignItems: 'center', backgroundColor: '#17181e', borderColor: colors.border, borderRadius: 17, borderWidth: 1, flexDirection: 'row', gap: 11, padding: 14 },
  conversationContent: { gap: 13, paddingBottom: 30, paddingHorizontal: 16, paddingTop: 14 }, conversationNotice: { backgroundColor: '#201c16', borderColor: '#5c4728', borderRadius: 16, borderWidth: 1, gap: 6, marginBottom: 8, padding: 15 }, conversationNoticeText: { color: '#ddc9a8', fontSize: 14, lineHeight: 20 }, conversationNoticeTitle: { color: '#f6ddad', fontSize: 15, fontWeight: '700' }, conversationStatus: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1 }, conversationTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' }, conversationTitleWrap: { alignItems: 'center', flex: 1, gap: 2, paddingHorizontal: 8 }, conversationTopBar: { alignItems: 'center', borderBottomColor: '#1d1e25', borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', minHeight: 57, paddingHorizontal: 16 },
  dayLabel: { alignSelf: 'center', color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.1 }, desktopOnlyCard: { backgroundColor: '#201c16', borderColor: '#5c4728', borderRadius: 16, borderWidth: 1, gap: 6, padding: 15 }, desktopOnlyText: { color: '#ddc9a8', fontSize: 14, lineHeight: 20 }, desktopOnlyTitle: { color: '#f6ddad', fontSize: 15, fontWeight: '700' }, disabledButton: { backgroundColor: '#555760' }, eyebrow: { color: colors.accent, fontSize: 11, fontWeight: '800', letterSpacing: 1.3 }, factRow: { gap: 5, paddingVertical: 3 }, factTitle: { color: colors.ink, fontSize: 15, fontWeight: '600' }, factValue: { color: colors.muted, fontSize: 14 }, fieldLabel: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.1 }, headingBlock: { gap: 10, paddingBottom: 25, paddingTop: 27 }, iconButton: { alignItems: 'center', borderColor: colors.border, borderRadius: 12, borderWidth: 1, height: 36, justifyContent: 'center', width: 42 }, iconButtonText: { color: colors.soft, fontSize: 16, letterSpacing: 1, marginTop: -5 }, inputNote: { color: colors.muted, fontSize: 12, lineHeight: 18 }, localOnlyNote: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  navActive: { color: colors.ink }, navGlyph: { color: colors.muted, fontSize: 17, lineHeight: 18 }, navItem: { alignItems: 'center', gap: 3, minWidth: 94, paddingVertical: 2 }, navLabel: { color: colors.muted, fontSize: 11, fontWeight: '600' }, noticeAction: { alignSelf: 'flex-start', marginTop: 3, paddingVertical: 4 }, noticeActionText: { color: '#f6ddad', fontSize: 14, fontWeight: '700' }, offlineCopy: { flex: 1, gap: 3 }, offlineText: { color: colors.muted, fontSize: 13, lineHeight: 18 }, offlineTitle: { color: colors.ink, fontSize: 14, fontWeight: '700' }, page: { backgroundColor: colors.page, flex: 1 }, pairingContent: { gap: 15, paddingBottom: 34, paddingHorizontal: 20, paddingTop: 12 }, previewDot: { backgroundColor: colors.accent }, previewExplain: { color: colors.muted, fontSize: 12, lineHeight: 18, textAlign: 'center' }, previewPill: { backgroundColor: '#29231a', borderRadius: 9, paddingHorizontal: 8, paddingVertical: 5 }, previewPillText: { color: '#f6ddad', fontSize: 10, fontWeight: '800', letterSpacing: .7 }, pressed: { opacity: .72 }, primaryButton: { alignItems: 'center', backgroundColor: colors.ink, borderRadius: 12, marginTop: 3, paddingVertical: 13 }, primaryButtonText: { color: colors.page, fontSize: 15, fontWeight: '800' },
  problemCard: { backgroundColor: '#27191d', borderColor: '#75414b', borderRadius: 14, borderWidth: 1, gap: 5, padding: 14 }, problemDetail: { color: '#e7b7bd', fontSize: 13, lineHeight: 19 }, problemTitle: { color: '#f6c9cf', fontSize: 14, fontWeight: '700' }, qrCorner: { color: colors.accent, fontSize: 35, lineHeight: 35 }, qrDetail: { color: colors.muted, fontSize: 13, lineHeight: 19, textAlign: 'center' }, qrPlaceholder: { alignItems: 'center', backgroundColor: '#15161b', borderColor: '#393b45', borderRadius: 20, borderStyle: 'dashed', borderWidth: 1, gap: 5, paddingHorizontal: 30, paddingVertical: 25 }, qrTitle: { color: colors.ink, fontSize: 16, fontWeight: '700' }, screen: { backgroundColor: colors.page, flex: 1 }, secondaryButton: { alignItems: 'center', borderColor: '#484a55', borderRadius: 12, borderWidth: 1, paddingVertical: 13 }, secondaryButtonText: { color: colors.soft, fontSize: 15, fontWeight: '700' }, sectionDescription: { color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: 11 }, sectionHeading: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginTop: 30, paddingBottom: 5 }, sectionMeta: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1 }, sectionTitle: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  sendButton: { alignItems: 'center', backgroundColor: colors.accent, borderRadius: 17, height: 34, justifyContent: 'center', width: 34 }, sendButtonText: { color: colors.page, fontSize: 23, fontWeight: '600', lineHeight: 25, marginTop: -2 }, sessionAvatar: { alignItems: 'center', backgroundColor: '#282a33', borderRadius: 13, height: 36, justifyContent: 'center', width: 36 }, sessionAvatarText: { color: colors.soft, fontSize: 15, fontWeight: '700' }, sessionCopy: { flex: 1, gap: 4, minWidth: 0 }, sessionDetail: { color: colors.muted, fontSize: 13 }, sessionDivider: { borderBottomColor: colors.border, borderBottomWidth: 1 }, sessionList: { backgroundColor: colors.card, borderColor: colors.border, borderRadius: 18, borderWidth: 1, overflow: 'hidden' }, sessionRow: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 70, paddingHorizontal: 14 }, sessionTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' }, sessionsContent: { paddingBottom: 28, paddingHorizontal: 20 }, settingsCard: { backgroundColor: colors.card, borderColor: colors.border, borderRadius: 18, borderWidth: 1, gap: 14, padding: 16 }, settingsContent: { paddingBottom: 30, paddingHorizontal: 20 }, settingsDivider: { backgroundColor: colors.border, height: 1 }, settingsExplanation: { color: colors.muted, fontSize: 14, lineHeight: 20 }, settingsRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, settingsRowCopy: { gap: 4 }, settingsRowDetail: { color: colors.muted, fontSize: 14 }, settingsRowTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' }, settingsSectionLabel: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.1, marginBottom: 8, marginTop: 28 }, statusDot: { backgroundColor: '#737783', borderRadius: 5, height: 9, width: 9 }, textButton: { alignItems: 'center', paddingVertical: 8 }, textButtonText: { color: colors.muted, fontSize: 14, fontWeight: '700' }, topBar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 58, paddingTop: 2 }, topBarSpacer: { width: 66 }, title: { color: colors.ink, fontSize: 31, fontWeight: '700', letterSpacing: -.6 }, subtitle: { color: colors.muted, fontSize: 15, lineHeight: 22, marginBottom: 26, marginTop: 8 }, unavailablePill: { backgroundColor: '#282930', borderRadius: 9, paddingHorizontal: 8, paddingVertical: 5 }, unavailablePillText: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: .7 }, userMessage: { alignSelf: 'flex-end', backgroundColor: colors.userMessage, borderRadius: 20, borderTopRightRadius: 5, maxWidth: '82%', paddingHorizontal: 15, paddingVertical: 12 }, userMessageText: { color: colors.ink, fontSize: 16, lineHeight: 23 }, waitingCenter: { backgroundColor: colors.accent, borderRadius: 4, height: 8, width: 8 }, waitingCopy: { color: colors.muted, fontSize: 14, lineHeight: 21, textAlign: 'center' }, waitingMark: { alignItems: 'center', marginBottom: 5, marginTop: 10 }, waitingRing: { alignItems: 'center', borderColor: colors.accent, borderRadius: 31, borderWidth: 1, height: 62, justifyContent: 'center', width: 62 }, waitingTitle: { color: colors.ink, fontSize: 20, fontWeight: '700', textAlign: 'center' }, settingsTopBar: { minHeight: 57, paddingHorizontal: 20, paddingTop: 4 },
})
