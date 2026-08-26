# dsh-remote-host-app

[English](README.md) | 中文

`dsh-remote-host-app` 是一个 DSH Host 远程边界的已签名常驻 macOS owner。它独立于 Electron Desktop renderer。它验证自身 code signature，并且绝不通过标准输入、TCP、HTTP、UNIX socket 或其他公开 listener 暴露 Keychain service、身份操作、token 或其他公开 API。

组装后的 `DSHHost.app` 包含一个已签名原生 runtime child 和一个已封存的 `DSHRemoteHostKeychain.xpc` bundle。两个原生 executable 都会在读取控制信任的 resource 前验证其封闭的已签名 bundle。Host app 在通过一个专用 socket descriptor 启动 runtime 前，会检查嵌套 runtime 的精确已签名 requirement 和规范 bundle-relative path。`posix_spawn` 会在 exec 前关闭所有其他已打开的 child descriptor；runtime 会在处理消息前在其唯一私有 descriptor 上设置 close-on-exec，并关闭每个无关 descriptor。Host writer 会设置 `SO_NOSIGPIPE`，并在畸形数据、溢出、EOF 或 child shutdown 时清除并关闭 channel，然后回收 child。

发布构件只允许从规范且无符号链接的 `DSHHost.app` 运行：系统级 `/Applications` 安装必须归 root 所有，用户级 `~/Applications` 安装必须归当前用户所有。登录用户被信任可替换自己的用户级安装；两种位置仍都必须通过严格的整包 code seal、已封存的 Host designated requirement、嵌入式 manifest 与 digest、嵌套 code requirement 检查，并且 app 内不得有 extended ACL 或 group/world write 权限。

原生 relay owner foundation 具有类型化 V3 route 与 provisioning credential、Host code-requirement Keychain store、精确 fixed-origin request construction 和 lifecycle state。`RelayEnrollmentLifecycle` 是唯一 production completion path：它要求本地确认，将 private runtime 的 `device.enrolled` receipt 作为 Host 和 device enrollment id 的唯一来源，取得已接受的 relay provision result，把完整 route credential 保存到 signed-native storage，之后才返回 phone-safe invitation。它会拒绝被更改的 public tuple 或 replayed receipt。在 relay create attempt 前，它会记录 native-only pending credential；uncertain create 或 failed compensation 保持 invitation-free，直到 idempotent cleanup 删除该记录。revoke 会在 remote request 前记录 durable cleanup intent。任何 ambiguous revoke result 或本地 cleanup failure 都会隐藏 invitation；recovery 会在删除任一 native credential record 前重新执行 idempotent remote deletion。`RelayHostPairingComposition` 将 signed-Host proof、public Host-identity provider、typed 32-byte static X25519 agreement operation 和固定 FD198 `device.enroll`/`device.enrolled` exchange 组合起来；helper 不接收 profile selector、generic operation、token 或 private key，其 caller 只能立即将返回的 secret 用于 native KDF。invitation 包含 route coordinate、client role token、这些 runtime-issued enrollment id、固定的 Host agreement key，以及预期的 device signing 和 agreement key。它只能发出公开的 `route.upsert`、`route.revoked`、`device.enroll` 和 `device.enrolled` Remote Wire fact，绝不发出 Host token 或 private key。`RelayURLSessionRouteProvisioner` 只位于显式的 `RelaySignedHostActivationConfiguration.validateRunningHost()` proof 之后，会检查 packaged Host designated requirement，使用 isolated no-cookie/no-cache session，并拒绝所有 redirect；正常 Host startup 不会创建该 configuration 或 provisioner。构造 provisioner 不会发送任何请求。因此 app 仍没有已激活的 provisioning action、WebSocket activation、QR presentation、Node gateway bridge、公开 network endpoint 或 live pairing action。

