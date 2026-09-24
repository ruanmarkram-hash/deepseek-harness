# Agent Note: 托管运行时生产打包

Status: implemented

[English](2026-08-22-hosted-runtime-production-packaging.md) | 中文

## 问题

已签名 Host 必须启动已配置 Web 运行时，同时不能从 PATH、环境变量、外部 checkout 或可变 symlink farm 解析 Node、JavaScript、package 或原生模块。发布版本还必须在离开构建目录后继续工作。

## 决策

`assemble-host-app.sh` 把完整托管运行时 closure 复制到 `DSHHost.app/Contents/Resources/HostedChild`：固定 Node binary、已打包 `dsh-web.mjs` entrypoint、运行时文件、package closure、preset 以及安装专用 `HostedWebConfiguration.plist`。它使用所选身份签名 Node 和每个托管 Mach-O 工件，把严格 requirement 与 SHA-256 digest 记录到密封 manifest，最后密封完整外层应用。运行时 launcher 不接收 `NODE_PATH`、`DSH_HOSTED_ROOT`、PATH lookup、shell 或外部模块根。

发布输入是官方 Node.js v24.19.0 macOS arm64 归档 `node-v24.19.0-darwin-arm64.tar.gz`，其发布且本地验证的 SHA-256 为 `27db838bb204ef7c21df2931f5656e4c8fb32e6e947f363a402b49714d32b5b1`。解压后的 `native/remote-host-app/dist/pinned-node` 树和生成的 `dist/dsh-web.mjs` 是被忽略的构建输入，绝不能提交。

可接受安装是 root 拥有的 `/Applications/DSHHost.app` 或当前用户拥有的 `~/Applications/DSHHost.app` 中一个规范、非 symlink 应用。运行时校验根据位置推导预期 owner，拒绝扩展 ACL 和 group 或 world writer，验证每个 manifest entry 与 digest，检查嵌套 designated requirement，并验证严格完整应用 code seal。XPC client 授权从 helper 的固定嵌套位置推导，而不是使用持久化构建路径。

发布顺序属于打包约定。干净候选版本只组装一次，复制到受支持规范位置，并在公证前通过 XPC、托管子进程启动、浏览器会话创建、提示和重启恢复 smoke。该已测试候选版本随后只接受一次最终公证提交，完成票据装订与重新评估，之后不再重新构建或重新签名。

## 验证

打包和 Swift 测试覆盖 manifest 上限、digest 变化、symlink、owner 与 mode 变化、ACL、缺失工件、无效嵌套 requirement、不受支持安装位置、相对 XPC 授权和托管 Web 配置不匹配。私有运行时 smoke 会组装并迁移已签名应用，通过生产 entry path 启动托管子进程，并验证篡改或不可用工件的失败关闭行为。

## 考虑过的替代方案

**保留外部 symlink farm 并信任其后的 checkout。** 拒绝，因为已签名发布无法把可变外部 JavaScript 和原生模块纳入代码完整性声明。

**通过环境变量解析 Node 或模块。** 拒绝，因为 ambient 进程状态会成为密封应用之外的可执行发布配置。

**在迁移和托管运行时 smoke 前公证。** 拒绝，因为这可能把最终提交浪费在离开构建目录后 XPC 或托管 closure 失败的候选版本上。

## 后果

应用体积更大，且组装期间必须重新签名原生依赖，但可分发 closure 是自包含且可审查的。安装专用 Web 配置和预配激活是保存在源码外的密封发布输入。拥有账户可以替换用户拥有的安装，因此安全声明不防护该账户，但仍保留严格已签名代码和 peer 隔离。
