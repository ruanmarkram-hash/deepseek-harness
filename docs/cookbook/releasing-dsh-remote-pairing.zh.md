# 发布 DSH 远程配对

[English](releasing-dsh-remote-pairing.md) | 中文

本指南将生产中继、已签名 macOS Host 和 TestFlight iPhone 应用作为同一个远程配对候选版本发布。它明确不包含 DSH Desktop。只有浏览器和 TestFlight iPhone 在不同网络上使用同一个托管运行时后，才能接受本次发布。

## 前置条件

- 位于目标提交的干净发布检出，不含已暂存、未暂存或未跟踪的源文件。
- Developer ID Application 证书、已配置的 `notarytool` 钥匙串描述文件，以及保存在仓库外的应用专用 Host 预配激活 plist。
- 有权部署生产 Worker 的已认证 Wrangler 环境，以及有权构建生产 iOS 应用的已认证 EAS 环境。
- 托管 Web 运行时使用的安装专用 DSH home、补丁相对路径、回环端口和受信 Host 名称。
- 能将 Host 安装到 `/Applications/DSHHost.app` 或当前用户 `~/Applications/DSHHost.app` 的 Mac，以及已加入 TestFlight 构建的实体 iPhone。

绝不将凭据、签名材料、预配 plist、提交标识符或发布证据放入仓库。

## 1. 冻结并验证干净源码

在仓库外设置 shell 变量。签名身份值必须是钥匙串中的完整 Developer ID Application 身份，`RELEASE_TMP` 必须是新的临时目录。

```sh
repo=$(git rev-parse --show-toplevel)
cd "$repo"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
git diff --check
RELEASE_TMP=$(mktemp -d)
```

生成目录和缓存目录是发布输入，不是源码。以下路径必须被忽略且不能出现在 `git ls-files` 中；任一条件不满足都应停止。

```sh
git check-ignore -q native/remote-host-app/dist/pinned-node
git check-ignore -q native/remote-host-app/dist/dsh-web.mjs
git check-ignore -q native/remote-host-app/.build
git check-ignore -q native/remote-host-keychain/.build
git check-ignore -q apps/mobile/.expo
! git ls-files | rg '(^|/)(\.build|\.expo|DerivedData|node_modules|dist)(/|$)'
```

生成任何发布制品前先运行源码门禁。

```sh
pnpm --filter @deepseek-ai/dsh-mobile-relay run check
pnpm --filter @deepseek-ai/dsh-mobile-relay run test
pnpm --filter @deepseek-ai/dsh-mobile-relay run deploy:dry-run
pnpm --filter @deepseek-ai/dsh-mobile run check
pnpm exec vitest run apps/mobile/tests
pnpm run doc-sync
```

## 2. 部署生产中继

已检入的 Wrangler 配置把 Worker 绑定到生产自定义域名。检查 dry-run 包，然后从冻结提交部署。不得将秘密加入 `wrangler.jsonc` 或命令历史。

```sh
pnpm --filter @deepseek-ai/dsh-mobile-relay run deploy
```

确认部署结果显示预期的 Worker、自定义域名、Durable Object 迁移和提交。如果路由缺失或指向其他 Worker，不得继续。

## 3. 构建已签名 Host 候选版本

托管运行时使用官方 Node.js v24.19.0 macOS arm64 版本。获取脚本只从 `https://nodejs.org/dist/v24.19.0/` 下载 `node-v24.19.0-darwin-arm64.tar.gz`，验证归档 SHA-256 恰好为 `8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d`，检查解压后的 executable 和版本，然后发布被忽略的固定树。

```sh
native/remote-host-app/scripts/acquire-pinned-node.sh
node native/remote-host-app/scripts/bundle-dsh-web.mjs
```

使用完整托管 Web 配置只组装一次。输出不得预先存在。`RelayProvisioningActivation.plist` 必须保留在源码外，并且只能封入候选版本。

```sh
native/remote-host-app/scripts/assemble-host-owner.sh \
  --signing-identity "$DEVELOPER_ID_APPLICATION" \
  --output "$RELEASE_TMP/DSHHost.app" \
  --provisioning-activation "$RELAY_PROVISIONING_ACTIVATION" \
  --hosted-child-node "$repo/native/remote-host-app/dist/pinned-node/bin/node" \
  --hosted-child-entrypoint "$repo/native/remote-host-app/dist/dsh-web.mjs" \
  --hosted-web-dsh-home "$DSH_HOME" \
  --hosted-web-patch-relative "$HOSTED_WEB_PATCH_RELATIVE" \
  --hosted-web-port "$HOSTED_WEB_PORT" \
  --hosted-web-trusted-host "$HOSTED_WEB_TRUSTED_HOST"
codesign --verify --deep --strict --verbose=2 "$RELEASE_TMP/DSHHost.app"
```

再次检查源码干净状态。生成的 Node 树和 Web 包必须继续被忽略且不受跟踪。

```sh
test -z "$(git status --porcelain=v1 --untracked-files=all)"
! git ls-files --error-unmatch native/remote-host-app/dist/pinned-node native/remote-host-app/dist/dsh-web.mjs >/dev/null 2>&1
```

## 4. 在公证前迁移并冒烟测试

