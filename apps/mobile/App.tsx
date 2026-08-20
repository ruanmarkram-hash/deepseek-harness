import { StatusBar } from 'expo-status-bar'
import { useState } from 'react'
import { Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native'

const configuredEndpoint = process.env.EXPO_PUBLIC_DSH_REMOTE_URL ?? ''

/** Native pairing entrypoint; sessions become available only through the authenticated mobile gateway. */
export default function App(): React.JSX.Element {
  const [endpoint, setEndpoint] = useState(configuredEndpoint)
  const [savedEndpoint, setSavedEndpoint] = useState(configuredEndpoint)
  const validEndpoint = endpoint === '' || endpoint.startsWith('https://')

  return <SafeAreaView style={styles.page}>
    <StatusBar style="light" />
    <View style={styles.header}>
      <Text style={styles.eyebrow}>DEEPSEEK HARNESS</Text>
      <Text style={styles.title}>Sessions, wherever you are.</Text>
      <Text style={styles.subtitle}>
        Connect this device to your own authenticated DSH gateway. Computer control stays on the paired desktop.
      </Text>
    </View>
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Set a development gateway</Text>
      <Text style={styles.label}>Gateway address</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        onChangeText={setEndpoint}
        placeholder="https://dsh.example.com"
        placeholderTextColor="#6d727a"
        style={styles.input}
        value={endpoint}
      />
      {!validEndpoint && <Text style={styles.error}>Use an HTTPS gateway address.</Text>}
      <Pressable
        accessibilityRole="button"
        disabled={!validEndpoint || endpoint === ''}
        onPress={() => setSavedEndpoint(endpoint)}
        style={({ pressed }) => [styles.button, (!validEndpoint || endpoint === '') && styles.buttonDisabled, pressed && styles.buttonPressed]}
      >
        <Text style={styles.buttonText}>Preview gateway</Text>
      </Pressable>
      <Text style={styles.connection}>{savedEndpoint === '' ? 'No gateway preview configured' : `Gateway preview: ${savedEndpoint}`}</Text>
    </View>
    <View style={styles.note}>
      <Text style={styles.noteTitle}>What comes next</Text>
      <Text style={styles.noteText}>
        Authenticated device pairing, session history, streaming messages, approvals, and files arrive with the mobile gateway.
        {' '}This preview does not connect or persist credentials. It never grants phone clients the desktop’s Accessibility or Screen Recording permissions.
      </Text>
    </View>
  </SafeAreaView>
}

const styles = StyleSheet.create({
  page: { backgroundColor: '#101114', flex: 1, paddingHorizontal: 24 },
  header: { gap: 12, paddingBottom: 34, paddingTop: 58 },
  eyebrow: { color: '#9ca3af', fontSize: 11, fontWeight: '700', letterSpacing: 1.4 },
  title: { color: '#f5f5f5', fontSize: 34, fontWeight: '700', letterSpacing: -0.8, lineHeight: 40 },
  subtitle: { color: '#a8adb5', fontSize: 16, lineHeight: 24 },
  card: { backgroundColor: '#1b1d22', borderColor: '#30333a', borderRadius: 20, borderWidth: 1, gap: 12, padding: 20 },
  cardTitle: { color: '#f5f5f5', fontSize: 19, fontWeight: '700' },
  label: { color: '#c7cbd1', fontSize: 13, fontWeight: '600', marginTop: 6 },
  input: { backgroundColor: '#101114', borderColor: '#3c4048', borderRadius: 12, borderWidth: 1, color: '#f5f5f5', fontSize: 16, paddingHorizontal: 14, paddingVertical: 13 },
  error: { color: '#ff9c9c', fontSize: 13 },
  button: { alignItems: 'center', backgroundColor: '#e8eaed', borderRadius: 12, marginTop: 4, paddingVertical: 14 },
  buttonDisabled: { backgroundColor: '#353941' },
  buttonPressed: { opacity: 0.8 },
  buttonText: { color: '#121316', fontSize: 16, fontWeight: '700' },
  connection: { color: '#9ca3af', fontSize: 13, lineHeight: 18 },
  note: { gap: 8, paddingTop: 28 },
  noteTitle: { color: '#f5f5f5', fontSize: 16, fontWeight: '700' },
  noteText: { color: '#a8adb5', fontSize: 14, lineHeight: 21 },
})
