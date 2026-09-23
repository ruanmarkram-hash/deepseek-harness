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

启动控制项和 Host 菜单中的 **Check pairing state** 会比较现有原生配对与已签名 hosted-Web 配置的 DSH home 下标准 JSON 公开 device 和 Host 目录。它只报告存在性、相等性布尔值或固定的读取/验证失败信息，绝不显示标识符、key、token 或任意错误文本。读取有大小上限，并拒绝符号链接、非普通文件和其他用户可写的路径。检查不能修复 enrollment、改变 Keychain 授权、复制 invitation，也不能启动 runtime 或网络连接；记录匹配不代表连接已建立。**Revoke paired phone…** 仍位于 Host 菜单中。

**Repair matching pairing records…** 是单独的本地操作，需要两次确认；它只适用于唯一已批准手机的两个持久化 enrollment incarnation 均与原生 credential 不一致的情况。必须先停止 Desktop 和 Web service 等所有外部 writer。Host 会拒绝仍保留 runtime ownership、Web 端口已占用、原生 route lease 被持有、provisioning/revocation recovery 未完成，或原生 epoch 已使用、pending、revoking、缺失的情况。现有公开记录必须构成 epoch 为零、public key 和 label 匹配且内部一致的单一同手机 device/Host/route tuple。修复只投影当前原生公开 route 坐标，保留无关元数据、文件权限、credential、invitation 和原生 epoch，绝不放宽正常 enrollment 准入。

私有 `storages/.pairing-repair/journal.json` 会在任何替换前保存精确的原始与目标公开字节及其 hash。每个文件替换都是原子的，并检查 preimage；部分失败只会回滚已知字节。中断的 journal 要求显式恢复，绝不覆盖意外的第三方写入。Hosted 启动和激活拒绝 prepared 或无效 journal。已完成 journal 保留为可恢复备份，但不阻止后续合法 runtime 写入。端口保留只能排除网络 listener，不能排除任意外部文件 writer。

配对状态报告区分持久化 Host enrollment incarnation 与 route 的 Host device ID，并分别报告它们是否与原生 credential 相等，避免匹配的手机掩盖其存储 route 上不同的 Host identity。

只有未改变的原生 credential 指向当前受保护 Host identity 时，才允许修复陈旧的公开 route Host device ID。修复在同一原生 route lease 和 transaction 内，将该 ID 与缓存且固定的 XPC identity 比较，并验证其 agreement public key 与受保护 agreement provider 一致。原生与受保护 Host 不匹配会被拒绝；此检查不会创建或替换任何 identity。

配对后，**Start hosted runtime** 会启动 sealed hosted child，并恢复符合条件的已签名 FD199 journal，但不会构造手机 session 或打开 relay socket。hosted child 通过固定 descriptor 198 接收 relay record，通过固定 descriptor 199 接收 authority handoff record；它既不会收到 Host token，也不会收到私有 agreement material。**Activate paired phone** 会先完成新的已签名 FD199 ownership，或恢复已经激活的 ownership，随后原生 Host 才打开已认证的 V3 relay WebSocket。浏览器和手机由此使用同一个 hosted runtime。

认证后的原生 handshake 完成 epoch 提交后，Host 会等待 child 精确的持久化 epoch 同步确认，随后才转发手机连接。此公开且绑定 route 的同步不会改变原生 ledger 或 mobile handshake。

显式手机激活最多等待 120 秒以接收已配对手机的首个 frame，让设备所有者有时间在加密 handshake 开始前完成认证。首个 frame 原样接受正常的 route、enrollment 和 epoch 验证；畸形输入不会重试。加密 flight 保留 10 秒 deadline。Timeout 错误区分等待手机、处理 hello，以及等待 ready、ack 或 confirm，且不暴露 credential。Stop 和持久化 revocation 会阻止迟到的首个 frame 创建 transport。

