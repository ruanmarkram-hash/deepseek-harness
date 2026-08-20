# Agent Note: 桌面与移动端产品客户端

Status: implemented

[English](2026-08-20-desktop-and-mobile-product-clients.md) | 中文

## 问题

Web 应用是本地 Harness 运行时的浏览器界面。它没有可安装的 macOS 窗口生命周期所有者，也不能把本地主机的特权工具交给手机。

## 决定

该 fork 在 `apps/` 下包含两个私有产品工作区。`apps/desktop` 启动本地 DSH Web 运行时，并在禁用 Node integration 的 Electron 窗口中只渲染其 loopback URL。其私有 `apps/desktop-runtime` 部署根会把不含符号链接的已构建 DSH 闭包提供到打包应用的 `Resources/dsh-runtime` 目录。桌面主进程通过 Electron Node 模式启动该固定入口，把 `DSH_HOME` 置于 Electron 用户数据目录下，并在打包应用中忽略 `DSH_DESKTOP_RUNTIME`。`apps/mobile` 是仅接受 HTTPS 远程网关地址的 Expo 原生外壳。

移动网关仍是用户认证、会话访问、流式消息、文件和操作策略的权威来源。包括计算机控制在内的桌面专属能力不会通过该产品拓扑提供给移动客户端。

该 fork 通过 `upstream` remote 跟踪 `deepseek-ai/deepseek-harness`。上游同步工作流创建 pull request，而不是直接修改 `master`。

## 考虑过的替代方案

**复用 MyOS 移动应用。** 它包含无关的运行时、账户和产品问题，会阻碍独立维护的 DSH 产品。

**在移动端包装 Web 页面。** 移动 WebView 会继承未认证的本地服务器模型，也无法提供手机客户端需要的原生会话导航和策略控制。

**自动把上游合并到 `master`。** 上游变更可能影响嵌入式运行时或客户端行为，因此每一次同步都保留为可审查的变更。

## 后果

桌面外壳可以暂存并打包已构建的 DSH 运行时，而不会把可变 profile、凭据或会话数据复制进应用资源；移动应用在认证网关存在前不能连接。Electron Builder 从暂存运行时生成未签名的 arm64 macOS 产物；Developer ID 签名、公证、GitHub Release 更新、TestFlight 配置和原生计算机使用服务仍属于发布与平台工作，不会隐藏在 Web 运行时中。