离线 Host V3 transport seam 仅接受注入的 socket 以进行确定性测试。它的 Keychain-backed epoch ledger 会使用由 kernel 持有且可在崩溃后回收的 Host-owner lease 与短暂 serialized state transition，在 socket 启动前为 active route 保留精确的 next epoch，仅在认证过的 device `confirm` 后原子地 finalise 该 epoch，随后发出加密 `receipt`；durable next reservation 可使用 prior epoch 协调 lost receipt，而不会跳过 next epoch。revoke 会先安装 durable tombstone 以拒绝后续 claim 和 reservation，再 fence active socket；socket 会在启动前后和加密流量前重新检查该 tombstone，recovery 会持续拒绝直到 native cleanup 完成。它会把每个 V3 flight 绑定到精确的 route、generation、epoch、device 与 enrollment-incarnation tuple，执行 `hello → welcome → ready → finish → ack → commit → confirm → receipt`，并通过受保护 static agreement seam、规范 hello/welcome HKDF salt、`dsh-remote/v3/3dh` info 及 directional key 派生 Host 侧的 `SS, e-S, S-e, ee` X25519 material。它使用与 Noble 兼容的 canonical per-message AAD 认证每个加密 flight，让 read 和 write 都与 injected-clock deadline 竞争，在 teardown 时清零 directional/sealer material，并在畸形输入、timeout、EOF 或认证失败时关闭。`RelayUnstartedURLSessionTaskFactory` 只能为 `wss://dshrelay.rulabs.dev/v3/routes/:routeId/connect` 创建一个 suspended task，并且仅带精确的 `dsh-remote-v3` 和 Host token subprotocol；它没有 `resume` 或 activation API。可复现的 `generate-v3-3dh-fixture.mjs` 会检查固定 Noble V3 reference fixture；transport 仍仅限离线，未经明确 activation review 不得连接真实 relay。

## 封存 Node gateway release artifact

已签名 Host 当前只启动其原生 enrollment runtime。它绝不会从 PATH、shell、environment variable 或 app-provided path 解析 `node`。未来的 V3 gateway release 必须同时使用 `--sealed-gateway-node` 与 `--sealed-gateway-entrypoint` 组装；只提供其中之一会被拒绝。

输入必须是外部生成的 macOS-arm64 Node release binary 和一个自包含、已编译的 `dsh-remote-host-v3.mjs` 文件。打包器会拒绝 symlink、TypeScript/package tree、ESM import、dynamic import、`require`、`process.env` 和 child-process access。它会签名复制的 Node binary，将其 strict designated requirement 与 SHA-256，以及 entrypoint SHA-256，记录在 `Contents/Resources/GatewayRuntime/GatewayRuntimeManifest.plist` 中，随后 outer Host signature 会封存该 manifest 和两个 artifact。

`scripts/build-sealed-gateway-entrypoint.mjs --output /absolute/dsh-remote-host-v3.mjs` 会以可复现方式将现有 V3 fixed-FD contract 编译为 dependency-closed preflight artifact。它只接受既有的 `--private-fd 198` argument，并验证该 descriptor 是 socket。它刻意不挂载 Cordis、不 provision route、不打开 relay，也不 proxy session。完整的 `remote-host-v3` coordinator 当前不符合 sealed bundle 条件，因为其 transitive Cordis/API stack 包含 ambient-environment read、dynamic module loading、optional `require` path 和 child-process code。

当前没有 package output 满足 live gateway release contract，也没有提供经过审查、可分发的 Node runtime。因此 Host 保持 fail-closed，且不激活 Node gateway。任何未来 native launcher 都必须先从其已签名 bundle 加载 sealed manifest，验证两个固定 resource path、两个 digest 和 Node code requirement，然后仅以固定的 `--private-fd 198` argument、空 environment 以及关闭所有其他 descriptor 的方式 exec 那个嵌入式 Node。它不得接收 route credential、Host private/agreement key、provisioning token 或 generic RPC surface。

## 组装

```sh
native/remote-host-app/scripts/assemble-host-owner.sh \
  --signing-identity "Apple Development: Name (TEAMID)" \
  --output /absolute/path/to/DSHHost.app
```

该命令会创建一个已签名 Host app，为 XPC service 推导其精确 designated requirement，将 service requirement 封存回 Host app，并验证嵌套 code signature。它不会安装 bundle 的 LaunchAgent、启动 app、创建 Keychain row、provision Cloudflare 或配对设备。

`scripts/verify-private-runtime-smoke.sh` 会组装临时已签名 Host owner，拒绝没有私有 descriptor 的直接 runtime launch，拒绝未由所选 identity 签名的 client，验证完整 code seal，证明修改后的 XPC authorization resource 会使该 seal 无效，拒绝已移除的泛用 operation vocabulary，并验证 owner 在有效 Remote Wire record 后 child 退出时仍可存活。

