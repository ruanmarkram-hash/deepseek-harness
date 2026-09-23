# Agent Note: Mobile disconnect notices

Status: implemented

English | [中文](2026-09-23-mobile-disconnect-notices.zh.md)

## Problem

A phone can display only disconnected after an authentication attempt, hiding a preceding safe failure. That status alone cannot distinguish background teardown, screen unmount or explicit disconnect, and does not prove which physical iOS event caused the interruption.

## Decision

The mobile client emits a fixed local disconnect reason and its pending attempt stage after completing the same security teardown for every reason. A separate process-local presentation stores these facts and the preceding safe failure. Screen ownership fences prevent late callbacks from replacing a newer screen's notice. Explicit attempt, success and Forget clear it. Home and both sheets use the same connection action projection; Connect opens the connection sheet before authentication.

A later teardown without an active attempt preserves the existing interruption rather than replacing it with a less informative reason. Forget clears synchronously before awaiting Keychain deletion, so its late completion cannot erase a new background notice. Action ownership uses a distinct token per invocation: a cancelled action admits an explicit replacement, and only the current token can release duplicate-tap exclusion. Native storage serialization remains unchanged.

An action cancellation signal prevents a pending invitation restore from starting authentication after backgrounding, unmount or Forget. Foreground events remain inert. Retry after disconnect restores the durable Host-issued configuration and uses connect because teardown clears the client's configuration. Observer exceptions produce fixed warnings and cannot prevent teardown reporting or corrupt connection control flow.

The existing [stage diagnostics](2026-09-23-mobile-connection-stage-diagnostics.md) and [bootstrap retry and presence reuse](2026-09-23-mobile-bootstrap-retry-and-presence.md) decisions remain active: their failure stages, deadlines, authenticated epoch finality and native identity lifetime are unchanged.

## Alternatives considered

**Keeping the transport in an error state after disconnect** confuses presentation with connection authority and can send retry through reconnect after its configuration has been cleared.

**Suppressing or delaying background teardown around Face ID** assumes an unproven trigger and extends the authentication lifetime. Recording the local reason provides evidence without changing that security rule.

**Persisting diagnostic history** adds durable data for a temporary investigation. A process-local notice preserves screen continuity without storing identifiers, credentials or frames.

## Consequences

The UI exposes safe teardown evidence while wire messages, native authentication, keys and durable epochs remain unchanged. Process termination loses the notice. A background reason reports the event received by JavaScript, not a conclusion that the user left the app. The physical post-Face ID trigger remains unproven.

## Verification

Real mobile client and encrypted relay tests snapshot failure retention, cancelled owner presence and successful explicit retry with the real native-state store behind an in-memory platform adapter. They verify no socket after late authentication, inert foregrounding, exact next-epoch persistence, cleared request authority, all disconnect reasons and observer exception containment. Projection and action tests cover stale screen leases and cancelled native reads. Physical iOS lifecycle and Face ID remain release checks.

Mounted-App tests exercise the actual lifecycle subscriptions, button handlers and notice ownership with native widgets replaced by DOM elements. They verify background at handshake followed by unmount/remount and background during deferred Forget. A cancelled native read followed by an explicit replacement pins action-token ownership without bypassing storage serialization.
