# DSH Mobile

English | [中文](README.zh.md)

`@deepseek-ai/dsh-mobile` is a native Expo client foundation for remote DSH sessions. It presents a session-first mobile workspace: an offline session browser, an immersive conversation view, a composition area, and pairing settings.

The current UI is a local preview. Its sample sessions and messages never leave the device, and typed drafts exist only while the preview is open. It makes no network requests and does not collect or persist a gateway address, QR code, account token, or credential.

An authenticated mobile gateway must pair a user with a desktop and enforce server-side session and permission policy before the app can load history, stream session state, or deliver user-approved messages. Computer use and macOS privacy permissions remain desktop-only.