## 私有 runtime 协议

原生 runtime child 是未来打包 DSH runtime bridge 的窄占位符。它不接收 listening socket，不接受标准输入或标准输出协议，也不进行 config lookup。它在固定私有 file descriptor number 上接收一个 app 创建的 descriptor，并在处理消息前设置 close-on-exec。

Remote Wire 是固定的 length-prefixed record format：`u32 body length`、`u8 kind`、`u16 UTF-8 metadata length`、有界 metadata 和 opaque payload。record 最大为 8 MiB，metadata 最大为 16 KiB。唯一允许的 record kind 是 `runtime.ready`、`route.upsert`、`route.revoked`、`epoch.begin`、`epoch.begun`、`epoch.commit`、`epoch.committed`、`connection.open`、`connection.frame`、`connection.closed`、`connection.send`、`connection.close`、`host.stopping`、`device.enroll` 和 `device.enrolled`。`device.enroll` 是 Host-to-runtime record，使用精确公开 `{ "deviceId", "label", "signingPublicKey", "agreementPublicKey" }` metadata 且没有 payload；`device.enrolled` 返回该 tuple 以及 `{ "deviceEnrollmentId", "hostEnrollmentId" }`，同样没有 payload。native enrollment 和 relay-flight JSON scan 会在 Foundation decode 前拒绝 duplicate member name。native `route.revoked` record 使用精确 `{ "deviceId" }` metadata，与 inherited TypeScript consumer 对齐。未知 kind、畸形 length、无效 metadata、溢出、顺序错误的 `runtime.ready` 和 EOF 都会 fail closed。此基础只识别此 vocabulary：它不实现泛用 RPC、identity、token、route、relay 或 socket operation。

当前 runtime 只发送 `runtime.ready`，因此组装或启动此基础不会使用身份。未来 bridge 必须留在此已签名 child 内，并保持 app 的 pipe 协议狭窄；未签名的 `dsh web` source process 不是允许的 private-wire participant。

## ChaCha20-Poly1305 互操作 fixture

`SodiumXChaChaBridge` 只公开已认证的 RFC 8439 ChaCha20-Poly1305 encrypt、decrypt 和 secure-zeroize。SwiftPM 只会在 hardcoded SHA-256 与 architecture check 通过后链接 tracked macOS-arm64 static archive；ignored build output 和 preparation marker 绝不是 link authorization。`scripts/prepare-sodium-xchacha.sh` 会验证已检入 official Minisign signature 与 SHA-256、强制 arm64、记录 compiler、Xcode、SDK、flag、signature 与 source digest，并要求 zero-timestamp rebuild 重现 tracked archive digest。`scripts/verify-sodium-preparation-smoke.sh` 会证明 paired substituted archive 与 marker 不能满足 SwiftPM，且不存在 Minisign verifier 时会 fail closed。

prebuilt archive 有意只支持 macOS arm64。signed release 仍必须在组装所有 nested code 后验证完整 app code seal；此 source-level digest 无法防御能在 compilation 前同时替换 archive 与 `Package.swift` 的 active same-user process。

已检入的 `xchacha-v3-noble.json` fixture 记录了由 `packages/mobile/remote-relay-protocol` 使用的已固定 RFC 8439 `@noble/ciphers@2.2.0` primitive 生成的精确 32-byte key、12-byte nonce、AAD、plaintext 和 ciphertext。在 repository root 运行 `node native/remote-host-app/scripts/generate-xchacha-noble-fixture.mjs` 会解析该精确 mobile dependency，并将其重新生成以供 review。Swift test 要求逐字节相等，并拒绝已修改的 ciphertext 和 AAD。zeroization test 会验证调用方拥有的可变 buffer 在调用方释放它之前被覆盖。

生产 encryption 使用 frame sealer，而不是带 caller-supplied nonce 的 raw encryption。每个 sealer 创建一个 `SecRandomCopyBytes` 4-byte prefix，为每个 frame 生成一个 monotonic big-endian 64-bit suffix，并在最后一个 suffix 后 fail closed。Host 必须为每个 directional session key 使用一个 sealer，并随该 key 一同丢弃它；nonce prefix 与 counter 绝不恢复或在新 session 间共享。
