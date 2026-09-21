# DSH Mobile

English | [中文](README.zh.md)

`@deepseek-ai/dsh-mobile` is the foreground-only native Expo owner client for one signed DSH Host. It shows the Host's live sessions and text conversation while execution, approvals, permissions, files, credentials, workspace changes, attachments, and settings stay on the Host.

## Pairing and connection

The production flow creates a protected Ed25519 signing identity and an independent X25519 agreement identity in the iOS Keychain. The native module exposes public keys and a user-presence-gated agreement operation, never private-key bytes. Expo Go does not contain this module; pairing and connection require a custom native or TestFlight build.

For internet pairing, the phone scans or enters the short-lived `dsh3` code shown by the signed Host. Scanning fills the code field without sending anything; **Pair with Host** sends its public enrollment offer to the fixed relay origin once, displays the complete fingerprint for Host-side comparison, and waits for local Host approval. Relay conflicts, unavailable codes, connectivity failures, and approval timeouts have distinct messages; a missing code is not proof of expiry. The returned invitation is encrypted to that phone identity and contains the device route credential, Host pin, enrollment incarnations, and exact next connection epoch, but no Host credential or private key. A local file or clipboard transfer of the same public offer and phone-safe invitation remains available.

The app stores one verified invitation, event cursor, and next epoch in its native Keychain record. It opens no socket during import. An explicit connect action performs the authenticated V3 relay handshake and reports live state only after the Host commit is verified. An iOS `inactive` interruption, including the system presence prompt, preserves the pending presence session. Actual backgrounding or disconnect closes the physical transport and clears that session; a later explicit retry uses only the Host-issued exact next epoch.

## Mobile scope

After Host acceptance, the app receives a Host snapshot and ordered events, lists and creates sessions, selects a Host session, and sends text prompts through the fixed remote-wire API. It acknowledges an event cursor only after the native store durably applies it. A fresh app projection resets its cursor to request replay instead of presenting absent local content as current.

Camera scanning is limited to the short-lived Host pairing code. The app never persists rendered conversation content and does not provide macOS computer-use capture or control. **Forget invitation** disconnects and removes the phone's local route state; it does not revoke the Host route. Revocation remains an explicit action on the signed Host and requires fresh pairing before that phone can connect again.

The app uses the official DeepSeek mark from [`website/public/favicon.svg`](../../website/public/favicon.svg) for its app and in-product icon surfaces while retaining the separate DSH product name. The production release and different-network device matrix are in the [remote-pairing release cookbook](../../docs/cookbook/releasing-dsh-remote-pairing.md).
