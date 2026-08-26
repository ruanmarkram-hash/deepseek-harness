# dsh-remote-host-keychain

English | [中文](README.zh.md)

`dsh-remote-host-keychain` is the sealed XPC helper inside the signed `DSHHost.app`. It owns the long-lived Ed25519 signing identity and independent X25519 agreement identity in the login Keychain. Private key bytes never enter JavaScript or cross the XPC interface.

## Signed client authorization

Before listening or touching Keychain, the helper validates its own strict code signature and fixed identifier. Its signed authorization resource contains the sole Host client's designated requirement, bundle identifier, and build version. The helper derives the enclosing Host app and `Contents/MacOS/dsh-remote-host-app` executable from its canonical `Contents/XPCServices/DSHRemoteHostKeychain.xpc` position, so relocating the complete signed app does not invalidate authorization and no build-machine path is persisted.

Each connection must match the exact derived live process path, strict live and static code requirement, Host identifier, and sealed build version. The Host also pins the helper's designated requirement on its `NSXPCConnection`, preventing a separately registered service from impersonating the embedded helper. A symlinked layout, malformed resource, changed bundle, invalid signature, or unauthorized peer fails closed.

## Fixed operations

The XPC interface exposes only public identity open, exact 32-byte X25519 agreement, constrained FD199 ownership-payload signing, and per-route epoch lease and transaction calls. The signing method accepts only the two canonical bounded FD199 ownership payload forms; it is not a general signing oracle. There is no JSON operation envelope, arbitrary profile selector, Keychain read operation, route-token operation, or generic signing or agreement API.

Epoch ownership is held by the authenticated XPC connection rather than a pathname or exported token. Explicit close and XPC invalidation release leases after a crash. Revocation may acquire the short serialized Keychain transaction while another Host owns the connection lease, allowing the durable revocation fence to reject that owner's next admission check.

## Keychain behavior

The helper creates its identity row with a `SecAccess` trusted-application ACL derived from its signed executable. A malformed row, changed designated requirement, changed public/private-key relationship, or invalid key fails closed without rekeying. Mutable copies owned by this source are wiped after use.

The Host's relay credential store follows the same ACL-preservation rule. Initial creation supplies `kSecAttrAccess`; duplicate provisioning, route, cleanup, and epoch writes update only `kSecValueData`. Reads, duplicate updates, and deletes use an authentication context with interaction disabled, so an unexpected authorization requirement returns failure instead of opening SecurityAgent.

The [Host package README](../remote-host-app/README.md) describes pairing, activation, reconnect, restart, and revoke behavior. The [remote-pairing release cookbook](../../docs/cookbook/releasing-dsh-remote-pairing.md) and [hosted runtime packaging reference](../remote-host-app/docs/hosted-runtime-runbook.md) are authoritative for assembly and release operations.
