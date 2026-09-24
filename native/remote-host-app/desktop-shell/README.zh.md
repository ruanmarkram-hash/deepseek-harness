# 附加到签名 Host 的 Desktop

[English](README.md) | 中文

## 概述

在桌面窗口中打开签名 DSH Host 已有的 Web 运行时。这个私有 macOS 外壳不会启动或停止运行时、配对手机或更改 Host 配置。`apps/desktop` 中维护的上游 Desktop 仍是独立产品，由其自己的运行时所有者管理。

## 目录

- [连接](#connection)
- [验证与打包](#verification-and-packaging)
- [限制](#limitations)

<a id="connection"></a>

## 连接

打开此外壳前，先启动签名 Host 的托管运行时。外壳读取 `DSH_HOME` 下的 `runtime/web.json` 和 `runtime/web-bootstrap.json`；未设置该变量时使用 `~/.dsh`。两个记录必须对应同一个存活进程、发布时间和精确的 `127.0.0.1` 来源。私有引导记录用令牌换取现有的浏览器认证 cookie；此后渲染器不能导航到含令牌的 URL。

读取器拒绝符号链接、具有硬链接或非普通文件的记录、超过 4096 字节的记录、不安全的所有者以及不安全的权限。运行时目录必须为 `0700`，两个文件必须为 `0600`，DSH 主目录不得允许其他用户写入。无效记录只产生不包含令牌的固定诊断。重启 Host 运行时即可重新发布记录；外壳不会修复记录。

<a id="verification-and-packaging"></a>

## 验证与打包

从仓库根目录运行以下聚焦测试，验证实际的普通 Node 读取器和导航策略：

```sh
node --test native/remote-host-app/desktop-shell/tests/*.test.mjs
```

私有[打包配置](electron-builder.cjs)使用已安装的 `apps/desktop` Electron、electron-builder 工具和 `DeepSeek-DESKTOP.icns` 图标变体。它仅包含此外壳的运行时文件，不包含 Node 或 DSH 运行时。发布负责人在安装依赖后运行以下打包命令，并在安装前验证构建的应用能连接签名 Host：

```sh
apps/desktop/node_modules/.bin/electron-builder --config native/remote-host-app/desktop-shell/electron-builder.cjs --mac --arm64 --dir
```

配置的输出位置是本目录下的 `release.noindex/mac-arm64/DSH Desktop.app`。`.noindex` 目录使构建产物不被 Spotlight 索引；发布负责人还必须从 LaunchServices 注销未安装的 app 包，并在测试后以可恢复方式归档。此命令禁用签名；签名、公证、安装和实际启动仍由发布负责人分别执行。打包和实际认证需要发布验证；单元测试不能证明这些结果。

<a id="limitations"></a>

## 限制

外壳拒绝弹出窗口、嵌入式 WebView、渲染器导航到所选来源之外的位置以及浏览器权限请求。它提供标准的应用、编辑、视图和窗口菜单，但不恢复窗口位置。Host 重启后，需要重新打开外壳以向新的运行时认证。[原生 Host 参考](../README.zh.md)负责说明运行时和手机操作。
