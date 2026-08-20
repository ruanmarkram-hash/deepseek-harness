# DSH Desktop

[English](README.md) | 中文

`@deepseek-ai/dsh-desktop` 监管现有的本地 DSH Web 运行时，并在加固的 Electron 窗口中呈现它。渲染的 Web 客户端无法访问 Node API。

开发时，先从仓库根目录构建 Harness 运行时，然后运行 `pnpm --filter @deepseek-ai/dsh-desktop dev`。设置 `DSH_DESKTOP_RUNTIME` 可测试指定的已安装 `dsh` 可执行文件。发布打包和 macOS 原生计算机使用集成仍是独立工作；该外壳不会声明或授予辅助功能或屏幕录制权限。
