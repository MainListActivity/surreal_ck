# 原生公开配置预检与交付缺口

2026-11-11：本地仓库及可用相邻目录中没有可证明已登记的 native public client，也没有获准的更新策略公钥/URL。相邻 `ma_hono` 仓库在本执行环境不存在。已有依据见 `native-identity/REGISTRATION-CHECKLIST.md`；其中 discovery 支持 S256/none 不能证明具体 client 登记。`docs/oidc.md` 的 client 是 Web confidential，不可复用为 native。没有读取环境 secret、登记账户、生成生产密钥或更改线上服务。

## 构建前检查

在实际编译进程的同一环境中执行：

```sh
python scripts/native-client/check-public-inputs.py --platform windows
python scripts/native-client/check-public-inputs.py --platform android --require-configured
python scripts/native-client/test_public_inputs.py
```

macOS、Windows、Linux 仅接受带固定非零端口的 IP loopback，匹配桌面 receiver。Android 仅接受宿主 Java `AuthUri` 的精确 `top.maplayer.collaboration:/auth/callback`，不能用 `://auth`、Web callback、附加路径或桌面 loopback 替代。此 URI 仍是待批准登记的候选，不因本地检查通过就已获登记。必须启用并打包 `android-native-oauth` 宿主后才有接收能力。

脚本仅读取九个公开身份白名单字段及 `SURREAL_UPDATE_CONFIG_JSON`，输出字段存在性和身份哈希，不输出输入值。全部缺失在普通模式标记 `absent-blocked`；部分/非法输入失败。正式配置检查使用 `--require-configured`：缺失身份或更新配置均失败。结构有效仍标记 `configured-unverified`，不能替代真实 client 登记、更新策略验签、真实登录或发布 readiness 验收。不得以 fixture 配置解锁正式包。

这些是编译期输入，必须传递给实际 Cargo/nsh 构建进程；只给预检进程配置或在安装后设置环境变量不算配置完成。桌面 preview 现在按实际 target 校验并比较编译前后快照；正式桌面构建器同样传实际 target；`package.sh` 在 receipt/构建前预检，独立 `build-android-host.sh` 也在 Cargo 前预检，CI 执行对应回归测试。工作流不得默默用 Web client、占位公钥或临时生成 key 填缺项。测试 workflow 可保持空配置并验证锁定状态。

## 最小待确认输入

1. 部署方返回既有 **native/public** client 的公开 ID、issuer、token auth `none`、S256、实际 audience，以及分别获准的桌面精确 loopback 和 Android 精确 callback。若没有该登记，需要另行批准持久访问配置，不能靠 discovery 推断。
2. 确认公开 API 地址、WSS `/rpc`、namespace 和 OIDC 精确 host allowlist。现有线上地址只是来源线索，不等于原生 client 访问已批准。
3. 更新策略既有 Ed25519 公钥（32 字节），app/channel、HTTPS 策略 URL、策略/下载精确 host allowlist、已签署策略与平台发布者依据。不能拿 OIDC RSA JWKS 充当更新 Ed25519 信任根。使用现有 `update-policy.py` 和 release-readiness 检查真实签名/资产；必须具备续签责任人与已有受控签署发布流程。
4. macOS 另外需要既有 Sparkle 公钥、HTTPS appcast feed、SDK 固定版本和本机已有代码签名身份。Sparkle 与应用策略签名是两条独立验证链，不能自动互换密钥。只给公开值/身份引用，不在聊天或仓库提供私钥、密码、token 或证书私钥。

没有这些输入时可证明安装包启动后保持强制更新锁定，不能声称组织聊天、会议、共享屏幕、文件传输已经真实业务验收。
