import { StatusBar } from 'expo-status-bar'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useEffect, useRef, useState } from 'react'
import { AppState, Image, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native'
import * as Crypto from 'expo-crypto'
import { createMobileEnrollmentOffer, fingerprintMobileEnrollmentOffer, importMobileHostInvitation, type MobileEnrollmentOffer } from './enrollment'
import { completeAnywherePairing } from './anywhere-pairing'
import { disconnectRemoteWhenBackgrounded } from './mobile-app-state'
import { connectStoredHost } from './mobile-connection-action'
import { nativeMobileIdentityProvider, nativeMobileRemoteStateStore } from './native-identity'
import { mobileRemoteSocketFactory } from './mobile-remote-socket'
import { EMPTY_OWNER_WORKSPACE, applyOwnerEvent, applyOwnerSessionList, replaceOwnerWorkspaceSnapshot, type OwnerSession, type OwnerWorkspace } from './owner-workspace'
import { MobileRemoteClient, type MobileRemoteState } from './remote'

type Panel = 'conversation' | 'sessions'
type Sheet = 'none' | 'connection' | 'details' | 'pairing' | 'forget'

interface PairingSummary {
  readonly expiresAt: string
}

const deepSeekMark = require('./assets/deepseek-mark.png') as number

/** Chat-first DSH owner client. Route creation and revocation remain signed-Host actions. */
export default function App(): React.JSX.Element {
  const [panel, setPanel] = useState<Panel>('conversation')
  const [sheet, setSheet] = useState<Sheet>('none')
  const [workspace, setWorkspace] = useState<OwnerWorkspace>(EMPTY_OWNER_WORKSPACE)
  const [remoteState, setRemoteState] = useState<MobileRemoteState>({ kind: 'unconfigured' })
  const [pairing, setPairing] = useState<PairingSummary | undefined>()
  const [draft, setDraft] = useState('')
  const client = useRef<MobileRemoteClient | undefined>(undefined)
  if (client.current === undefined) {
    client.current = new MobileRemoteClient({
      identityProvider: nativeMobileIdentityProvider,
      onEvent: event => setWorkspace(current => applyOwnerEvent(current, event)),
      onSnapshot: value => setWorkspace(current => applyOwnerSessionList(current, value)),
      onBaselineSnapshot: value => setWorkspace(() => replaceOwnerWorkspaceSnapshot(value)),
      onState: setRemoteState,
      randomBytes: length => new Uint8Array(Crypto.getRandomValues(new Uint8Array(length))),
      cursorStore: nativeMobileRemoteStateStore,
      epochProvider: nativeMobileRemoteStateStore,
      socketFactory: mobileRemoteSocketFactory,
    })
  }
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => disconnectRemoteWhenBackgrounded(next, () => client.current?.disconnect()))
    return () => { subscription.remove(); client.current?.disconnect() }
  }, [])
  useEffect(() => {
    let active = true
    void nativeMobileRemoteStateStore.resetCursorForFreshProjection().then((stored) => {
      if (active && stored !== undefined) setPairing({ expiresAt: stored.expiresAt })
    }, () => undefined)
    return () => { active = false }
  }, [])

  const connected = remoteState.kind === 'connected'
  const selected = workspace.sessions.find(session => session.id === workspace.selectedSessionId)
  const refreshSessions = async () => {
    if (!connected) return setSheet('connection')
    try {
      const result = await client.current?.request('session.list', {})
      if (result?.ok) setWorkspace(current => applyOwnerSessionList(current, result.value))
    } catch { /* The Host snapshot remains authoritative. */ }
  }
  const createSession = async () => {
    if (!connected) return setSheet('connection')
    try {
      const result = await client.current?.request('session.create', {})
      const value = result?.ok ? result.value : undefined
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return
      const sessionId = (value as { readonly sessionId?: unknown }).sessionId
      if (typeof sessionId === 'string') setWorkspace(current => applyOwnerSessionList(current, { items: [{ sessionId, running: false, blank: true }] }))
    } catch { /* The Host snapshot remains authoritative. */ }
  }
  const send = async () => {
    if (!connected || selected === undefined || draft.trim() === '') return
    const text = draft.trim()
    setDraft('')
    try { await client.current?.request('session.prompt', { sessionId: selected.id, mode: 'steer', content: [{ type: 'text', text }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }) } catch { /* Never invent a local message. */ }
  }
  const importInvitation = async (value: unknown): Promise<PairingSummary> => {
    const imported = await importMobileHostInvitation(value, nativeMobileIdentityProvider)
    await nativeMobileRemoteStateStore.saveInvitation(imported)
    const summary = { expiresAt: imported.expiresAt }
    setPairing(summary)
    return summary
  }
  const completeRemotePairing = async (code: string, offer: MobileEnrollmentOffer): Promise<PairingSummary> => {
    const transfer = await completeAnywherePairing(code, offer, nativeMobileIdentityProvider)
    const summary = await importInvitation(transfer.invitation)
    await transfer.acknowledge()
    return summary
  }
  const connectHost = async () => {
    try {
      if (client.current !== undefined) await connectStoredHost(client.current, remoteState, nativeMobileRemoteStateStore, () => setSheet('pairing'))
    } catch {
      setRemoteState({ kind: 'error', message: 'Could not access the local DSH Host connection.' })
    }
  }
  const forget = async () => {
    client.current?.disconnect()
    await nativeMobileRemoteStateStore.clear()
    setPairing(undefined)
    setSheet('connection')
  }

  return <SafeAreaView style={styles.page}>
    <StatusBar style="light" />
    <WorkspacePager draft={draft} onChangeDraft={setDraft} onConnect={() => void connectHost()} onCreateSession={() => void createSession()} onOpenConnection={() => setSheet('connection')} onOpenDetails={() => setSheet('details')} onOpenPairing={() => setSheet('pairing')} onRefresh={() => void refreshSessions()} onSelectSession={id => setWorkspace(current => ({ ...current, selectedSessionId: id }))} onSend={() => void send()} pairing={pairing} panel={panel} remoteState={remoteState} selected={selected} setPanel={setPanel} workspace={workspace} />
    {sheet !== 'none' && <ModalSheet onClose={() => setSheet('none')}>
      {sheet === 'connection' && <ConnectionSheet onConnect={() => void connectHost()} onForget={() => setSheet('forget')} onPair={() => setSheet('pairing')} pairing={pairing} state={remoteState} />}
      {sheet === 'details' && <HostDetails session={selected} workspace={workspace} />}
      {sheet === 'pairing' && <PairingSheet existing={pairing} onConnect={() => void connectHost()} onImport={importInvitation} onRemotePair={completeRemotePairing} onOpenForget={() => setSheet('forget')} />}
      {sheet === 'forget' && <ForgetSheet onCancel={() => setSheet('connection')} onForget={() => void forget()} />}
    </ModalSheet>}
  </SafeAreaView>
}

