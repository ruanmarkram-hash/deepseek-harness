# mobile/：共享移动端产品词汇

[English](README.md) | 中文

这些包定义由 DSH Electron 宿主、原生移动客户端和远程中继共同使用的平台无关协议值。它们不提供 Cordis 服务，也不会向移动客户端授予本地计算机、文件系统、凭据或 workspace 访问权限。

| 包 | 职责 |
|---|---|
| [`pairing-protocol/`](pairing-protocol/README.md) | 校验无账户加密配对 bootstrap 数据、移动端能力声明和不透明中继帧的顺序 |
