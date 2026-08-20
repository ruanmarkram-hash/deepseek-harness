import { StatusBar } from 'expo-status-bar'
import { useState } from 'react'
import {
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

type Screen = 'sessions' | 'conversation' | 'settings'

const previewSessions = [
  { id: 'workspace', title: 'Prepare the workspace', detail: 'A local interface preview', time: 'Preview' },
  { id: 'review', title: 'Review a change', detail: 'Pair a desktop to load history', time: 'Preview' },
  { id: 'handoff', title: 'Continue a handoff', detail: 'No remote session is connected', time: 'Preview' },
] as const

/** Renders the mobile product shell without a gateway, session transport, or credential storage. */
export default function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('sessions')
  const [selectedSession, setSelectedSession] = useState<(typeof previewSessions)[number]>(previewSessions[0])
  const [draft, setDraft] = useState('')
  const [pairingNoticeVisible, setPairingNoticeVisible] = useState(false)

  const openConversation = (session: typeof previewSessions[number]) => {
    setSelectedSession(session)
    setScreen('conversation')
  }

  const openPairing = () => {
    setPairingNoticeVisible(true)
    setScreen('settings')
  }

  return <SafeAreaView style={styles.page}>
    <StatusBar style="light" />
    {screen === 'sessions' && <SessionsScreen onOpenConversation={openConversation} onOpenSettings={() => setScreen('settings')} onPair={openPairing} />}
    {screen === 'conversation' && <ConversationScreen draft={draft} onBack={() => setScreen('sessions')} onChangeDraft={setDraft} onPair={openPairing} session={selectedSession} />}
    {screen === 'settings' && <SettingsScreen pairingNoticeVisible={pairingNoticeVisible} onBack={() => setScreen('sessions')} onPair={openPairing} />}
  </SafeAreaView>
}

/** Shows the only available mobile state: a local preview waiting for a paired desktop. */
function SessionsScreen({
  onOpenConversation,
  onOpenSettings,
  onPair,
}: {
  onOpenConversation: (session: typeof previewSessions[number]) => void
  onOpenSettings: () => void
  onPair: () => void
}): React.JSX.Element {
  return <View style={styles.screen}>
    <ScrollView contentContainerStyle={styles.sessionsContent} showsVerticalScrollIndicator={false}>
      <View style={styles.topBar}>
        <View style={styles.brandRow}>
          <View style={styles.brandMark}><Text style={styles.brandMarkText}>D</Text></View>
          <Text style={styles.brand}>DSH</Text>
        </View>
        <Pressable accessibilityLabel="Open settings" accessibilityRole="button" hitSlop={10} onPress={onOpenSettings} style={styles.iconButton}>
          <Text style={styles.iconButtonText}>•••</Text>
        </Pressable>
      </View>

      <View style={styles.headingBlock}>
        <Text style={styles.eyebrow}>MOBILE WORKSPACE</Text>
        <Text style={styles.title}>Your sessions</Text>
        <Text style={styles.subtitle}>Stay in the thread, then take the work back to your paired desktop.</Text>
      </View>

      <View accessibilityLabel="Not paired" style={styles.offlineBanner}>
        <View style={styles.statusDot} />
        <View style={styles.offlineCopy}>
          <Text style={styles.offlineTitle}>Desktop not paired</Text>
          <Text style={styles.offlineText}>Session history will appear here after secure pairing is available.</Text>
        </View>
        <Pressable accessibilityLabel="Open pairing settings" accessibilityRole="button" onPress={onPair} style={styles.compactButton}>
          <Text style={styles.compactButtonText}>Pair</Text>
        </Pressable>
      </View>

      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>Interface preview</Text>
        <Text style={styles.sectionMeta}>LOCAL ONLY</Text>
      </View>
      <Text style={styles.sectionDescription}>These sample rows show the session browser. They are not synced sessions.</Text>

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
          <View style={styles.sessionAvatar}><Text style={styles.sessionAvatarText}>{session.title.slice(0, 1)}</Text></View>
          <View style={styles.sessionCopy}>
            <Text numberOfLines={1} style={styles.sessionTitle}>{session.title}</Text>
            <Text numberOfLines={1} style={styles.sessionDetail}>{session.detail}</Text>
          </View>
          <View style={styles.sessionTime}>
            <Text style={styles.sessionTimeText}>{session.time}</Text>
            <Text style={styles.chevron}>›</Text>
          </View>
        </Pressable>)}
      </View>
    </ScrollView>
    <BottomNavigation active="sessions" onOpenSessions={() => undefined} onOpenSettings={onOpenSettings} />
  </View>
}