function WorkspacePager({
  draft,
  onChangeDraft,
  onConnect,
  onCreateSession,
  onOpenConnection,
  onOpenDetails,
  onOpenPairing,
  onRefresh,
  onSelectSession,
  onSend,
  pairing,
  panel,
  remoteState,
  selected,
  setPanel,
  workspace,
}: {
  readonly draft: string
  readonly onChangeDraft: (text: string) => void
  readonly onConnect: () => void
  readonly onCreateSession: () => void
  readonly onOpenConnection: () => void
  readonly onOpenDetails: () => void
  readonly onOpenPairing: () => void
  readonly onRefresh: () => void
  readonly onSelectSession: (id: string) => void
  readonly onSend: () => void
  readonly pairing: PairingSummary | undefined
  readonly panel: Panel
  readonly remoteState: MobileRemoteState
  readonly selected: OwnerSession | undefined
  readonly setPanel: (panel: Panel) => void
  readonly workspace: OwnerWorkspace
}): React.JSX.Element {
  const { width } = useWindowDimensions()
  const pager = useRef<ScrollView>(null)
  useEffect(() => pager.current?.scrollTo({ x: panel === 'sessions' ? width : 0, animated: false }), [panel, width])
  const open = (next: Panel) => { setPanel(next); pager.current?.scrollTo({ x: next === 'sessions' ? width : 0, animated: true }) }
  return <ScrollView horizontal pagingEnabled ref={pager} showsHorizontalScrollIndicator={false} onMomentumScrollEnd={({ nativeEvent }) => setPanel(nativeEvent.contentOffset.x >= width / 2 ? 'sessions' : 'conversation')}>
    <View style={[styles.panel, { width }]}><Conversation draft={draft} onChangeDraft={onChangeDraft} onConnect={onConnect} onOpenDetails={onOpenDetails} onOpenPairing={onOpenPairing} onOpenSessions={() => open('sessions')} onSend={onSend} pairing={pairing} remoteState={remoteState} session={selected} /></View>
    <View style={[styles.panel, { width }]}><SessionDrawer onClose={() => open('conversation')} onCreateSession={onCreateSession} onOpenConnection={onOpenConnection} onOpenPairing={onOpenPairing} onRefresh={onRefresh} onSelectSession={(id) => { onSelectSession(id); open('conversation') }} remoteState={remoteState} workspace={workspace} /></View>
  </ScrollView>
}