被拒绝的输入只报告固定 phase 和类别：畸形 flight、route tuple 不匹配、epoch 不匹配、无效 key material，或精确白名单内的 relay control 原因。Relay 报告始终终止连接，绝不授权本地 revocation、epoch 更改或 credential 替换。未知、过大、含重复 key 或额外字段的 control envelope 仍视为畸形输入；原始 frame 和任意服务器文本绝不显示。

原生 epoch ledger 只允许一个 live Host route owner，仅在认证 handshake 后提交 epoch，并能在不跳过 next epoch 的情况下协调 lost receipt。已建立的手机 transport 结束后，本地 Web runtime 保持可用，直到显式执行 **Activate paired phone** 重试。此操作会等待已结束 transport 的清理完成，停止已经 seeded 的 child，再通过保留的 route 按 Host 发出的 next epoch 启动新的 child 和手机 session。活动中的手机 session 会拒绝重叠激活。Host 正常重启后，启动本地 runtime 仍要求显式激活手机。

激活失败或替代 child 启动失败会退役已经 seeded 的 child；请先执行 **Start hosted runtime**，再执行 **Activate paired phone** 来重试。配对 credential、已签名 journal 和原生 epoch 保持不变。Stop 会取消 pending activation，并等待进行中的生命周期清理完成，随后才允许另一个 owner。[恢复决策](../../.agents/notes/implemented/bug-fix/2026-09-23-hosted-phone-session-recovery.md)记录了一次性 enrollment 和清理要求。

**Revoke paired phone…** 要求 Host 再次确认。它会退役 hosted child 的公开 route state，安装 durable native revocation fence，停止保留的 relay，执行幂等 remote deletion 和本地 Keychain cleanup，清除 hosted owner，并允许之后重新配对。含糊的 remote 或本地 cleanup 结果保持可恢复，且绝不会恢复可用 invitation。

## 原生安全边界

FD198/FD199 channel 使用有界 Remote Wire record 和固定的 direction-specific vocabulary。Host 会在生成 child 前关闭无关 descriptor，在 ownership transfer 需要时设置 close-on-exec，验证严格 record order 和公开 metadata，并在畸形输入、overflow、timeout、EOF 或 shutdown 时 teardown 并回收 child。Route secret 和 private key 绝不会穿过任一 channel。

认证后的 `connection.open` 携带完整的八字段连接 metadata。后续 `connection.frame` 和 child `connection.send` record 仅携带 `{ connectionId }`；child `connection.close` 精确携带 `{ connectionId, reason }`，其中 reason 必须是固定的 gateway 关闭原因。原生 frame pump 从 open record 派生此引用并比较解析后的连接 ID，拒绝额外或重复字段，不依赖 JSON 字段顺序或转义写法。陈旧的关闭消息不能停止当前连接。

V3 WebSocket transport 会固定 production origin、route path、Host-token subprotocol、enrollment lifetime、route generation 和 connection epoch。其已认证 eight-flight handshake 通过受保护 agreement service 派生 directional X25519 material，认证规范 per-message data，拒绝 replay 或 substitution，并在 teardown 时清零原生 key material。

Relay credential 创建时带有面向已签名 Host executable 的 trusted-application Keychain ACL。替换现有 provisioning、route、cleanup 或 epoch value 时只更新 `kSecValueData`，绝不替换 `kSecAttrAccess`。读取、重复更新和删除使用 noninteractive authentication context，因此意外 authorization 会直接失败，而不会打开 SecurityAgent。

## 发布与 package 参考

[远程配对发布 cookbook](../../docs/cookbook/releasing-dsh-remote-pairing.md) 是 clean build、签名、relocation、notarization、TestFlight、different-network pairing、reconnect、restart 和 revoke 的权威流程。[hosted runtime packaging reference](docs/hosted-runtime-runbook.md) 记录固定输入、assembly boundary 和 installation trust check。请勿在此重复这些操作。
