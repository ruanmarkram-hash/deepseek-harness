# DSH Desktop

English | [中文](README.zh.md)

`@deepseek-ai/dsh-desktop` supervises the existing local DSH web runtime and presents it in a hardened Electron window. It does not expose Node APIs to the rendered web client.

For development, first build the Harness runtime from the repository root, then run `pnpm --filter @deepseek-ai/dsh-desktop dev`. Set `DSH_DESKTOP_RUNTIME` to test a specific installed `dsh` executable.

`pnpm --filter @deepseek-ai/dsh-desktop run stage:runtime` builds the official DSH web artifacts and deploys a symlink-free runtime into `.dsh-build/desktop-runtime`. `package:macos` packages that runtime as an unsigned arm64 app for local verification. Packaged DSH data lives below the application's Electron user-data directory, not beside the signed application resources or in a command-line `~/.dsh` home.

The native host starts hidden until the local page is ready, restores prior placement only when it intersects a current display work area, and uses the macOS inset title bar. It retains a maximized window's normal placement for the next launch. Its native File, Edit, View, and Window menus retain standard reload, zoom, full-screen, and focus shortcuts without adding renderer-to-host commands.

`src/mobile-pairing.ts` is a main-process-only pairing creator for the configured HTTPS Cloudflare relay origin. It generates separate high-entropy public ids, desktop credential, and mobile credential; sends only the desktop credential in the creation header; and returns the mobile credential only inside a short-lived `dsh-pairing:v1:` QR bootstrap. Its state has no renderer IPC, WebSocket, DSH session, filesystem, credential, tool, or computer-use operation. The bridge stores the desktop credential only in memory for a future host-owned connection and clears it on close.

macOS signing, notarization, automatic updates, and native computer-use integration remain separate work. This shell does not claim or grant Accessibility or Screen Recording permission.