function Conversation({
  draft,
  onChangeDraft,
  onConnect,
  onOpenDetails,
  onOpenPairing,
  onOpenSessions,
  onSend,
  pairing,
  remoteState,
  session,
}: {
  readonly draft: string
  readonly onChangeDraft: (text: string) => void
  readonly onConnect: () => void
  readonly onOpenDetails: () => void
  readonly onOpenPairing: () => void
  readonly onOpenSessions: () => void
  readonly onSend: () => void
  readonly pairing: PairingSummary | undefined
  readonly remoteState: MobileRemoteState
  readonly session: OwnerSession | undefined
}): React.JSX.Element {
  const connected = remoteState.kind === 'connected'
  return <KeyboardAvoidingView behavior={Platform.select({ ios: 'padding', default: undefined })} style={styles.screen}>
    <View style={styles.header}><Pressable accessibilityLabel="Open sessions" accessibilityRole="button" onPress={onOpenSessions} style={styles.iconButton}><Text style={styles.iconText}>☰</Text></Pressable><View style={styles.headerTitle}><Text numberOfLines={1} style={styles.sessionTitle}>{session?.title ?? 'New session'}</Text><Text style={styles.status}>{connected ? session?.running ? 'RESPONDING' : 'LIVE HOST' : stateLabel(remoteState)}</Text></View><Pressable accessibilityLabel="Open session details" accessibilityRole="button" onPress={onOpenDetails} style={styles.iconButton}><Text style={styles.iconText}>•••</Text></Pressable></View>
    <ScrollView contentContainerStyle={styles.conversation} keyboardShouldPersistTaps="handled">{session === undefined ? <EmptyConversation onConnect={onConnect} onPair={onOpenPairing} paired={pairing !== undefined} state={remoteState} /> : <><Text style={styles.liveLabel}>LIVE HOST SESSION</Text>{session.messages.length === 0 && <Text style={styles.emptyThread}>The Host has not streamed conversation content yet.</Text>}{session.messages.map(message => <View key={message.id} style={message.role === 'user' ? styles.userBubble : styles.assistantBubble}><Text style={styles.messageText}>{message.text}</Text></View>)}{session.running && <Text style={styles.runningText}>DSH is working on the Host…</Text>}</>}</ScrollView>
    <View style={styles.composerShell}><View style={[styles.composer, (!connected || session === undefined) && styles.composerDisabled]}><TextInput accessibilityLabel="Message DSH" editable={connected && session !== undefined && !session.running} multiline onChangeText={onChangeDraft} placeholder={connected ? 'Message DSH' : 'Connect DSH Host to message'} placeholderTextColor={colors.muted} style={styles.input} value={draft} /><Pressable accessibilityLabel="Send message" accessibilityRole="button" disabled={!connected || session === undefined || session.running || draft.trim() === ''} onPress={onSend} style={[styles.send, (!connected || session === undefined || session.running || draft.trim() === '') && styles.sendDisabled]}><Text style={styles.sendText}>↑</Text></Pressable></View><Text style={styles.composerNote}>{connected ? 'Messages are sent to the selected live Host session.' : 'No local or cached conversation is created while disconnected.'}</Text></View>
  </KeyboardAvoidingView>
}

function EmptyConversation({ onConnect, onPair, paired, state }: {
  readonly onConnect: () => void
  readonly onPair: () => void
  readonly paired: boolean
  readonly state: MobileRemoteState
}): React.JSX.Element {
  return <View style={styles.empty}><Image accessibilityIgnoresInvertColors source={deepSeekMark} style={styles.mark} /><Text style={styles.emptyTitle}>{paired ? 'Host invitation verified' : 'Your DSH Host'}</Text><Text style={styles.emptyCopy}>{paired ? 'Connect this protected phone to its signed DSH Host.' : state.kind === 'unconfigured' ? 'Pair this phone locally with your signed DSH Host. No desktop bridge or preview history is used.' : 'The encrypted connection is not currently live.'}</Text><Pressable accessibilityRole="button" onPress={paired ? onConnect : onPair} style={styles.pairAction}><Text style={styles.pairActionText}>{paired ? 'Connect to Host' : 'Pair this phone'}</Text></Pressable></View>
}

function SessionDrawer({ onClose, onCreateSession, onOpenConnection, onOpenPairing, onRefresh, onSelectSession, remoteState, workspace }: {
  readonly onClose: () => void
  readonly onCreateSession: () => void
  readonly onOpenConnection: () => void
  readonly onOpenPairing: () => void
  readonly onRefresh: () => void
  readonly onSelectSession: (id: string) => void
  readonly remoteState: MobileRemoteState
  readonly workspace: OwnerWorkspace
}): React.JSX.Element {
  const connected = remoteState.kind === 'connected'
  return <View style={styles.screen}><View style={styles.drawerHeader}><Pressable accessibilityLabel="Close sessions" accessibilityRole="button" onPress={onClose} style={styles.iconButton}><Text style={styles.iconText}>‹</Text></Pressable><Brand /><View style={styles.iconButton} /></View><ScrollView contentContainerStyle={styles.drawer}><Pressable accessibilityRole="button" onPress={onCreateSession} style={styles.newButton}><Text style={styles.newText}>＋ New session</Text></Pressable><View style={styles.drawerRow}><Text style={styles.sectionLabel}>RECENT SESSIONS</Text><Pressable accessibilityRole="button" onPress={onRefresh}><Text style={styles.refresh}>Refresh</Text></Pressable></View>{workspace.sessions.length === 0 ? <Text style={styles.drawerEmpty}>{connected ? 'No sessions received from the Host yet.' : 'Connect a DSH Host to see its live sessions.'}</Text> : workspace.sessions.map(session => <Pressable key={session.id} accessibilityRole="button" onPress={() => onSelectSession(session.id)} style={styles.sessionRow}><Image accessibilityIgnoresInvertColors source={deepSeekMark} style={styles.rowMark} /><View style={styles.rowCopy}><Text numberOfLines={1} style={styles.rowTitle}>{session.title}</Text><Text numberOfLines={1} style={styles.rowDetail}>{session.running ? 'Responding' : `${session.messages.length} live messages`}</Text></View><Text style={styles.chevron}>›</Text></Pressable>)}<View style={styles.drawerFooter}><Pressable accessibilityRole="button" onPress={onOpenConnection} style={styles.connectionCard}><View style={[styles.dot, connected && styles.dotLive]} /><View style={styles.rowCopy}><Text style={styles.rowTitle}>{connected ? 'DSH Host connected' : stateLabel(remoteState)}</Text><Text style={styles.rowDetail}>{connected ? 'Encrypted remote connection' : 'Open connection controls'}</Text></View><Text style={styles.chevron}>›</Text></Pressable></View></ScrollView></View>
}

