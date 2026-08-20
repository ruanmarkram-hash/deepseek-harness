# dsh-pairing-protocol

[English](README.md) | 中文

`@deepseek-ai/dsh-pairing-protocol` 是无账户手机配对的第一版线协议词汇。它是由 Electron 桌面信任锚、Expo 客户端和未来中继共同使用的纯解析与顺序库。它不生成密钥、不加密或解密数据、不存储秘密、不连接中继，也不批准设备。

## 接口面

```ts
import {
  acceptRelayFrame,
  parsePairingBootstrap,
  parseRelayFrame,
  validateMobileCapabilities,
} from '@deepseek-ai/dsh-pairing-protocol'

declare const scannedQr: string
declare const relayMessage: string
declare const previousSequence: number

const bootstrap = parsePairingBootstrap(scannedQr)
const requested = validateMobileCapabilities(['session:read', 'turn:send'])
const frame = parseRelayFrame(JSON.parse(relayMessage))
const lastAcceptedSequence = acceptRelayFrame(previousSequence, frame)
```

`parsePairingBootstrap` 只接受 `dsh-pairing:v1:<canonical-base64url-utf8-json>`。JSON 对象携带不含用户信息、query 或 fragment 的 `wss:` 中继 URL；公开且不透明的 pairing 与桌面 id；短时中继 bearer token；不超过五分钟后的过期时间；以及桌面声明的移动端能力集。中继 token 是敏感信息。调用方只在活跃配对期间把它存于安全的平台存储中，绝不将其放入日志、分析、URL 或持久会话历史。

`parseRelayFrame` 只接受精确的已版本化 JSON 信封：pairing id、不同的发送与接收设备 id、不大于 `MAX_RELAY_SEQUENCE` 的正数序列号，以及编码前限制为 64 KiB 的规范 base64url 密文。该包无法检查密文。中继把它作为不透明数据转发，而调用方负责已认证加密、密钥验证、重放状态持久化以及关闭／重新换钥行为。

桌面只批准 `MOBILE_PAIRING_CAPABILITIES` 允许列表：`session:read`、`session:subscribe`、`turn:send` 和 `turn:cancel`。`validateMobileCapabilities` 对其他每一个字符串、重复项、空集合或非字符串项都采用失败关闭。该词汇刻意不包含计算机使用、文件系统、凭据、workspace 或管理能力。

对每个 `(pairingId, senderDeviceId, recipientDeviceId)` 方向，调用方保留一个初始为 `0` 的 `lastAcceptedSequence`。`acceptRelayFrame` 只接纳下一个连续序列。重复帧、间隙、无效计数器和已耗尽计数器都会以 `PairingProtocolError.code` 失败关闭；恢复与重新配对决策仍在本包之外。

## 已知限制与暂缓事项

- **密码学仍在外部**——此包不选择 AEAD、不派生密钥、不验证设备密钥，也不绑定加密握手 transcript。Electron 宿主和原生客户端必须在发送或接纳帧前使用经过审计的平台密码学。
- **没有权限或存储**——中继 token 存储、桌面确认、能力授予、设备撤销、重新连接状态和 Durable Object 路由都需要各自的平台实现。
- **没有中继行为**——中继可以只校验自己的传输 token 与路由字段。它不得检查、转换、重放或保留明文，因为此协议包中没有明文。
