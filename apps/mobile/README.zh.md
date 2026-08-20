# DSH Mobile

[English](README.md) | 中文

`@deepseek-ai/dsh-mobile` 是一个仅在前台运行的原生 Expo 伴侣应用，用于一个由桌面端选定的 DSH 会话。它提供以会话为中心的工作区和沉浸式文本对话，而 DSH 桌面端保留执行、批准、本地权限、文件、凭据、workspace 变更、附件、设置和会话创建权限。

版本二移动端 transport 使用已部署的版本二 relay。手机仍然只有在桌面端以密码学方式接受其配对请求后，才会将连接描述为实时状态。

## 配对与连接

用户粘贴由 DSH 桌面端创建的短时版本二 QR bootstrap。应用在内存中解析它，立即清空原始文本字段，并且只接受编译进应用的 DSH Cloudflare relay origin。它使用 Expo Crypto 的原生 CSPRNG 创建内存中的 X25519 移动端密钥，使用精确的 `dsh-pairing-v2` WebSocket protocol 连接，并将移动端 relay bearer 放在角色绑定的 subprotocol 中，绝不放入 URL，发送 `mobile-init`，并在派生定向 session cipher 前等待经过密码学验证的 `desktop-accept`。

应用会在过期、拒绝、畸形 traffic、socket 失败、用户断开连接或任意后台切换时结束连接。结束配对会关闭 socket，并从内存中擦除 QR bootstrap、relay bearer、临时密钥和 session cipher。手机不会重连或恢复之前的配对。

## 移动端范围

在桌面端接受后，应用只解密安全的 session snapshot、text delta、turn state 和安全 error。它只能为桌面端选定的会话加密经桌面端批准的文本提交请求。此仅前台版本没有可信的桌面端 run identity，不能取消 turn；取消功能只会在具备 run-identity 设计后恢复。UI 绝不把预览、缓存或断开连接的内容描述为实时数据。

相机配对和持久化密钥或会话存储被有意排除。应用将 [`website/public/favicon.svg`](../../website/public/favicon.svg) 中的官方 DeepSeek mark 用于应用和产品内图标，同时保留独立的 DSH 产品名称。
