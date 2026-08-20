# DSH Desktop

English | [中文](README.zh.md)

`@deepseek-ai/dsh-desktop` supervises the existing local DSH web runtime and presents it in a hardened Electron window. It does not expose Node APIs to the rendered web client.

For development, first build the Harness runtime from the repository root, then run `pnpm --filter @deepseek-ai/dsh-desktop dev`. Set `DSH_DESKTOP_RUNTIME` to test a specific installed `dsh` executable.

`pnpm --filter @deepseek-ai/dsh-desktop run stage:runtime` builds the official DSH web artifacts and deploys a symlink-free runtime into `.dsh-build/desktop-runtime`. `package:macos` packages that runtime as an unsigned arm64 app for local verification. Packaged DSH data lives below the application's Electron user-data directory, not beside the signed application resources or in a command-line `~/.dsh` home.

The native host starts hidden until the local page is ready, restores prior placement only when it intersects a current display work area, and uses the macOS inset title bar. It retains a maximized window's normal placement for the next launch. Its native File, Edit, View, Window, and Mobile menus retain standard focus controls and the isolated mobile pairing entry. Desktop-owned native surfaces reuse the repository's official DeepSeek mark from `website/public/favicon.svg`; no recreated logo is used.

`src/mobile-pairing.ts` and `src/mobile-live-transport.ts` are Electron-main-only. They create a short-lived v2 QR rendezvous, keep relay credentials and pairing keys in memory, use the role-bound relay WebSocket, verify the phone key proof, and require explicit desktop approval before accepting a phone. The dedicated sandboxed pairing page has a narrow preload for session aliases, pairing-code display, start, close, and non-secret status only. The normal local DSH renderer gets no mobile IPC or Node privilege.

The local adapter uses only literal `session.list`, `session.history`, and text-only queued `session.prompt` paths against the verified loopback runtime. The native picker maps a user-selected existing session to an opaque mobile handle. The phone sees only bounded user/assistant text snapshots and may request only a plain-text prompt, each of which requires native desktop confirmation. Snapshot polling intentionally leaves the phone composer available because it cannot safely attribute a local DSH turn to a phone request. Mobile cancellation is deliberately unavailable in this foreground release: DSH exposes only session-wide `session.cancel`, without a trustworthy turn identity or ownership boundary, so encrypted `cancel-turn` is rejected without touching local DSH. It can return only when the local runtime exposes that trustworthy identity. No raw event stream, arbitrary session id/path, attachment, file, tool, workspace, credential, settings, or computer-use capability exists. The transport is foreground-only and fails closed on local or relay errors, close, expiry, denial, or revocation. It requires the v2 relay deployment; the currently deployed v1 relay cannot service this transport.

macOS signing, notarization, automatic updates, and native computer-use integration remain separate work. This shell does not claim or grant Accessibility or Screen Recording permission.
