# DSH Desktop

[English](README.md) | 中文

`@deepseek-ai/dsh-desktop` 监管现有的本地 DSH Web 运行时，并在加固的 Electron 窗口中呈现它。渲染的 Web 客户端无法访问 Node API。

开发时，先从仓库根目录构建 Harness 运行时，然后运行 `pnpm --filter @deepseek-ai/dsh-desktop dev`。设置 `DSH_DESKTOP_RUNTIME` 可测试指定的已安装 `dsh` 可执行文件。

`pnpm --filter @deepseek-ai/dsh-desktop run stage:runtime` 会构建正式 DSH Web 产物，并把不含符号链接的运行时部署到 `.dsh-build/desktop-runtime`。`package:macos` 会把该运行时打包为未签名的 arm64 应用，供本地验证。打包后 DSH 数据保存在该应用的 Electron 用户数据目录下，不会保存在已签名应用资源旁，也不会使用命令行的 `~/.dsh` 主目录。

原生宿主会在本地页面准备就绪前保持隐藏，仅在上次窗口位置与当前显示器工作区域相交时恢复该位置，并使用 macOS 内嵌式标题栏。它会保留最大化窗口的普通位置以供下次启动使用。它的原生“文件”“编辑”“视图”“窗口”和“移动端”菜单保留标准焦点控制及隔离的移动端配对入口。桌面端拥有的原生界面复用仓库 `website/public/favicon.svg` 中的官方 DeepSeek 标记，不会重绘 logo。

`src/mobile-pairing.ts` 和 `src/mobile-live-transport.ts` 仅在 Electron 主进程运行。它们创建短时 v2 QR rendezvous，仅在内存中保留 relay credential 与 pairing key，使用 role-bound relay WebSocket，验证手机 key proof，并在接受手机前要求明确的 desktop approval。专用的 sandboxed pairing 页面只有狭窄 preload，可使用 session alias、配对码显示、开始、关闭和非秘密状态。普通本地 DSH renderer 没有移动端 IPC 或 Node 权限。

本地 adapter 只会针对已验证的 loopback runtime 使用固定的 `session.list`、`session.history` 与纯文本 queued `session.prompt` path。原生 picker 会把用户明确选定的现有 session 映射成 opaque mobile handle。手机只会看到受限的 user/assistant text snapshot，并且只能请求纯文本 prompt；每个 prompt 都要求 native desktop confirmation。由于 snapshot polling 无法安全地把本地 DSH turn 归因于手机 request，因此它会刻意让手机 composer 保持可用。本前台版本刻意不提供 mobile cancellation：DSH 目前只有 session-wide `session.cancel`，没有可信的 turn identity 或 ownership boundary，因此加密的 `cancel-turn` 会被拒绝，且不会触及本地 DSH。只有本地 runtime 提供该可信 identity 后，才可恢复此能力。不存在 raw event stream、任意 session id/path、attachment、file、tool、workspace、credential、settings 或 computer-use capability。该 transport 仅在前台运行，并会在本地或 relay error、close、expiry、denial 或 revocation 时 fail closed。它需要已部署的 v2 relay；当前已部署的 v1 relay 无法服务该 transport。

macOS 签名、公证、自动更新和原生计算机使用集成仍是独立工作。该外壳不会声明或授予辅助功能或屏幕录制权限。
