# dsh-pairing-protocol

English | [中文](README.zh.md)

`@deepseek-ai/dsh-pairing-protocol` is the version-one wire vocabulary for accountless phone pairing. It is a pure parser and sequencing library shared by the Electron desktop trust anchor, an Expo client, and a future relay. It does not generate keys, encrypt or decrypt data, store secrets, connect to the relay, or approve a device.

## Surface

```ts
import {
  acceptRelayFrame,
  parsePairingBootstrap,
  parseRelayFrame,
  validateMobileCapabilities,
} from '@deepseek-ai/dsh-pairing-protocol'

declare const scannedQr: string
declare const relayMessage: string
declare const previousSequence: number

const bootstrap = parsePairingBootstrap(scannedQr)
const requested = validateMobileCapabilities(['session:read', 'turn:send'])
const frame = parseRelayFrame(JSON.parse(relayMessage))
const lastAcceptedSequence = acceptRelayFrame(previousSequence, frame)
```

`parsePairingBootstrap` accepts exactly `dsh-pairing:v1:<canonical-base64url-utf8-json>`. The JSON object carries a `wss:` relay URL without user info, query, or fragment; public opaque pairing and desktop ids; a short-lived relay bearer token; an expiry no more than five minutes away; and the desktop-declared mobile capability set. The relay token is sensitive. Callers keep it in secure platform storage only for the active pairing and never place it in logs, analytics, URLs, or durable session history.

`parseRelayFrame` accepts an exact versioned JSON envelope: the pairing id, distinct sender and recipient device ids, a positive sequence at most `MAX_RELAY_SEQUENCE`, and canonical base64url ciphertext bounded to 64 KiB before encoding. The package cannot inspect ciphertext. The relay forwards it as opaque data, while callers own authenticated encryption, key verification, replay-state persistence, and close/rekey behavior.

The desktop approves only the `MOBILE_PAIRING_CAPABILITIES` allowlist: `session:read`, `session:subscribe`, `turn:send`, and `turn:cancel`. `validateMobileCapabilities` fails closed for every other string, duplicate, empty set, or non-string item. This vocabulary deliberately contains no computer-use, filesystem, credential, workspace, or administrative capability.

For every `(pairingId, senderDeviceId, recipientDeviceId)` direction, callers retain one `lastAcceptedSequence`, initialized to `0`. `acceptRelayFrame` admits only the next contiguous sequence. Duplicate frames, gaps, invalid counters, and exhausted counters fail closed with a `PairingProtocolError.code`; recovery and re-pairing decisions remain outside this package.

## Known Limitations and Deferred Work

- **Cryptography stays external** — this package does not choose an AEAD, derive keys, verify device keys, or bind encrypted handshake transcripts. The Electron host and native client must use audited platform cryptography before they send or accept a frame.
- **No authority or storage** — relay token storage, desktop confirmation, capability grants, device revocation, reconnect state, and Durable Object routing need their own platform implementations.
- **No relay behavior** — a relay may validate only its own transport token and routing fields. It must not inspect, transform, replay, or retain plaintext because none is present in this protocol package.
