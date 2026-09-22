# dsh-remote-host-app

[English](README.md) | 中文

`dsh-remote-host-app` 是 DSH 远程配对和托管 Web runtime 的已签名常驻 macOS owner。它独立于 Electron Desktop renderer。Host 会在读取信任资源前验证自身已签名容器，并在原生代码中持有 relay credential 和 transport state。原生 owner 不暴露 inbound public listener、token、private key 或通用 identity API；sealed hosted child 只服务其配置的 loopback Web origin。

## 安装与打包 runtime 信任

发布版只能以规范且无符号链接的 `DSHHost.app` 运行：系统级安装位于 `/Applications` 且归 root 所有，用户级安装位于当前用户的 `~/Applications` 且归该用户所有。登录用户是用户级安装的显式信任主体。两种位置都要求已封存的 Host designated requirement、严格的整包 code seal、app 全树归同一获准 owner 所有、无 extended ACL、无 group/world writer、嵌入式 manifest 和 digest 已验证，并且 nested-code requirement 有效。

app 内含已签名原生 child、`DSHRemoteHostKeychain.xpc`、固定版本的 Node executable、已捆绑的 `dsh web` entrypoint 及其完整复制的 runtime closure。Production 不会从 `PATH` 解析 Node，不会跟随 source-checkout path，也不会执行外部 symlink farm。任何托管代码运行前，outer app signature 会封存固定的 resource-relative layout 和 install-specific hosted-Web configuration。

`CFBundleIconFile` 指定共用的 `DeepSeek.icns` 资源，该文件在签名前复制到 Host 中。[Desktop 图标打包参考](../../apps/desktop/README.md) 负责说明图稿生成和验证流程。

## 配对与激活

**Pair iPhone from anywhere…** 会创建短期 pairing code，并同时显示 QR code 和可选择的手动文本。手机只提交公开 enrollment offer。Host 会显示完整 fingerprint 和 device label；Mac 前的用户必须与手机比对 fingerprint 并批准，之后 provisioning 才能创建 route 或返回受保护 invitation。文件导入 action 使用相同的有界公开 offer 解析和 Host 确认规则。

配对对话框为完整 QR code 及其白色扫描边距预留空间，手动代码完整换行显示而不截断。如果 QR 渲染失败，可选择的手动代码仍然可用。

配对后，**Start hosted runtime** 会启动 sealed hosted child，并恢复符合条件的已签名 FD199 journal。hosted child 通过固定 descriptor 198 接收 relay record，通过固定 descriptor 199 接收 authority handoff record；它既不会收到 Host token，也不会收到私有 agreement material。**Activate paired phone** 会先完成已签名 FD199 ownership transition，随后原生 Host 才打开已认证的 V3 relay WebSocket。浏览器和手机由此使用同一个 hosted runtime。

原生 epoch ledger 只允许一个 live Host route owner，仅在认证 handshake 后提交 epoch，并能在不跳过 next epoch 的情况下协调 lost receipt。手机网络中断后，可以通过保留的 route 按 Host 发出的 next epoch 重新连接。Host 正常重启后，**Start hosted runtime** 会先恢复已验证 journal、active route 和 hosted state，然后才恢复手机 activation。

**Revoke paired phone…** 要求 Host 再次确认。它会退役 hosted child 的公开 route state，安装 durable native revocation fence，停止保留的 relay，执行幂等 remote deletion 和本地 Keychain cleanup，清除 hosted owner，并允许之后重新配对。含糊的 remote 或本地 cleanup 结果保持可恢复，且绝不会恢复可用 invitation。

## 原生安全边界

FD198/FD199 channel 使用有界 Remote Wire record 和固定的 direction-specific vocabulary。Host 会在生成 child 前关闭无关 descriptor，在 ownership transfer 需要时设置 close-on-exec，验证严格 record order 和公开 metadata，并在畸形输入、overflow、timeout、EOF 或 shutdown 时 teardown 并回收 child。Route secret 和 private key 绝不会穿过任一 channel。

V3 WebSocket transport 会固定 production origin、route path、Host-token subprotocol、enrollment lifetime、route generation 和 connection epoch。其已认证 eight-flight handshake 通过受保护 agreement service 派生 directional X25519 material，认证规范 per-message data，拒绝 replay 或 substitution，并在 teardown 时清零原生 key material。

Relay credential 创建时带有面向已签名 Host executable 的 trusted-application Keychain ACL。替换现有 provisioning、route、cleanup 或 epoch value 时只更新 `kSecValueData`，绝不替换 `kSecAttrAccess`。读取、重复更新和删除使用 noninteractive authentication context，因此意外 authorization 会直接失败，而不会打开 SecurityAgent。

## 发布与 package 参考

[远程配对发布 cookbook](../../docs/cookbook/releasing-dsh-remote-pairing.md) 是 clean build、签名、relocation、notarization、TestFlight、different-network pairing、reconnect、restart 和 revoke 的权威流程。[hosted runtime packaging reference](docs/hosted-runtime-runbook.md) 记录固定输入、assembly boundary 和 installation trust check。请勿在此重复这些操作。