/** Renders an immersive preview of one conversation while preventing unpaired message delivery. */
function ConversationScreen({
  draft,
  onBack,
  onChangeDraft,
  onPair,
  session,
}: {
  draft: string
  onBack: () => void
  onChangeDraft: (text: string) => void
  onPair: () => void
  session: typeof previewSessions[number]
}): React.JSX.Element {
  return <KeyboardAvoidingView behavior={Platform.select({ ios: 'padding', default: undefined })} style={styles.screen}>
    <View style={styles.conversationTopBar}>
      <Pressable accessibilityLabel="Back to sessions" accessibilityRole="button" hitSlop={10} onPress={onBack} style={styles.backButton}>
        <Text style={styles.backChevron}>‹</Text><Text style={styles.backText}>Sessions</Text>
      </Pressable>
      <View style={styles.conversationTitleWrap}>
        <Text numberOfLines={1} style={styles.conversationTitle}>{session.title}</Text>
        <Text style={styles.conversationStatus}>LOCAL PREVIEW</Text>
      </View>
      <View style={styles.topBarSpacer} />
    </View>

    <ScrollView contentContainerStyle={styles.conversationContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <View style={styles.conversationNotice}>
        <Text style={styles.conversationNoticeTitle}>This device is not paired</Text>
        <Text style={styles.conversationNoticeText}>
          The conversation layout is ready, but DSH cannot load or send session data until the authenticated mobile gateway exists.
        </Text>
        <Pressable accessibilityRole="button" onPress={onPair} style={styles.noticeAction}>
          <Text style={styles.noticeActionText}>View pairing</Text>
        </Pressable>
      </View>

      <Text style={styles.dayLabel}>LOCAL PREVIEW</Text>
      <View style={styles.assistantMessage}>
        <Text style={styles.assistantMessageText}>
          This is where DSH responses, progress, and approvals will appear when a paired desktop streams the session to this phone.
        </Text>
      </View>
      <View style={styles.userMessage}><Text style={styles.userMessageText}>Can I continue this session from my phone?</Text></View>
      <View style={styles.assistantMessage}>
        <Text style={styles.assistantMessageText}>
          Yes, after pairing. Computer use and macOS permissions remain on the desktop. This mobile screen never receives those permissions.
        </Text>
      </View>
    </ScrollView>

    <View style={styles.composerShell}>
      <View style={styles.composer}>
        <TextInput
          accessibilityLabel="Message draft"
          multiline
          onChangeText={onChangeDraft}
          placeholder="Message DSH"
          placeholderTextColor={colors.muted}
          style={styles.composerInput}
          value={draft}
        />
        <Pressable
          accessibilityHint="Opens pairing settings because this device is disconnected"
          accessibilityLabel={draft.trim() === '' ? 'Pair a desktop to send messages' : 'Pair a desktop to send this draft'}
          accessibilityRole="button"
          onPress={onPair}
          style={({ pressed }) => [styles.sendButton, pressed && styles.pressed]}
        >
          <Text style={styles.sendButtonText}>↑</Text>
        </Pressable>
      </View>
      <Text style={styles.composerHint}>{draft.trim() === '' ? 'Pair a desktop before messaging.' : 'Your draft stays only in this open preview.'}</Text>
    </View>
  </KeyboardAvoidingView>
}

/** Explains the pending gateway and pairing boundary without collecting any address or credential. */
function SettingsScreen({
  pairingNoticeVisible,
  onBack,
  onPair,
}: {
  pairingNoticeVisible: boolean
  onBack: () => void
  onPair: () => void
}): React.JSX.Element {
  return <View style={styles.screen}>
    <View style={styles.settingsTopBar}>
      <Pressable accessibilityLabel="Back to sessions" accessibilityRole="button" hitSlop={10} onPress={onBack} style={styles.backButton}>
        <Text style={styles.backChevron}>‹</Text><Text style={styles.backText}>Sessions</Text>
      </Pressable>
    </View>
    <ScrollView contentContainerStyle={styles.settingsContent} showsVerticalScrollIndicator={false}>
      <Text style={styles.settingsTitle}>Settings</Text>
      <Text style={styles.settingsSubtitle}>This device has no DSH connection.</Text>

      <Text style={styles.settingsSectionLabel}>CONNECTION</Text>
      <View style={styles.settingsCard}>
        <View style={styles.settingsRow}>
          <View style={styles.settingsRowCopy}>
            <Text style={styles.settingsRowTitle}>Paired desktop</Text>
            <Text style={styles.settingsRowDetail}>Not connected</Text>
          </View>
          <View style={styles.unavailablePill}><Text style={styles.unavailablePillText}>UNAVAILABLE</Text></View>
        </View>
        <View style={styles.settingsDivider} />
        <Text style={styles.settingsExplanation}>
          Pairing needs an authenticated DSH mobile gateway. It is not implemented in this app yet, so no address, QR code,
          or account token is collected or saved.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={onPair}
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
        >
          <Text style={styles.primaryButtonText}>Pair a desktop</Text>
        </Pressable>
        {pairingNoticeVisible && <Text style={styles.pendingNotice}>
          Pairing will become available with the remote gateway. This button does not connect to anything today.
        </Text>}
      </View>

      <Text style={styles.settingsSectionLabel}>MOBILE SCOPE</Text>
      <View style={styles.settingsCard}>
        <SettingFact title="Session state" value="Requires paired gateway" />
        <View style={styles.settingsDivider} />
        <SettingFact title="Message delivery" value="Disabled while disconnected" />
        <View style={styles.settingsDivider} />
        <SettingFact title="Computer use" value="Desktop only" />
      </View>
    </ScrollView>
    <BottomNavigation active="settings" onOpenSessions={onBack} onOpenSettings={() => undefined} />
  </View>
}

/** Displays one immutable mobile capability fact. */
function SettingFact({ title, value }: { title: string; value: string }): React.JSX.Element {
  return <View style={styles.factRow}><Text style={styles.factTitle}>{title}</Text><Text style={styles.factValue}>{value}</Text></View>
}

/** Keeps top-level navigation available without a navigation dependency. */
function BottomNavigation({
  active,
  onOpenSessions,
  onOpenSettings,
}: {
  active: 'sessions' | 'settings'
  onOpenSessions: () => void
  onOpenSettings: () => void
}): React.JSX.Element {
  return <View style={styles.bottomNavigation}>
    <Pressable accessibilityRole="tab" accessibilityState={{ selected: active === 'sessions' }} onPress={onOpenSessions} style={styles.navItem}>
      <Text style={[styles.navGlyph, active === 'sessions' && styles.navActive]}>◌</Text><Text style={[styles.navLabel, active === 'sessions' && styles.navActive]}>Sessions</Text>
    </Pressable>
    <Pressable accessibilityRole="tab" accessibilityState={{ selected: active === 'settings' }} onPress={onOpenSettings} style={styles.navItem}>
      <Text style={[styles.navGlyph, active === 'settings' && styles.navActive]}>◐</Text><Text style={[styles.navLabel, active === 'settings' && styles.navActive]}>Settings</Text>
    </Pressable>
  </View>
}

const colors = {
  accent: '#f3a63b',
  border: '#2e3038',
  card: '#1a1b21',
  ink: '#f6f6f8',
  muted: '#989ba6',
  page: '#0d0e12',
  soft: '#c7c9d1',
  userMessage: '#2a2d36',
} as const

const styles = StyleSheet.create({
  assistantMessage: { alignSelf: 'flex-start', backgroundColor: colors.card, borderColor: colors.border, borderRadius: 20, borderTopLeftRadius: 5, borderWidth: 1, maxWidth: '86%', paddingHorizontal: 15, paddingVertical: 12 },
  assistantMessageText: { color: colors.ink, fontSize: 16, lineHeight: 23 },
  backButton: { alignItems: 'center', flexDirection: 'row', minHeight: 36 },
  backChevron: { color: colors.ink, fontSize: 34, fontWeight: '300', lineHeight: 34, marginRight: 2 },
  backText: { color: colors.soft, fontSize: 15, fontWeight: '600' },
  bottomNavigation: { backgroundColor: '#13141a', borderColor: colors.border, borderTopWidth: 1, flexDirection: 'row', justifyContent: 'space-around', paddingBottom: 9, paddingTop: 10 },
  brand: { color: colors.ink, fontSize: 15, fontWeight: '800', letterSpacing: 1.1 },
  brandMark: { alignItems: 'center', backgroundColor: colors.accent, borderRadius: 7, height: 24, justifyContent: 'center', width: 24 },
  brandMarkText: { color: colors.page, fontSize: 14, fontWeight: '900' },
  brandRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  chevron: { color: colors.muted, fontSize: 25, fontWeight: '300', lineHeight: 22 },
  compactButton: { alignItems: 'center', borderColor: '#484a55', borderRadius: 10, borderWidth: 1, minWidth: 47, paddingHorizontal: 10, paddingVertical: 8 },
  compactButtonText: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  composer: { alignItems: 'flex-end', backgroundColor: '#1b1c23', borderColor: '#3c3e49', borderRadius: 22, borderWidth: 1, flexDirection: 'row', minHeight: 54, paddingBottom: 6, paddingLeft: 15, paddingRight: 6, paddingTop: 6 },
  composerHint: { color: colors.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 4, paddingTop: 8, textAlign: 'center' },
  composerInput: {
    color: colors.ink,
    flex: 1,
    fontSize: 16,
    lineHeight: 22,
    maxHeight: 108,
    minHeight: 38,
    paddingBottom: 7,
    paddingRight: 10,
    paddingTop: 7,
  },
  composerShell: { backgroundColor: colors.page, borderTopColor: '#191a20', borderTopWidth: 1, paddingBottom: 12, paddingHorizontal: 16, paddingTop: 10 },
  conversationContent: { gap: 13, paddingBottom: 30, paddingHorizontal: 16, paddingTop: 14 },
  conversationNotice: { backgroundColor: '#201c16', borderColor: '#5c4728', borderRadius: 16, borderWidth: 1, gap: 6, marginBottom: 8, padding: 15 },
  conversationNoticeText: { color: '#ddc9a8', fontSize: 14, lineHeight: 20 },
  conversationNoticeTitle: { color: '#f6ddad', fontSize: 15, fontWeight: '700' },
  conversationStatus: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  conversationTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  conversationTitleWrap: { alignItems: 'center', flex: 1, gap: 2, paddingHorizontal: 8 },
  conversationTopBar: { alignItems: 'center', borderBottomColor: '#1d1e25', borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', minHeight: 57, paddingHorizontal: 16 },
  dayLabel: { alignSelf: 'center', color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.1, marginBottom: 2, marginTop: 2 },
  eyebrow: { color: colors.accent, fontSize: 11, fontWeight: '800', letterSpacing: 1.3 },
  factRow: { gap: 5, paddingVertical: 3 },
  factTitle: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  factValue: { color: colors.muted, fontSize: 14 },
  headingBlock: { gap: 10, paddingBottom: 25, paddingTop: 27 },
  iconButton: { alignItems: 'center', borderColor: colors.border, borderRadius: 12, borderWidth: 1, height: 36, justifyContent: 'center', width: 42 },
  iconButtonText: { color: colors.soft, fontSize: 16, letterSpacing: 1, marginTop: -5 },
  navActive: { color: colors.ink },
  navGlyph: { color: colors.muted, fontSize: 17, lineHeight: 18 },
  navItem: { alignItems: 'center', gap: 3, minWidth: 94, paddingVertical: 2 },
  navLabel: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  noticeAction: { alignSelf: 'flex-start', marginTop: 3, paddingVertical: 4 },
  noticeActionText: { color: '#f6ddad', fontSize: 14, fontWeight: '700' },
  offlineBanner: { alignItems: 'center', backgroundColor: '#17181e', borderColor: colors.border, borderRadius: 17, borderWidth: 1, flexDirection: 'row', gap: 11, padding: 14 },
  offlineCopy: { flex: 1, gap: 3 },
  offlineText: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  offlineTitle: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  page: { backgroundColor: colors.page, flex: 1 },
  pendingNotice: { color: '#ddc9a8', fontSize: 13, lineHeight: 19, marginTop: 2 },
  pressed: { opacity: 0.72 },
  primaryButton: { alignItems: 'center', backgroundColor: colors.ink, borderRadius: 12, marginTop: 3, paddingVertical: 13 },
  primaryButtonText: { color: colors.page, fontSize: 15, fontWeight: '800' },
  screen: { backgroundColor: colors.page, flex: 1 },
  sectionDescription: { color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: 11 },
  sectionHeading: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginTop: 30, paddingBottom: 5 },
  sectionMeta: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  sectionTitle: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  sendButton: { alignItems: 'center', backgroundColor: colors.accent, borderRadius: 17, height: 34, justifyContent: 'center', width: 34 },
  sendButtonText: { color: colors.page, fontSize: 23, fontWeight: '600', lineHeight: 25, marginTop: -2 },
  sessionAvatar: { alignItems: 'center', backgroundColor: '#282a33', borderRadius: 13, height: 36, justifyContent: 'center', width: 36 },
  sessionAvatarText: { color: colors.soft, fontSize: 15, fontWeight: '700' },
  sessionCopy: { flex: 1, gap: 4, minWidth: 0 },
  sessionDetail: { color: colors.muted, fontSize: 13 },
  sessionDivider: { borderBottomColor: colors.border, borderBottomWidth: 1 },
  sessionList: { backgroundColor: colors.card, borderColor: colors.border, borderRadius: 18, borderWidth: 1, overflow: 'hidden' },
  sessionRow: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 70, paddingHorizontal: 14 },
  sessionTime: { alignItems: 'flex-end', gap: 1 },
  sessionTimeText: { color: colors.muted, fontSize: 10, fontWeight: '600' },
  sessionTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  sessionsContent: { paddingBottom: 28, paddingHorizontal: 20 },
  settingsCard: { backgroundColor: colors.card, borderColor: colors.border, borderRadius: 18, borderWidth: 1, gap: 14, padding: 16 },
  settingsContent: { gap: 0, paddingBottom: 30, paddingHorizontal: 20 },
  settingsDivider: { backgroundColor: colors.border, height: 1 },
  settingsExplanation: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  settingsRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  settingsRowCopy: { gap: 4 },
  settingsRowDetail: { color: colors.muted, fontSize: 14 },
  settingsRowTitle: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  settingsSectionLabel: { color: colors.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1.1, marginBottom: 9, marginTop: 28 },
  settingsSubtitle: { color: colors.muted, fontSize: 16, lineHeight: 24, marginTop: 7 },
  settingsTitle: { color: colors.ink, fontSize: 32, fontWeight: '700', letterSpacing: -0.7, marginTop: 13 },
  settingsTopBar: { minHeight: 55, paddingHorizontal: 20, paddingTop: 3 },
  statusDot: { backgroundColor: colors.accent, borderRadius: 5, height: 9, width: 9 },
  subtitle: { color: colors.muted, fontSize: 16, lineHeight: 23, maxWidth: 340 },
  title: { color: colors.ink, fontSize: 36, fontWeight: '700', letterSpacing: -1.1, lineHeight: 42 },
  topBar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingTop: 14 },
  topBarSpacer: { width: 72 },
  unavailablePill: { backgroundColor: '#29251f', borderRadius: 9, paddingHorizontal: 8, paddingVertical: 5 },
  unavailablePillText: { color: '#dfbf82', fontSize: 9, fontWeight: '800', letterSpacing: 0.7 },
  userMessage: { alignSelf: 'flex-end', backgroundColor: colors.userMessage, borderRadius: 20, borderTopRightRadius: 5, maxWidth: '82%', paddingHorizontal: 15, paddingVertical: 12 },
  userMessageText: { color: colors.ink, fontSize: 16, lineHeight: 23 },
})
