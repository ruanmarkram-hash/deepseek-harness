# DSH Desktop

[English](README.md) | 中文

`@deepseek-ai/dsh-desktop` 监管现有的本地 DSH Web 运行时，并在加固的 Electron 窗口中呈现它。渲染的 Web 客户端无法访问 Node API。

开发时，先从仓库根目录构建 Harness 运行时，然后运行 `pnpm --filter @deepseek-ai/dsh-desktop dev`。设置 `DSH_DESKTOP_RUNTIME` 可测试指定的已安装 `dsh` 可执行文件。

`pnpm --filter @deepseek-ai/dsh-desktop run stage:runtime` 会构建正式 DSH Web 产物，并把不含符号链接的运行时部署到 `.dsh-build/desktop-runtime`。`package:macos` 会把该运行时打包为未签名的 arm64 应用，供本地验证。打包后 DSH 数据保存在该应用的 Electron 用户数据目录下，不会保存在已签名应用资源旁，也不会使用命令行的 `~/.dsh` 主目录。

macOS 签名、公证、自动更新和原生计算机使用集成仍是独立工作。该外壳不会声明或授予辅助功能或屏幕录制权限。
