# DSH Mobile

[English](README.md) | 中文

`@deepseek-ai/dsh-mobile` 是一个仅在前台运行的原生 Expo owner 客户端，用于连接一个已签名 DSH Host。它显示 Host 的实时会话和文本对话，而执行、审批、权限、文件、凭据、workspace 变更、附件和设置仍留在 Host。

## 配对与连接

生产流程在 iOS 钥匙串中创建受保护的 Ed25519 签名身份和独立 X25519 协商身份。原生模块只暴露公钥和受用户在场约束的协商操作，绝不暴露私钥字节。Expo Go 不包含该模块；配对和连接需要自定义原生构建或 TestFlight 构建。

进行互联网配对时，手机扫描或输入已签名 Host 显示的短期 `dsh3` 代码，只向固定 relay origin 发送公开注册 offer，显示完整指纹供 Host 端比对，并等待 Host 本地批准。返回的邀请会加密给该手机身份，包含设备路由凭据、Host pin、注册 incarnation 和确切下一连接 epoch，但不包含 Host 凭据或私钥。仍可通过本地文件或剪贴板传输同一个公开 offer 和手机安全邀请。

应用在原生钥匙串记录中存储一个已验证邀请、事件 cursor 和下一 epoch。导入时不会打开 socket。显式连接操作执行经过认证的 V3 relay 握手，只有验证 Host commit 后才报告实时状态。iOS 的 `inactive` 中断（包括系统在场提示）会保留待处理的在场会话。实际进入后台或断开连接会关闭物理 transport 并清除该会话；之后的显式重试只使用 Host 签发的确切下一 epoch。

## 移动端范围

Host 接受连接后，应用接收 Host snapshot 和有序事件，列出并创建会话，选择 Host 会话，并通过固定 remote-wire API 发送文本提示。只有原生存储持久应用事件 cursor 后，应用才确认该 cursor。新的应用投影视图会重置 cursor 以请求重放，而不会把缺失的本地内容显示为当前内容。

相机扫描仅用于短期 Host 配对代码。应用从不持久化已渲染对话内容，也不提供 macOS computer-use 捕获或控制。**Forget invitation** 会断开连接并删除手机本地路由状态，但不会撤销 Host 路由。撤销仍是已签名 Host 上的显式操作，该手机必须重新配对才能再次连接。

应用在自身图标和产品内图标表面使用来自 [`website/public/favicon.svg`](../../website/public/favicon.svg) 的 DeepSeek 官方标记，同时保留独立的 DSH 产品名称。生产发布和不同网络设备矩阵见[远程配对发布指南](../../docs/cookbook/releasing-dsh-remote-pairing.md)。