function ConnectionSheet({ onConnect, onForget, onPair, pairing, state }: {
  readonly onConnect: () => void
  readonly onForget: () => void
  readonly onPair: () => void
  readonly pairing: PairingSummary | undefined
  readonly state: MobileRemoteState
}): React.JSX.Element {
  const busy = state.kind === 'connected' || state.kind === 'connecting'
  const rePair = state.kind === 're-pair-required'
  return <><Text style={styles.sheetEyebrow}>DSH HOST</Text><Text style={styles.sheetTitle}>Connection</Text><Text style={styles.sheetCopy}>{pairing === undefined ? 'Pair this phone locally with the signed DSH Host.' : rePair ? 'The Host cannot confirm this route’s next epoch. Import a fresh local Host invitation before connecting again.' : 'The invitation is verified. Connecting opens the fixed encrypted relay to this signed Host.'}</Text><View style={styles.infoCard}><Info label="Connection" value={stateLabel(state)} /><Info label="Identity" value="Protected native identity" /><Info label="Pairing" value={pairing === undefined ? 'Not imported' : rePair ? 'Fresh invitation required' : 'Invitation verified'} /></View><Pressable accessibilityRole="button" disabled={pairing !== undefined && busy} onPress={pairing === undefined || rePair ? onPair : onConnect} style={[styles.primaryButton, pairing !== undefined && busy && styles.buttonDisabled]}><Text style={styles.primaryButtonText}>{pairing === undefined ? 'Pair this phone' : rePair ? 'Import fresh invitation' : state.kind === 'connected' ? 'Host connected' : state.kind === 'connecting' ? 'Connecting…' : state.kind === 'error' || state.kind === 'reconnecting' ? 'Retry connection' : 'Connect to Host'}</Text></Pressable>{pairing !== undefined && <><Pressable accessibilityRole="button" onPress={onPair} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Manage pairing</Text></Pressable><Pressable accessibilityRole="button" onPress={onForget} style={styles.destructiveButton}><Text style={styles.destructiveButtonText}>Forget invitation</Text></Pressable></>}</>
}

