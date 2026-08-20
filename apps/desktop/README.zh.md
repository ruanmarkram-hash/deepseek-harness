# DSH Desktop

[English](README.md) | 中文

`@deepseek-ai/dsh-desktop` 监管现有的本地 DSH Web 运行时，并在加固的 Electron 窗口中呈现它。渲染的 Web 客户端无法访问 Node API。

开发时，先从仓库根目录构建 Harness 运行时，然后运行 `pnpm --filter @deepseek-ai/dsh-desktop dev`。设置 `DSH_DESKTOP_RUNTIME` 可测试指定的已安装 `dsh` 可执行文件。

`pnpm --filter @deepseek-ai/dsh-desktop run stage:runtime` 会构建正式 DSH Web 产物，并把不含符号链接的运行时部署到 `.dsh-build/desktop-runtime`。`package:macos` 会把该运行时打包为未签名的 arm64 应用，供本地验证。打包后 DSH 数据保存在该应用的 Electron 用户数据目录下，不会保存在已签名应用资源旁，也不会使用命令行的 `~/.dsh` 主目录。

原生宿主会在本地页面准备就绪前保持隐藏，仅在上次窗口位置与当前显示器工作区域相交时恢复该位置，并使用 macOS 内嵌式标题栏。它会保留最大化窗口的普通位置以供下次启动使用。它的原生“文件”“编辑”“视图”和“窗口”菜单保留标准的重新加载、缩放、全屏和焦点快捷键，不会新增从渲染器到宿主的命令。

`src/mobile-pairing.ts` 是面向已配置 HTTPS Cloudflare relay origin 的仅主进程配对创建器。它会生成相互独立的高熵公开 id、桌面端凭据和移动端凭据；只在创建 header 中发送桌面端凭据；并只在短时 `dsh-pairing:v1:` QR bootstrap 中返回移动端凭据。它的 state 没有渲染器 IPC、WebSocket、DSH session、filesystem、credential、tool 或 computer-use 操作。该 bridge 只在内存中保留桌面端凭据，供未来仅宿主拥有的连接使用，并会在关闭时清除。

macOS 签名、公证、自动更新和原生计算机使用集成仍是独立工作。该外壳不会声明或授予辅助功能或屏幕录制权限。