将完整候选版本复制到一个受支持的规范位置，绝不通过符号链接运行。root 拥有的 `/Applications` 安装或当前用户拥有的 `~/Applications` 安装均有效。不得从构建目录或临时目录运行。

```sh
mkdir -p "$HOME/Applications"
test ! -e "$HOME/Applications/DSHHost.app"
ditto "$RELEASE_TMP/DSHHost.app" "$HOME/Applications/DSHHost.app"
codesign --verify --deep --strict --verbose=2 "$HOME/Applications/DSHHost.app"
open "$HOME/Applications/DSHHost.app"
```

在 Host 控件中选择 **Start hosted runtime**。确认中继仍未激活，在浏览器中打开已配置的托管 Web 源，创建会话，发送一条无害提示，并观察实时回复。退出并重新打开已迁移的 Host，再次选择 **Start hosted runtime**，确认浏览器能返回同一个已配置 Host 状态。如果 XPC 授权、密封资源校验、托管子进程启动、浏览器加载、会话创建、提示或重启恢复失败，应立即停止。

这就是最终公证前候选版本。通过后，不得重新构建、重新签名、替换资源、编辑清单或以其他方式更改代码字节。

## 5. 只执行一次最终公证

从已测试候选版本创建提交归档，并使用已配置的钥匙串描述文件恰好提交一次。被拒绝或结果不确定的提交代表候选版本失败：诊断问题，从干净源码重新构建新候选版本，重复公证前迁移冒烟测试，然后只为该新候选版本提交一次。

```sh
ditto -c -k --keepParent "$HOME/Applications/DSHHost.app" "$RELEASE_TMP/DSHHost-notary.zip"
xcrun notarytool submit "$RELEASE_TMP/DSHHost-notary.zip" --keychain-profile "$NOTARY_KEYCHAIN_PROFILE" --wait
xcrun stapler staple "$HOME/Applications/DSHHost.app"
xcrun stapler validate "$HOME/Applications/DSHHost.app"
spctl --assess --type execute --verbose=4 "$HOME/Applications/DSHHost.app"
codesign --verify --deep --strict --verbose=2 "$HOME/Applications/DSHHost.app"
ditto -c -k --keepParent "$HOME/Applications/DSHHost.app" "$RELEASE_TMP/DSHHost.zip"
```

装订票据和创建最终分发归档都不允许第二次公证提交。将已接受的公证结果与发布记录一起保存在仓库外。

## 6. 构建、提交并等待 TestFlight

生产 EAS 描述文件使用 App Store 分发、远程凭据和远程构建号自动递增。从同一冻结提交构建并提交该确切 iOS 构建，不得在源码中记录账户或提交标识符。

```sh
cd "$repo/apps/mobile"
eas build --platform ios --profile production --non-interactive --wait
eas submit --platform ios --profile production --latest --non-interactive --wait
```

上传完成不等于可用。等待 App Store Connect 完成处理、所需合规回答已完成、目标 TestFlight 群组能看到构建，并且实体 iPhone 能安装或更新到该构建。在仓库外记录公开应用版本和构建号。

## 7. 执行不同网络 iPhone 矩阵

使用已公证并装订票据的 Host 以及已处理的 TestFlight 构建。让 Mac 保持普通网络连接，并关闭 iPhone Wi-Fi，使手机使用蜂窝数据或另一个独立路由网络。

1. **配对和在场提示：** 在 DSH Mobile 中选择 **Pair this phone**，扫描或输入 **Pair iPhone from anywhere…** 显示的短期代码，在两台设备上比较完整手机指纹，仅在 Host 上批准，并满足 iPhone 在场提示。确认受保护邀请成功导入，且不暴露 Host token 或私钥。
2. **托管提示：** 选择 **Start hosted runtime**，然后选择 **Activate paired phone**。在 iPhone 上创建或选择会话，发送无害提示，并确认相同提示和回复出现在浏览器托管会话中。
3. **重连：** 只中断 iPhone 网络，再恢复网络，使用 **Retry connection**，确认同一路由按 Host 签发的下一 epoch 重连，没有重复消息或第二个实时 socket。
4. **重启：** 正常退出 Host，从规范位置重新打开已公证应用，选择 **Start hosted runtime**，确认保留的活动路由和托管状态得到恢复。重连 iPhone 并发送另一条提示，确认它出现在同一个浏览器 Host 中。
5. **撤销：** 在 Host 上选择 **Revoke paired phone…**。确认手机失去访问权限、重试失败，并且复制或保留的邀请不能恢复已撤销路由。
6. **忘记：** 在 iPhone 上选择 **Forget invitation** 并确认破坏性提示。重新启动应用，确认其中没有存储的 Host 邀请、epoch、cursor 或已渲染会话历史。忘记只影响本地，不能代替 Host 撤销。

只有每一行都在不同网络的实体 TestFlight iPhone 上成功，发布才算通过。模拟器、开发构建、仅同网运行、上传回执或未公证 Host 都不满足此矩阵。

## 8. 最终发布记录

在仓库外记录：源码提交、中继部署版本、Host 归档摘要、已接受公证结果、公开 iOS 版本和构建号、TestFlight 可用时间、Mac 安装位置、iPhone 型号和系统、所用网络隔离方式，以及矩阵每一行的结果。只发布通过测试的确切已装订 Host 归档和确切已处理 TestFlight 构建。
