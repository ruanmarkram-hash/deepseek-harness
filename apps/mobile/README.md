# DSH Mobile

English | [中文](README.zh.md)

`@deepseek-ai/dsh-mobile` is the foreground-only native Expo owner client for one signed DSH Host. It shows that Host's live sessions, text conversation, and installed plugin controls, but does not browse saved chat history or the full workspace list. Execution, approvals, permissions, files, credentials, workspace changes, attachments, and settings stay on the Host.

## Pairing and connection

The production flow creates a protected Ed25519 signing identity and an independent X25519 agreement identity in the iOS Keychain. The native module exposes public keys and a user-presence-gated agreement operation, never private-key bytes. Expo Go does not contain this module; pairing and connection require a custom native or TestFlight build.

For internet pairing, the phone scans or enters the short-lived `dsh3` code shown by the signed Host. Scanning fills the code field without sending anything; **Pair with Host** sends its public enrollment offer to the fixed relay origin once, displays the complete fingerprint for Host-side comparison, and waits for local Host approval. Relay conflicts, unavailable codes, connectivity failures, and approval timeouts have distinct messages; a missing code is not proof of expiry. The returned invitation is encrypted to that phone identity and contains the device route credential, Host pin, enrollment incarnations, and exact next connection epoch, but no Host credential or private key. A local file or clipboard transfer of the same public offer and phone-safe invitation remains available.

The app stores one verified invitation, event cursor, and next epoch in its native Keychain record. It opens no socket during import. An explicit connect action performs the authenticated V3 relay handshake and reports live state only after the authenticated Host receipt is durably recorded and the Host workspace bootstrap completes. An iOS `inactive` interruption, including the system presence prompt, preserves the pending presence session. Actual backgrounding or disconnect closes the physical transport and clears that session; a later explicit retry and owner authentication use only the Host-issued exact next epoch while the running Host waits on the same route. The invitation does not need replacing after an ordinary background disconnect.

The 20-second connection deadline covers owner authentication, socket opening, handshake and workspace bootstrap, including after the receipt advances the next epoch. Timeout retires the active transport and send permission, rejects pending requests and enables explicit retry without rolling back the confirmed epoch. Home, pairing and connection sheets share live progress, errors and retry controls. Connect opens the connection sheet before authentication; duplicate taps cannot start overlapping attempts, and successful workspace loading dismisses the sheet.

Connection failures and timeouts name one fixed stage: owner presence, identity loading, relay opening, hello preparation/sending, Host handshake, or authenticated workspace bootstrap. A successful hello send records only local carrier acceptance, not delivery to the Host. Messages never include underlying errors, addresses, identifiers, credentials or frame contents, and a failed stage does not imply an expired invitation or require re-pairing.

A process-local notice preserves the safe failure across teardown and records whether the app reported background, the screen unmounted, or the user explicitly disconnected, plus the interrupted connection stage when available. It survives screen remounts, contains no connection authority, and clears on an explicit attempt, success or Forget invitation. Every disconnect still clears live configuration, transport and owner presence. Foregrounding is inert; an explicit retry after teardown restores the durable invitation and authenticates again. A cancelled invitation read cannot start authentication after backgrounding or unmount. These notices identify local teardown facts, not the cause of an iOS lifecycle event.

Repeated teardown without an active attempt preserves the earlier interruption reason and stage. Forget clears the notice when invoked, so a background event received during its pending Keychain removal remains visible to later presentation. An explicit retry may replace a cancelled action, but still waits for the native store's serialized read to finish.

After owner authentication, public identity lookup projects public fields from that current native identity session without another Keychain read. Clearing the session removes this reuse; normal protected loading and a fresh explicit authentication remain required. Private identity material is never returned to JavaScript.

## Mobile scope

EAS post-install and local export preparation compile the protocol projects, bundle their shared value helpers into the declared runtime entry, then bundle the wire and relay packages before Metro runs. Compiler output under `lib/types` alone does not satisfy those packages' runtime imports. The preparation does not change pairing identities or wire formats.

After Host acceptance, the app receives a Host snapshot and ordered events, lists and creates sessions, selects a Host session, and sends text prompts through the fixed remote-wire API. It acknowledges an event cursor only after the native store durably applies it. A fresh app projection resets its cursor to request replay instead of presenting absent local content as current.

The Sessions drawer opens a Host plugin list over the authenticated connection. Included and Host-downloaded plugins appear together; optional rows can be enabled or disabled, and required rows show their lock reason. The Host returns the committed row before the phone changes its switch. The phone cannot install, download, or remove executable packages, and plugin changes use the owner authentication already established for the live connection.

Camera scanning is limited to the short-lived Host pairing code. The app never persists rendered conversation content and does not provide macOS computer-use capture or control. **Forget invitation** disconnects and removes the phone's local route state; it does not revoke the Host route. Revocation remains an explicit action on the signed Host and requires fresh pairing before that phone can connect again.

The app uses the official DeepSeek mark from [`website/public/favicon.svg`](../../website/public/favicon.svg) while retaining the separate DSH product name. Its opaque 1024-pixel app icon adds a small `MOBILE` label below the whale through the [shared icon generator](../desktop/README.md); in-product marks remain unchanged. The production release and different-network device matrix are in the [remote-pairing release cookbook](../../docs/cookbook/releasing-dsh-remote-pairing.md).
