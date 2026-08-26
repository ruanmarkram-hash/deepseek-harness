# mobile/：共享移动端产品词汇

[English](README.md) | 中文

这些包定义由 DSH Electron 宿主、原生移动客户端和远程中继共同使用的平台无关协议值。它们不提供 Cordis 服务，也不会向移动客户端授予本地计算机、文件系统、凭据或 workspace 访问权限。

| 包 | 职责 |
|---|---|
| [`pairing-protocol/`](pairing-protocol/README.md) | 校验无账户加密配对 bootstrap 数据、移动端能力声明和不透明中继帧的顺序 |
| [`remote-devices/`](remote-devices/README.md) | 持有 Host 的持久公开受信设备目录与注册 incarnation |
| [`remote-gateway/`](remote-gateway/README.md) | 通过注入的受信连接分派经过认证的 remote-wire 请求与有序 Host 事件 |
| [`remote-host-fd199/`](remote-host-fd199/README.md) | 通过继承 descriptor 199 执行经过认证的托管运行时所有权交接 |
| [`remote-host-identity/`](remote-host-identity/README.md) | 定义已签名原生 Host 身份 provider 与本地注册 controller |
| [`remote-host-v3/`](remote-host-v3/README.md) | 将已签名 Host 的继承 descriptor 198 接入已配置 V3 Host gateway |
| [`remote-relay-protocol/`](remote-relay-protocol/README.md) | 实现双向认证、加密的 V3 relay 握手和 frame transport |
| [`remote-wire/`](remote-wire/README.md) | 定义有界 V3 owner API、事件流、审批、action card 和 cursor vocabulary |
