# 桌面企业预览 staging（默认关闭）

本工具独立于默认 NSH 安装器与 Release 工作流。它只在对应原生 runner 显式构建并准备 `.app` / Windows 目录，不生成或上传正式安装器，不改变客户端强制更新门。

## 运行

在仓库根目录、已配置原生 SDK 与 Rust 的 macOS/Windows runner：

```
python scripts/native-client/desktop-enterprise-preview.py --platform macos --out dist/enterprise-macos-test-only
python scripts/native-client/desktop-enterprise-preview.py --platform windows --out dist/enterprise-windows-test-only
```

两条命令分别在对应平台运行，输出目录必须不存在。脚本会真正执行 Cargo，不能用于资源受限机器上的纯检查。轻量结构测试：

```
python scripts/native-client/test_desktop_enterprise_preview.py
```

脚本强制 `--release --locked --bin surreal-collaboration`，显式启用 `desktop,experimental-enterprise-media,experimental-enterprise-files` 和对应 `experimental-macos-video` / `experimental-windows-video`，Windows 另启用 `windows-auto-update`。不使用 NSH 默认生成 runner，不接受外部旧 binary 参数。Cargo JSON 必须确认手写 `native-client/src/main.rs`、唯一 executable、实际 features 和 release profile。接收 Cargo 的正常缓存产物不等于重编所有依赖；源码与公开更新配置在构建前后必须一致。

`preview-receipt.json` 绑定源码快照/commit、编译 features、原生 Rust host、复制后 executable 的 SHA256/大小。这个 receipt 是本地构建旁证，不是数字签名、可信发布证明或完整依赖清单。`.app` 使用独立 preview bundle ID，不冒充生产包；客户端的数据目录/内部 app ID 仍可能沿用现有实现，应在隔离测试用户中运行，不能承诺数据隔离。

## 尚未验收的边界

- 当前只用合成 fixture 验证结构、拒绝错误 feature/main/重复产物/格式和 hash 绑定。没有在 macOS/Windows 运行本脚本或加载其产物。
- `.app` 尚未完成 Mach-O 架构/动态库闭包审计、最低系统版本/资源审计、签名、公证、DMG 包装与安装启动验收。Windows 尚需 PE 架构/依赖审计、可选合法 Authenticode 与 Inno 安装器验证。
- magic 检查只是防止明显混入错误格式，不能证明架构或可执行性。后续原生 runner 应使用 `otool -L` / PE import 审计并实际启动手写 binary。
- 媒体 `ffmpeg/ffplay` 未捆绑。当前 PATH 查找与设备权限不保证可用，不能标为直接安装即可使用的完整企业版。未来捆绑需稳定可信来源、许可证/源码交付、依赖闭包和实际执行验证。
- 缺少有效更新配置/在线签名策略时仍锁定；配置存在也只是 `embedded-unverified`。OAuth、信令、权限、媒体和文件发送的实际端到端验收仍需分别记录，不能靠 staging 推断。
- 不创建任何签名身份或凭据，不连接或部署服务，不上传附件，不创建 Release，也不进入默认安装包资产索引。

## 公开身份输入绑定与资源审计

仅读取九个白名单 `SURREAL_CK_` 字段：OIDC_ISSUER、API_BASE_URL、OIDC_CLIENT_ID、OIDC_AUDIENCE、NATIVE_REDIRECT_URI、OIDC_TOKEN_MODE、OIDC_ALLOWED_HOSTS、SURREAL_URL、SURREAL_NS。receipt 仅写入整个白名单输入的 SHA256、字段存在列表和 configured-unverified/absent-blocked 状态，不写明文值，不读取 client secret/password/token 变量。构建前后同时比较此快照；缺少全部配置允许产生锁定测试包，部分或非法配置拒绝。URL 禁止凭据、任何 query/fragment；public PKCE 要求 issuer 命中明确主机且为443；Surreal 仅 WSS /rpc 与安全 namespace。结构校验不是客户端注册或服务可用证明。哈希是完整性旁证，不是加密保密手段，白名单只允许公开配置。

源码审计区分资源注册与实际读取：NSH0.4 `nsh-macros/src/assets.rs::assets_in` 为 `assets!()` 生成 AssetFile，其 source 是构建机器路径，注册本身不代表运行时会读取。客户端 `src/ui/mod.rs::brand()` 明确以 `ImageSrc::svg_markup(include_str!("../../assets/brand.svg"))` 嵌入品牌图，两个 logo 均调用它；theme.json 也由 include_str! 嵌入，当前 src 没有 asset: URI 引用。因此未发现品牌图必须复制到 Resources，不能把它误报为已知缺失。手写 main 未设 asset_base，NSH 依赖模块是否另有实际运行所需资源仍需原生验证；receipt 标注当前应用品牌/主题已嵌入、依赖资源闭包与启动未验证。后续在移除源码目录的原生 runner 启动验证字体、图标、主题与页面，若发现实际外部资源读取再收集重定位；本次不虚构必需资源清单，也不声称空 Resources 已经通过启动验收。
