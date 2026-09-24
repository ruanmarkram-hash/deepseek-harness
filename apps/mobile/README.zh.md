# DSH Mobile

[English](README.md) | 中文

`@deepseek-ai/dsh-mobile` 是一个仅在前台运行的原生 Expo owner 客户端，用于连接一个已签名 DSH Host。它显示 Host 的实时会话和文本对话，而执行、审批、权限、文件、凭据、workspace 变更、附件和设置仍留在 Host。

## 配对与连接

生产流程在 iOS 钥匙串中创建受保护的 Ed25519 签名身份和独立 X25519 协商身份。原生模块只暴露公钥和受用户在场约束的协商操作，绝不暴露私钥字节。Expo Go 不包含该模块；配对和连接需要自定义原生构建或 TestFlight 构建。

进行互联网配对时，手机扫描或输入已签名 Host 显示的短期 `dsh3` 代码。扫描只填写代码字段，不发送任何内容；**Pair with Host** 向固定 relay origin 发送一次公开注册 offer，显示完整指纹供 Host 端比对，并等待 Host 本地批准。Relay 冲突、代码不可用、连接失败和审批超时使用不同提示；找不到代码并不能证明代码已过期。返回的邀请会加密给该手机身份，包含设备路由凭据、Host pin、注册 incarnation 和确切下一连接 epoch，但不包含 Host 凭据或私钥。仍可通过本地文件或剪贴板传输同一个公开 offer 和手机安全邀请。

应用在原生钥匙串记录中存储一个已验证邀请、事件 cursor 和下一 epoch。导入时不会打开 socket。显式连接操作执行经过认证的 V3 relay 握手，只有经过认证的 Host receipt 已持久记录且 Host workspace 初始化完成后，才报告实时状态。iOS 的 `inactive` 中断（包括系统在场提示）会保留待处理的在场会话。实际进入后台或断开连接会关闭物理 transport 并清除该会话；之后的显式重试只使用 Host 签发的确切下一 epoch。

20 秒连接 deadline 覆盖所有者认证、socket 打开、handshake 和 workspace 初始化，包括 receipt 推进下一 epoch 之后。Timeout 会退役活动 transport 和发送权限，拒绝 pending request，并允许显式重试，但不会回滚已确认 epoch。首页、配对与连接面板共享实时进度、错误和重试控件。Connect 在认证前打开连接面板；重复点击不会启动重叠尝试，workspace 成功加载后会关闭面板。

连接失败和超时提示只标明一个固定阶段：所有者在场认证、身份加载、relay 打开、hello 准备或发送、Host 握手，或已认证 workspace 初始化。hello 发送成功只表示本地 carrier 接受了消息，不证明 Host 已收到。提示绝不包含底层错误、地址、标识符、凭据或帧内容；某一阶段失败并不意味着邀请过期，也不要求重新配对。

进程内提示在连接清理后保留安全错误信息，并记录应用报告进入后台、页面卸载或用户显式断开连接的原因，以及可用时的中断阶段。提示在页面重新挂载后仍保留，不包含连接权限，并在显式尝试、连接成功或 Forget invitation 后清除。每次断开仍会清除实时配置、transport 和所有者在场会话。返回前台不执行任何连接操作；清理后的显式重试会恢复持久邀请并重新认证。已取消的邀请读取不能在进入后台或卸载页面后启动认证。这些提示仅标识本地清理事实，不说明 iOS 生命周期事件的成因。

没有活动尝试时，重复清理会保留先前的中断原因和阶段。Forget 在调用时清除提示，因此在待处理的钥匙串删除期间收到的后台事件仍会保留供后续展示。显式重试可以替换已取消的操作，但仍须等待原生存储的串行读取完成。

所有者认证后，公开身份查询从当前原生身份会话投影公开字段，不再重复读取 Keychain。清除会话后不再复用；正常受保护加载和新的显式认证仍然必需。私有身份材料绝不返回 JavaScript。

## 移动端范围

Host 接受连接后，应用接收 Host snapshot 和有序事件，列出并创建会话，选择 Host 会话，并通过固定 remote-wire API 发送文本提示。只有原生存储持久应用事件 cursor 后，应用才确认该 cursor。新的应用投影视图会重置 cursor 以请求重放，而不会把缺失的本地内容显示为当前内容。

相机扫描仅用于短期 Host 配对代码。应用从不持久化已渲染对话内容，也不提供 macOS computer-use 捕获或控制。**Forget invitation** 会断开连接并删除手机本地路由状态，但不会撤销 Host 路由。撤销仍是已签名 Host 上的显式操作，该手机必须重新配对才能再次连接。

应用使用来自 [`website/public/favicon.svg`](../../website/public/favicon.svg) 的 DeepSeek 官方标记，同时保留独立的 DSH 产品名称。不透明的 1024 像素应用图标通过[共用图标生成器](../desktop/README.zh.md)在鲸鱼下方添加小号 `MOBILE` 标签；产品内标记保持不变。生产发布和不同网络设备矩阵见[远程配对发布指南](../../docs/cookbook/releasing-dsh-remote-pairing.zh.md)。
