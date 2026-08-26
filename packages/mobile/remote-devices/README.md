# dsh-remote-devices

English | [中文](README.zh.md)

`@deepseek-ai/dsh-remote-devices` provides the Host-owned durable directory of remote devices trusted to act as DSH owners. It stores public identity metadata in the active Host storage backend and provides local enrollment, authenticated-presence, listing, and immediate revocation operations.

## Surface

`RemoteDeviceDirectory` is available as `ctx.remoteDevices` when the plugin is composed. `enroll()` is deliberately a local Host policy action, intended for a future physical QR confirmation surface. It requires a bounded opaque device id, label, distinct canonical base64url 32-byte signing and agreement public keys, and a canonical local enrollment time. It rejects padding, alternate base64 spelling, and any other key length before durable persistence. `seed()` is the narrower FD199 child-recovery path: it accepts the same public tuple plus the signed Host's already-confirmed opaque enrollment incarnation, persists that exact value once, and rejects conflicting retries. Neither method accepts a relay token, password, or remote HTTP request.

Each record also has a Host-minted opaque enrollment `incarnation`. It is not a timestamp or a client claim: every successful enrollment receives a new value, including a same-id re-enrollment after revocation. A future authenticated provider must attest the complete immutable `{ deviceId, incarnation, signingPublicKey, agreementPublicKey }` tuple. `markSeen()` only records a time after that proof. Timestamps cannot move backward. `revoke()` deletes the public record immediately, so a later handshake has no trusted device entry to authorize. `remote-devices/changed` emits after each durable enrollment, presence update, or revocation and contains public metadata only.

The records are stored through `dsh-storage-domain` under the `remote_devices` unit. The web Host bundle composes this plugin against its existing `$DSH_HOME/storages` JSON backend. No private key, shared secret, relay credential, session content, or credential value is ever written by this package.

## Known Limitations and Deferred Work

- Enrollment is not yet connected to a local Devices screen, QR handshake, macOS Keychain Host identity, mobile Secure Enclave identity, relay connection, or remote API dispatch. The directory alone grants no network access.
- Revocation removes current authorization immediately. A future audit ledger and signed revoke notice belong to the Host remote-connection runtime, not this public-metadata directory.