function PairingSheet({ existing, onConnect, onImport, onRemotePair, onOpenForget }: {
  readonly existing: PairingSummary | undefined
  readonly onConnect: () => void
  readonly onImport: (value: unknown) => Promise<PairingSummary>
  readonly onRemotePair: (code: string, offer: MobileEnrollmentOffer) => Promise<PairingSummary>
  readonly onOpenForget: () => void
}): React.JSX.Element {
  const [mode, setMode] = useState<'start' | 'offer' | 'import' | 'remote' | 'scan' | 'ready'>(existing === undefined ? 'start' : 'ready')
  const [label, setLabel] = useState('DSH Mobile')
  const [offer, setOffer] = useState<MobileEnrollmentOffer | undefined>()
  const [invitation, setInvitation] = useState('')
  const [pairingCode, setPairingCode] = useState('')
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [summary, setSummary] = useState<PairingSummary | undefined>(existing)
  const [cameraPermission, requestCameraPermission] = useCameraPermissions()
  const prepareOffer = async (nextMode: 'offer' | 'remote') => {
    setError(undefined)
    try {
      setOffer(await createMobileEnrollmentOffer(label, nativeMobileIdentityProvider))
      setMode(nextMode)
    } catch (cause) {
      setError(pairingError(cause))
    }
  }
  const importInvitation = async () => {
    const raw = invitation.trim()
    setInvitation('')
    setError(undefined)
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { setError('Paste the complete Host invitation. It has not been retained.'); return }
    try { const imported = await onImport(parsed); setSummary(imported); setMode('ready') } catch (cause) { setError(pairingError(cause)) }
  }
  const submitRemotePairing = async (code = pairingCode) => {
    if (remoteBusy || offer === undefined) return
    setRemoteBusy(true)
    setError(undefined); setPairingCode('')
    try { const imported = await onRemotePair(code, offer); setSummary(imported); setMode('ready') } catch (cause) { setError(pairingError(cause)); setMode('remote') } finally { setRemoteBusy(false) }
  }
  const beginScan = async () => {
    if (cameraPermission?.granted) return setMode('scan')
    const result = await requestCameraPermission()
    if (result.granted) setMode('scan'); else setError('Camera access is needed to scan the Host QR code. You can enter its pairing code instead.')
  }
  return <><Text style={styles.sheetEyebrow}>{mode === 'remote' || mode === 'scan' ? 'INTERNET PAIRING' : 'LOCAL PAIRING'}</Text><Text style={styles.sheetTitle}>{mode === 'ready' ? 'Host invitation verified' : mode === 'offer' ? 'Transfer this phone offer' : mode === 'import' ? 'Import Host invitation' : mode === 'scan' ? 'Scan Host code' : mode === 'remote' ? 'Pair from anywhere' : 'Pair this phone'}</Text><Text style={styles.sheetCopy}>{mode === 'ready' ? 'The invitation matches this protected phone identity. No connection is opened here.' : mode === 'remote' || mode === 'scan' ? 'Scan or enter the short-lived code from your signed DSH Host. It works on cellular data or any internet connection and still requires approval at the Host.' : 'Pairing is a physical local transfer between this phone and your signed DSH Host.'}</Text>
    {mode === 'start' && <><Text style={styles.fieldLabel}>PHONE LABEL</Text><TextInput accessibilityLabel="Phone label" autoCorrect={false} maxLength={64} onChangeText={setLabel} style={styles.fieldInput} value={label} /><Pressable accessibilityRole="button" onPress={() => void prepareOffer('remote')} style={styles.primaryButton}><Text style={styles.primaryButtonText}>Scan or enter pairing code</Text></Pressable><Pressable accessibilityRole="button" onPress={() => void prepareOffer('offer')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Use local transfer instead</Text></Pressable><Pressable accessibilityRole="button" onPress={() => { setError(undefined); setMode('import') }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Import Host invitation</Text></Pressable></>}
    {mode === 'offer' && offer !== undefined && <><PhoneFingerprint offer={offer} /><View style={styles.publicOffer}><Text style={styles.publicOfferLabel}>PUBLIC PHONE IDENTITY</Text><Text selectable style={styles.offerCode}>{JSON.stringify(offer)}</Text></View><Text style={styles.safeNote}>Transfer this public offer locally to the signed Host. Compare the fingerprint above before approving. The offer contains no private key, shared secret, route token, or relay credential.</Text><Pressable accessibilityRole="button" onPress={() => { setError(undefined); setMode('import') }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>I have the Host invitation</Text></Pressable></>}
    {mode === 'remote' && offer !== undefined && <><PhoneFingerprint offer={offer} /><Pressable accessibilityLabel="Scan Host pairing code" accessibilityRole="button" onPress={() => void beginScan()} style={styles.scanCard}><View style={styles.scanMark}><Text style={styles.scanGlyph}>⌁</Text></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>Scan Host pairing code</Text><Text style={styles.rowDetail}>Use the QR code shown by the signed Host.</Text></View></Pressable><Text style={styles.fieldLabel}>PAIRING CODE</Text><TextInput accessibilityLabel="Host pairing code" autoCapitalize="none" autoCorrect={false} onChangeText={setPairingCode} placeholder="dsh3.…" placeholderTextColor={colors.muted} spellCheck={false} style={styles.fieldInput} value={pairingCode} /><Text style={styles.safeNote}>Keep this fingerprint visible while the Host asks for approval. Approve only when every group matches.</Text><Pressable accessibilityRole="button" disabled={remoteBusy || pairingCode.trim() === ''} onPress={() => void submitRemotePairing()} style={[styles.primaryButton, (remoteBusy || pairingCode.trim() === '') && styles.buttonDisabled]}><Text style={styles.primaryButtonText}>{remoteBusy ? 'Waiting for Host approval…' : 'Pair with Host'}</Text></Pressable></>}
    {mode === 'scan' && offer !== undefined && <><PhoneFingerprint offer={offer} /><View style={{ height: 300, marginTop: 18, overflow: 'hidden', borderRadius: 16 }}><CameraView barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={remoteBusy ? undefined : ({ data }) => { setPairingCode(data); void submitRemotePairing(data) }} style={{ flex: 1 }} /></View><Pressable accessibilityRole="button" onPress={() => setMode('remote')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Enter code instead</Text></Pressable></>}
    {mode === 'import' && <><Pressable accessibilityHint="Explains why camera scanning is unavailable" accessibilityLabel="Scan Host invitation" accessibilityRole="button" onPress={() => setError('Camera scanning is not installed in this build. Paste the Host invitation instead.')} style={styles.scanCard}><View style={styles.scanMark}><Text style={styles.scanGlyph}>⌁</Text></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>Scan Host invitation</Text><Text style={styles.rowDetail}>Camera scanning is not installed in this build.</Text></View></Pressable><Text style={styles.fieldLabel}>PASTE HOST INVITATION</Text><TextInput accessibilityLabel="Paste Host invitation" autoCapitalize="none" autoCorrect={false} multiline onChangeText={setInvitation} placeholder="{…}" placeholderTextColor={colors.muted} spellCheck={false} style={styles.invitationInput} textAlignVertical="top" value={invitation} /><Text style={styles.safeNote}>The pasted invitation is validated, then cleared. It is never shown after import or written to logs.</Text><Pressable accessibilityRole="button" disabled={invitation.trim() === ''} onPress={() => void importInvitation()} style={[styles.primaryButton, invitation.trim() === '' && styles.buttonDisabled]}><Text style={styles.primaryButtonText}>Validate invitation</Text></Pressable></>}
    {mode === 'ready' && summary !== undefined && <><View style={styles.readyCard}><View style={styles.readyDot} /><View style={styles.rowCopy}><Text style={styles.rowTitle}>Ready to connect to DSH Host</Text><Text style={styles.rowDetail}>Transfer verified {new Date(summary.expiresAt).toLocaleString()}</Text></View></View><Text style={styles.safeNote}>The transfer expiry does not revoke this enrolled route. Connecting requires device-owner authentication and the matching signed Host relay. Device revocation remains a Host action.</Text><Pressable accessibilityRole="button" onPress={onConnect} style={styles.primaryButton}><Text style={styles.primaryButtonText}>Connect to Host</Text></Pressable><Pressable accessibilityRole="button" onPress={() => { setInvitation(''); setError(undefined); setMode('import') }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Import fresh Host invitation</Text></Pressable><Pressable accessibilityRole="button" onPress={onOpenForget} style={styles.destructiveButton}><Text style={styles.destructiveButtonText}>Forget invitation</Text></Pressable></>}
    {error !== undefined && <View accessibilityLiveRegion="polite" style={styles.errorCard}><Text style={styles.errorTitle}>Could not continue pairing</Text><Text style={styles.errorCopy}>{error}</Text></View>}
  </>
}

function PhoneFingerprint({ offer }: { readonly offer: MobileEnrollmentOffer }): React.JSX.Element {
  return <View style={styles.publicOffer}><Text style={styles.publicOfferLabel}>PHONE FINGERPRINT</Text><Text accessibilityLabel="Phone identity fingerprint" selectable style={styles.offerCode}>{fingerprintMobileEnrollmentOffer(offer)}</Text></View>
}

function ForgetSheet({ onCancel, onForget }: { readonly onCancel: () => void; readonly onForget: () => void }): React.JSX.Element {
  return <><Text style={styles.sheetEyebrow}>LOCAL DEVICE</Text><Text style={styles.sheetTitle}>Forget this invitation?</Text><Text style={styles.sheetCopy}>This clears the invitation held by this app and closes any connection. It does not revoke the enrolled phone at the Host. Revoke the device from the signed Host when it is lost or no longer trusted.</Text><Pressable accessibilityRole="button" onPress={onForget} style={styles.forgetButton}><Text style={styles.forgetButtonText}>Forget and disconnect</Text></Pressable><Pressable accessibilityRole="button" onPress={onCancel} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Keep invitation</Text></Pressable></>
}

function HostDetails({ session, workspace }: {
  readonly session: OwnerSession | undefined
  readonly workspace: OwnerWorkspace
}): React.JSX.Element {
  return <><Text style={styles.sheetEyebrow}>HOST SESSION</Text><Text style={styles.sheetTitle}>{session?.title ?? 'Host details'}</Text><Text style={styles.sheetCopy}>These controls are rendered only from the same Host event stream as desktop and web. Screen streaming and computer control are intentionally absent.</Text><View style={styles.infoCard}><Info label="Approvals" value={`${workspace.approvals.length} pending`} /><Info label="Tools" value={`${session?.tools.length ?? 0} Host-rendered cards`} /><Info label="Files, diff, terminal" value="Appear only when the Host streams an action card" /></View></>
}

function ModalSheet({ children, onClose }: { readonly children: React.ReactNode; readonly onClose: () => void }): React.JSX.Element {
  return <KeyboardAvoidingView behavior={Platform.select({ ios: 'padding', default: undefined })} style={styles.overlay}><Pressable accessibilityLabel="Close sheet" onPress={onClose} style={styles.backdrop} /><View style={styles.sheet}><Pressable accessibilityLabel="Close" accessibilityRole="button" onPress={onClose} style={styles.close}><Text style={styles.closeText}>×</Text></Pressable><ScrollView automaticallyAdjustKeyboardInsets contentContainerStyle={{ paddingBottom: 8 }} keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }}>{children}</ScrollView></View></KeyboardAvoidingView>
}

function Info({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return <View style={styles.info}><Text style={styles.infoLabel}>{label}</Text><Text style={styles.infoValue}>{value}</Text></View>
}
function Brand(): React.JSX.Element {
  return <View style={styles.brand}>
    <Image accessibilityIgnoresInvertColors source={deepSeekMark} style={styles.brandMark} />
    <Text style={styles.brandText}>DSH</Text>
  </View>
}
function stateLabel(state: MobileRemoteState): string { if (state.kind === 'connected') return 'LIVE HOST'; if (state.kind === 'connecting') return 'CONNECTING'; if (state.kind === 'reconnecting') return 'RECONNECTING'; if (state.kind === 're-pair-required') return 'RE-PAIR REQUIRED'; if (state.kind === 'revoked') return 'DEVICE REVOKED'; if (state.kind === 'error') return 'CONNECTION STOPPED'; if (state.kind === 'disconnected') return 'DISCONNECTED'; return 'HOST NOT PAIRED' }
function pairingError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : ''
  if (message.includes('expired')) return 'This Host invitation has expired. Generate a new one from the Host.'
  if (message.includes('different protected mobile identity')) return 'This invitation belongs to a different protected phone identity.'
  if (message.includes('Expo Go')) return 'Use a signed DSH Mobile development or production build. Expo Go cannot pair this phone.'
  if (message.includes('label')) return 'Choose a visible device label between 1 and 64 characters.'
  return 'The Host invitation is invalid or incomplete. It has not been retained.'
}

const colors = { accent: '#657BFF', border: '#2C3240', card: '#11151E', ink: '#F4F6FC', muted: '#8E96A8', page: '#080A0E', danger: '#EE9AA5', user: '#222B4A' }
const styles = StyleSheet.create({
  approval: { backgroundColor: '#201B18', borderColor: '#674D3D', borderRadius: 13, borderWidth: 1, gap: 4, marginTop: 10, padding: 13 }, assistantBubble: { alignSelf: 'flex-start', backgroundColor: colors.card, borderColor: colors.border, borderRadius: 18, borderTopLeftRadius: 5, borderWidth: 1, maxWidth: '85%', padding: 13 }, backdrop: { flex: 1 }, brand: { alignItems: 'center', flexDirection: 'row', gap: 8 }, brandMark: { height: 25, width: 25 }, brandText: { color: colors.ink, fontSize: 16, fontWeight: '800', letterSpacing: 1 }, buttonDisabled: { backgroundColor: '#555B6C' }, chevron: { color: colors.muted, fontSize: 24 }, close: { alignSelf: 'flex-end', padding: 5 }, closeText: { color: colors.ink, fontSize: 28 }, composer: { alignItems: 'flex-end', backgroundColor: '#151923', borderColor: colors.border, borderRadius: 22, borderWidth: 1, flexDirection: 'row', padding: 7 }, composerDisabled: { opacity: .66 }, composerNote: { color: colors.muted, fontSize: 11, paddingTop: 7, textAlign: 'center' }, composerShell: { borderTopColor: '#1A1E29', borderTopWidth: 1, padding: 12 }, connectionCard: { alignItems: 'center', backgroundColor: colors.card, borderColor: colors.border, borderRadius: 16, borderWidth: 1, flexDirection: 'row', gap: 11, padding: 13 }, conversation: { flexGrow: 1, gap: 12, padding: 16 }, dot: { backgroundColor: '#6F7380', borderRadius: 5, height: 9, width: 9 }, dotLive: { backgroundColor: '#75C58C' }, drawer: { flexGrow: 1, padding: 20 }, drawerEmpty: { color: colors.muted, fontSize: 14, lineHeight: 21, paddingTop: 12 }, drawerFooter: { marginTop: 'auto', paddingTop: 38 }, drawerHeader: { alignItems: 'center', borderBottomColor: '#171C25', borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', padding: 16 }, drawerRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingTop: 27 }, empty: { alignItems: 'center', backgroundColor: '#10141D', borderColor: colors.border, borderRadius: 22, borderWidth: 1, gap: 11, marginTop: 44, padding: 31 }, emptyCopy: { color: colors.muted, fontSize: 15, lineHeight: 22, textAlign: 'center' }, emptyThread: { color: colors.muted, fontSize: 14, paddingTop: 18, textAlign: 'center' }, emptyTitle: { color: colors.ink, fontSize: 21, fontWeight: '700' }, errorCard: { backgroundColor: '#2A161B', borderColor: '#75414B', borderRadius: 15, borderWidth: 1, gap: 5, marginTop: 15, padding: 14 }, errorCopy: { color: '#E7B7BD', fontSize: 13, lineHeight: 19 }, errorTitle: { color: '#F6C9CF', fontSize: 14, fontWeight: '700' }, fieldInput: { backgroundColor: '#151923', borderColor: colors.border, borderRadius: 13, borderWidth: 1, color: colors.ink, fontSize: 16, marginTop: 8, padding: 13 }, fieldLabel: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.1, marginTop: 16 }, forgetButton: { alignItems: 'center', backgroundColor: '#4C242D', borderRadius: 13, marginTop: 24, padding: 14 }, forgetButtonText: { color: '#FFD8DE', fontSize: 15, fontWeight: '800' }, header: { alignItems: 'center', borderBottomColor: '#171C25', borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', padding: 12 }, headerTitle: { alignItems: 'center', flex: 1, gap: 3, paddingHorizontal: 9 }, iconButton: { alignItems: 'center', borderColor: colors.border, borderRadius: 11, borderWidth: 1, height: 37, justifyContent: 'center', width: 40 }, iconText: { color: colors.ink, fontSize: 20, lineHeight: 23 }, info: { gap: 4 }, infoCard: { backgroundColor: colors.card, borderColor: colors.border, borderRadius: 17, borderWidth: 1, gap: 15, marginTop: 23, padding: 15 }, infoLabel: { color: colors.ink, fontSize: 14, fontWeight: '700' }, infoValue: { color: colors.muted, fontSize: 13 }, input: { color: colors.ink, flex: 1, fontSize: 16, maxHeight: 110, minHeight: 38, paddingHorizontal: 8 }, invitationInput: { backgroundColor: '#151923', borderColor: colors.border, borderRadius: 13, borderWidth: 1, color: colors.ink, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12, lineHeight: 18, marginTop: 8, minHeight: 124, padding: 13 }, liveLabel: { alignSelf: 'center', color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.1 }, mark: { height: 45, width: 45 }, messageText: { color: colors.ink, fontSize: 16, lineHeight: 23 }, newButton: { backgroundColor: colors.accent, borderRadius: 13, padding: 14 }, newText: { color: '#FFF', fontSize: 15, fontWeight: '800' }, offerCode: { color: '#C8D2FF', fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 11, lineHeight: 17 }, overlay: { backgroundColor: 'rgba(0,0,0,.58)', bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 }, page: { backgroundColor: colors.page, flex: 1 }, pairAction: { backgroundColor: colors.accent, borderRadius: 13, marginTop: 8, paddingHorizontal: 20, paddingVertical: 12 }, pairActionText: { color: '#FFF', fontSize: 15, fontWeight: '800' }, panel: { flex: 1 }, primaryButton: { alignItems: 'center', backgroundColor: colors.accent, borderRadius: 13, marginTop: 16, padding: 14 }, primaryButtonText: { color: '#FFF', fontSize: 15, fontWeight: '800' }, publicOffer: { backgroundColor: '#101827', borderColor: '#3A4A77', borderRadius: 16, borderWidth: 1, gap: 10, marginTop: 17, padding: 15 }, publicOfferLabel: { color: '#A8B6FF', fontSize: 10, fontWeight: '800', letterSpacing: 1 }, readyCard: { alignItems: 'center', backgroundColor: '#121D19', borderColor: '#37614A', borderRadius: 16, borderWidth: 1, flexDirection: 'row', gap: 11, marginTop: 17, padding: 15 }, readyDot: { backgroundColor: '#75C58C', borderRadius: 5, height: 10, width: 10 }, refresh: { color: '#A8B6FF', fontSize: 13, fontWeight: '700' }, rowCopy: { flex: 1, gap: 3 }, rowDetail: { color: colors.muted, fontSize: 13, lineHeight: 18 }, rowMark: { height: 29, width: 29 }, rowTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' }, runningText: { color: colors.muted, fontSize: 13, fontStyle: 'italic' }, safeNote: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 10 }, scanCard: { alignItems: 'center', backgroundColor: '#151923', borderColor: colors.border, borderRadius: 15, borderWidth: 1, flexDirection: 'row', gap: 12, marginTop: 17, padding: 14 }, scanGlyph: { color: '#A8B6FF', fontSize: 22 }, scanMark: { alignItems: 'center', borderColor: '#3A4A77', borderRadius: 10, borderWidth: 1, height: 38, justifyContent: 'center', width: 38 }, screen: { backgroundColor: colors.page, flex: 1 }, secondaryButton: { alignItems: 'center', borderColor: '#4B5468', borderRadius: 13, borderWidth: 1, marginTop: 10, padding: 14 }, secondaryButtonText: { color: '#D5DBE8', fontSize: 15, fontWeight: '700' }, sectionLabel: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.1 }, send: { alignItems: 'center', backgroundColor: colors.accent, borderRadius: 17, height: 35, justifyContent: 'center', width: 35 }, sendDisabled: { backgroundColor: '#3A4050' }, sendText: { color: '#FFF', fontSize: 22, fontWeight: '700', lineHeight: 24 }, sessionRow: { alignItems: 'center', borderBottomColor: '#1B202B', borderBottomWidth: 1, flexDirection: 'row', gap: 11, minHeight: 66, paddingVertical: 9 }, sessionTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' }, sheet: { backgroundColor: '#0E121A', borderColor: colors.border, borderTopLeftRadius: 25, borderTopRightRadius: 25, borderWidth: 1, bottom: 0, left: 0, maxHeight: '88%', padding: 20, position: 'absolute', right: 0 }, sheetCopy: { color: colors.muted, fontSize: 15, lineHeight: 22, marginTop: 8 }, sheetEyebrow: { color: '#A8B6FF', fontSize: 10, fontWeight: '800', letterSpacing: 1.2 }, sheetTitle: { color: colors.ink, fontSize: 27, fontWeight: '700', letterSpacing: -.4, marginTop: 6 }, status: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1 }, userBubble: { alignSelf: 'flex-end', backgroundColor: colors.user, borderRadius: 18, borderTopRightRadius: 5, maxWidth: '85%', padding: 13 }, destructiveButton: { alignItems: 'center', borderColor: '#76414A', borderRadius: 13, borderWidth: 1, marginTop: 12, padding: 14 }, destructiveButtonText: { color: colors.danger, fontSize: 15, fontWeight: '700' },
})
