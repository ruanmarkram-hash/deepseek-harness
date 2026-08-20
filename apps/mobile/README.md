# DSH Mobile

English | [中文](README.zh.md)

`@deepseek-ai/dsh-mobile` is a native Expo client foundation for remote DSH sessions. It presents a session-first mobile workspace, an immersive conversation view, a composition area, and a pairing-first connection flow.

The current UI is a local preview. Its sample sessions and messages never leave the device, and typed drafts exist only while the preview is open. A user can manually paste a desktop-issued pairing code while camera support is absent. The shared pairing parser validates the code in memory, clears the raw value, and never logs or persists its relay token.

The flow distinguishes a parsed local request, a blocked wait for desktop acceptance, and a visual-only paired-session-shell preview. It makes no network requests, opens no relay connection, applies no cryptography, and does not claim a desktop accepted the phone. The fixed mobile scope is reading and subscribing to existing sessions, sending text to an existing session, and cancelling a turn. Computer use, approvals, files, credentials, workspace and settings changes, attachments, and session creation remain desktop-only.
