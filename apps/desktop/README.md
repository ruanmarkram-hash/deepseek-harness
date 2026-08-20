# DSH Desktop

English | [中文](README.zh.md)

`@deepseek-ai/dsh-desktop` supervises the existing local DSH web runtime and presents it in a hardened Electron window. It does not expose Node APIs to the rendered web client.

For development, first build the Harness runtime from the repository root, then run `pnpm --filter @deepseek-ai/dsh-desktop dev`. Set `DSH_DESKTOP_RUNTIME` to test a specific installed `dsh` executable. Release packaging and macOS-native computer-use integration remain separate work; this shell does not claim or grant Accessibility or Screen Recording permission.
