# 原生客户端安装包管线

## 已核实接口

固定 Rust `1.99.1` 与 NSH `v0.4.0`（本地 CLI `e626a8d`）。官方归档与各自 SHA-256 从 longbridge/nsh 同一版本下载，验证后解包。NSH 的 Rust root 由 `native-client/nsh.json` 定义，不构建 WebView。

- `nsh package native-client --target macos` 只生成 ad-hoc 签名 `.app`，`--sign` 不能代替 macOS Developer ID 签名。脚本另外生成带 Applications 链接的 DMG，分别构建 Apple Silicon 与 Intel。
- `--target windows` 仅生成可执行程序目录与 ZIP，脚本使用 GitHub Windows runner 已安装的 Inno Setup 6 生成每用户安装器，包含卸载程序，不要求管理员权限。
- `--target android --abi arm64-v8a --abi x86_64` 生成可安装 APK，支持现代真机与 x86_64 模拟器，实测最低 Android 9/API 28（以最终 APK manifest 为准）。SDK 35 / build-tools 35.0.1 / NDK 29.0.14206865 固定。非 32 位 ARM 包。
- Linux 输出 GTK4 可执行目录的 tar.gz，需要系统 GTK4 运行库，不声称是全静态包。

## 客户端构建约定

`native-client/Cargo.toml` 为独立 workspace，路径依赖 `../native-transport`。无默认 desktop feature，Linux 先运行无 GUI 的 `cargo test`，三个桌面平台另执行 `cargo build --manifest-path native-client/Cargo.toml --features desktop --bin surreal-collaboration` 验证直接启动入口。实际安装包由 NSH 通过 `root=App` 生成独立平台 runner，链接应用 library，不依赖应用自己的 desktop binary，也不需要传入 desktop feature。Android 同样走 Rust root，不能构建桌面 binary。

## 运行与产物

在仓库根目录运行 `bash scripts/native-client/package.sh linux`（或 `android`、`macos`）；Windows 运行 `./scripts/native-client/package-windows.ps1`。先安装 NSH、Rust 以及平台 SDK/编译依赖。本地脚本不会上传、发布或修改 GitHub 配置。

Actions 在 `feat/native-collaboration-bootstrap` 开发分支的原生相关路径 push、PR 和手动运行仅产生 workflow artifacts。开发分支 push 不触发生产部署，`contents: read` 保持不变，Release 验证作业仍只接受 `release` 事件。Release事件现在只校验预先公开的候选安装器及在线签名策略，不再自动上传缺失安装器；这是为防止先切强制策略、后上传资产导致旧用户锁定。全部预检通过后，仅附加尚不存在的验证receipt/索引/校验和等旁证，不覆盖同名文件，不创建tag或发布Release。安装包仍完整保留在workflow artifacts；真正两阶段候选预置/正式晋级流程尚待完成，不能称自动生成完整Release。

NSH 0.4 的 `package` 没有 `--features` 参数；前置 desktop binary 编译不改变 NSH 独立 runner 的 features。标准 Android 打包现已替换为完整 enterprise-collaboration 宿主，不再只交付基础 runner；测试签名和更新配置缺失状态仍如实记录。桌面安装包的功能覆盖由各平台打包步骤和验收结果单独说明。

## 签名与公证边界

没有通用“公开签名”能赋予应用合法发布者身份。公开证书没有私钥无法签名，共享泄露私钥不能使用。此默认 GitHub-hosted 工作流**没有配置或读取发布凭据**，因此默认结果为：

- macOS：ad-hoc，未经 Apple 公证，Gatekeeper 可能阻止安装或启动。
- Windows：未签名，SmartScreen 可能警告；不保证无提示安装。
- Android：NSH 标准测试签名，资产明确命名 `test-key`，不是生产签名。不同 runner 的测试密钥不同，覆盖升级可能失败并需要卸载，卸载会丢失应用数据。

脚本支持合法签名配置，但必须先单独授权凭据配置/持久访问，再接入受保护签名 runner 或签名服务：

- macOS：已安装的 `MACOS_SIGN_IDENTITY`，和已有 keychain 的 `APPLE_NOTARY_PROFILE`。脚本使用 hardened runtime 签名、等待公证、staple 与验证。缺身份时不尝试公证；配置后任何签名/公证失败会使构建失败，不静默降级。
- Windows：已安装 CurrentUser/My 中有私钥的 `WINDOWS_CERT_THUMBPRINT`，对应用 EXE 和安装器做 Authenticode 与时间戳（PowerShell 系统接口）；验证状态必须为 Valid。
- Android：已有 `ANDROID_KEYSTORE_PATH`、`ANDROID_KEY_ALIAS`、`NSH_KEYSTORE_PASSWORD`，无需把密码写进命令参数。生成包必须通过 apksigner verify 与 zipalign 16KiB 对齐检查。测试签名只提供安装完整性，不提供正式发布者可信身份。

当前脚本不创建 Apple/Windows 证书，不导入私钥、不创建公证凭据，也不绕过 OS 安全检查。NSH 在缺少 Android key 时创建标准临时 debug keystore，这是非生产 APK 测试构建所需，不授予任何服务访问。

## 验证范围

脚本语法、工作流结构及资产收集可在 Linux 静态测试；真实 macOS/Windows 编译与安装器执行必须由相应 GitHub runner 验证。只有生成包和 apksigner 检验通过并不代表 Android 真机/模拟器 UI 已启动，需要独立安装启动测试。工作流首次成功前不得声称安装产物已经可下载。

## 强制更新：GitHub + 中国镜像

每个平台额外生成 `*-assets.json`，记录版本、平台/架构、完整 SHA256、字节数与签名状态。Android 同一 APK 对应 aarch64/x86_64 两个目标。该资产索引不是可信更新策略。

`update-policy.py prepare` 严格匹配 `native-updater` 的 schema=1：生成尚未签名的 UTF-8 payload，包含 GitHub Release URL 与明确提供的 `--mirror-base`。镜像地址必须为 HTTPS；脚本在生成清单前下载并验证镜像全部字节与本地 release 资产完全一致，不允许镜像重定向，不使用未验证公共代理。没有提供镜像就保持空列表，不能声称中国镜像已部署。客户端仍须固定允许的源/镜像 host，并按签名哈希验证下载。

输入 `--publishers` 是平台/架构到真实发布者身份的 JSON 对照（例如 `android/aarch64`）；Android test-key 产物明确拒绝进入正式自动更新策略。稳定 Android release keystore 尚未配置时，不能宣称已实现跨版本覆盖升级。

外部已授权签名服务对 payload **原始 UTF-8 字节**做 Ed25519 签名。`update-policy.py envelope` 接收签名文件和公开验证密钥，调用 OpenSSL 验签后输出 `{payload, signature_hex}`，不创建私钥、不读取私钥、不发布。签名公钥必须与客户端固定公钥一致。没有合法签名服务不会伪造可信清单。镜像可复制同一 envelope，无需重新签名；不能更改 payload URL/版本/哈希。

策略默认有效期7天，客户端/工具硬上限30天。每次启动仍真实联网，离线/过期/验签失败继续锁定。`prepare` 和 `envelope` 必须提供 `--previous-envelope`（只有从未发行通道可用 `--initial`）；`renew` 验证前序签名后保持资产内容、递增序号并生成待外部授权 key 签署的 payload。同序号只能重复分发完全相同字节，任何续期都要新序号。输出文件不得覆盖前序历史。

`check --url ... --public-key-hex ...` 只读在线验签/到期检查，退出码0正常、1剩余≤48h、2剩余≤24h、3过期/不可用/不可信；线上验收应同时指定最新签署 envelope/hash 基线。建议每日续签、每小时检查、失败即告警，详细命令、单写者账本、最小权限及24小时旧客户端迁移见 [更新策略运维流程](../../native-updater/README.md#策略续签与到期预警)。较长有效期会扩大尚未见过新序号客户端的旧签名重放窗口，不能宣称严格的全局最新性证明。

**仅把一次签名策略放入 Release 不足以运营强制更新**，超过有效期仍被拒绝。当前工作流只生成安装包与资产索引，不自动签名/部署策略或镜像，也没有部署持续刷新/监控服务；这些工具不创建私钥、凭据或定时任务。Android 安装仍需系统授权，macOS/Windows 仍须原生验签与安装后重启确认。

离线校验：`python scripts/native-client/test_collect.py` 与 `python scripts/native-client/test_update_policy.py`。测试不生成密钥、不访问镜像、不上传。

## 第二阶段源码质量检查

`check-rust.sh` 对 client、transport、updater、identity、updater-platform、media-platform 六个 crate 运行默认 feature 的 rustfmt、locked tests 和 clippy（warnings 为错误）。Linux CI 显式安装 FFmpeg，支持媒体模块无设备的真实编码测试。没有开启实验性 macOS Sparkle feature。

Android CI 使用 API35 android.jar 对更新桥 Java 源码执行 `javac -Xlint:all -Werror`。这只是编译检查，不表示 Java 桥已合入 APK、系统授权已获准或可自动安装。macOS/Windows 安装适配器仍须单独平台宿主集成验收。


## 第三阶段 Android 宿主脚本检查

CI 额外运行 `test_android_host.py` 的负向及资源保留测试。普通 release 打包仍使用既有 NSH 路径，不默认启用实验 Android 宿主，不改变包 ID 或签名身份。实验宿主必须显式启用并提供已有签名密钥，其独立真实 APK/设备验收不能由这组 Python 测试替代。


## 通话与原生画面检查

质量脚本已扩展为八个 crate，增加 native-call 与 native-video-view 的默认 fmt/test/clippy。Linux 额外编译 `native-video-view --features linux-gtk,decoder`；已有 GTK4/GStreamer 开发依赖保持不变。此项不声称显示设备或画面交互已验收，也不启用尚未验证的 macOS/Windows 可选 renderer。


## 第五阶段平台 renderer 与实验 Android 媒体产物

macOS ARM/Intel、Windows MSVC runner 通过 `check-renderer.sh` 对完整 NSH 依赖执行 `native-video-view` 的 check/test/clippy，分别启用 macos-appkit/windows-d2d。当前只是新增检查路径，尚未运行这些 Actions，不能把本机绘制 API 探针结果称为完整平台通过。

手动 workflow_dispatch 新增 `experimental_android_media`，默认 false。只有显式选中才生成独立 `experimental-android-media-test-only` artifact，使用已由普通 NSH 测试构建使用的现存 debug key；缺 key 即失败，不创建新身份。普通 APK 已启用完整协同/更新宿主；release 事件不启用此分支，实验产物不进入 release 下载匹配或正式更新资产索引。

实验步骤运行独立 host 双 ABI 构建、Java 纯逻辑测试与打包器 JNI/DEX/资源/签名/16KiB 对齐校验；输出固定带 test-only 的名称和状态说明。它不安装设备，不授予麦克风/相机/屏幕权限，不声称真实采集、播放或自动升级已经验收。

## 认证信令协议预备层

质量脚本包含 native-signaling，检查纯协议/身份绑定负例及禁止伪造认证类型的 compile-fail 用例。后续已通过指定 SurrealQL skill 和用户 fork 完成本地强制规则、RECORD 身份与真实 UDP 信令验证，证据见 native-client/validation。生产认证、规则部署与三端设备验证仍未完成，本地测试不能当成生产已接通。


## 构建来源与锁定预览包防误发布

新打包必须使用空的目标输出目录，避免残留旧 APK/DMG 被 find 误选及重复复制失效。`build-receipt.py begin/finish` 将构建前后的源码内容指纹、Git提交/dirty状态、Cargo一致版本、应用ID、build号和公开更新配置摘要绑定到最终安装包hash/size；构建中源码变动直接失败。它只保存通过白名单校验的公开更新字段（端点、允许主机、公开验证key与相对路径），不保存私钥或原始任意配置，也不把未知来源旧包补标为新提交。

`collect.py` 必须验证 build-receipt 后使用其中版本，不能拿当前工作树版本给旧产物重新贴标签。已有未带receipt的本地APK只能作为历史实验包单独审计，不能当本轮可复现发布输入。receipt证明来源/字节关系，不证明编译器位级可复现或系统可用。

默认CI仍未配置 `SURREAL_UPDATE_CONFIG_JSON`，因此应用会被强制更新门禁锁住。workflow artifacts可以作为明确的测试预览留存；Release上传前现在拒绝此已知锁定状态。存在嵌入配置也只记为 `embedded-unverified`，仍须另验实际签名策略端点、有效期刷新、镜像和系统安装桥；此检查不会将它冒称全链路可用。没有新建凭据或更改门禁默认行为。


发布结构门禁进一步校验与 runtime EmbeddedConfig 一致的必需字段、固定 app_id、非零32字节公开key、非空通道与host列表、HTTPS443且域名在allowlist的策略端点、安全相对Linux executable。空对象、畸形JSON、未知字段、URL凭据/query/fragment及明显非法key均拒绝。该离线结构检查不验证key归属、线上策略签名、服务在线或系统安装，仍明确 embedded-unverified；不自动提供或替换任何测试key。


平台 renderer CI 在后端-only检查后，额外测试显式 experimental-host 的 registration/support 契约，再对真实客户端启用 `desktop,experimental-macos-video` 或 `desktop,experimental-windows-video` 执行 all-targets check/test/clippy，覆盖root注册与手写main。默认Release不传这些实验feature，仍不宣称目标平台Actions或实际画面通过。本地仅静态核验与命令路由测试，不做跨平台大编译。


## 在线发布预检与安全两阶段顺序

`check-release-readiness.py <assets> --repository owner/repo --tag <tag>` 现在是在线预检，不仅检查配置存在。它逐一验证所有配置策略端点（HTTPS、无重定向、128KiB上限、请求不使用缓存），使用包内公开key验证Ed25519原始payload，要求app/channel一致、非未来且至少剩余24小时有效期；多个策略端点必须提供同一payload。已知公开测试fixture/RFC测试key拒绝进入此生产门。

本地完整六平台/架构目标必须齐备，receipt、asset index、真实文件hash/size、策略版本/hash/size与精确GitHub tag资产URL全部一致；Android必须是release-key。每个主源及已签镜像还要实际公开下载并流式验证hash/size，最多5次仅到network_hosts白名单的HTTPS跳转，绝不只凭HTTP200或Content-Length判定一致。下载不落盘，检查结束重新核对剩余有效期。不存在端点、错误签名、过期策略、缺失资产/镜像或字节不一致均拒绝。当前没有合法端点/密钥配置，因而保持拒发布。

安全顺序由外部已授权发布者执行：
1. 一次构建固定字节及receipt，先把候选安装器公开预置为不晋升latest的候选发布，并验证源/镜像字节；此时不切当前用户的强制策略。只有私有draft资产不能满足未认证客户端下载要求。
2. 在所有目标候选资产可下载后，外部授权签名服务签署正确版本/哈希的策略，最后原子切换策略端点。工具不部署、不签发密钥。
3. 使用**同一批固定字节**运行最终在线预检，通过后再由授权发布者晋级正式Release。不得重新构建后假定签名/压缩字节仍一致。

现有Release事件job只提供最后的验证与缺少旁证附件，不负责候选预置、策略切换或正式晋级；若它重新构建的字节不同会拒绝，不能以覆盖安装器来“修复”。通过仅证明检查时在线策略和公开资产一致，不证明key归属、服务持续在线、平台安装成功、设备媒体或全局最新性。

## 候选桌面安全接收原生验证（未启用生产）

独立 `native-client-desktop-receive.yml` 只检查小型 `native-transport/validation/desktop-receive-probe`，没有 NSH/WebRTC 全量构建、发布步骤或生产开关修改。macOS ARM/Intel、Windows MSVC分别执行真实原生check/test/clippy，普通临时目录测试不提权，不改系统设置。Windows被ignore的symlink攻击测试明确未覆盖，job summary和日志保留此缺口；通过普通测试不允许把生产receive_supported改true。

2026-11-10重新核实 [GitHub官方runner表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) 与 [runner-images](https://github.com/actions/runner-images)：`macos-15`为ARM64，`macos-15-intel`为Intel；旧配置把`macos-14`当ARM是错误，且该label已退役。本轮同时修正原release和media矩阵，不继承该错误。`check-native-host.sh`记录并断言uname CPU/OS与rustc host完全一致，拒绝Rosetta和交叉目标，不fallback；receipt记录实际host_arch，资产索引不再从runner label猜架构。

本地只运行stub命令路由/错误CPU/OS/Rosetta拒绝测试与YAML检查，尚未触发Actions；这些本地测试不能充作macOS/Windows API运行证据。


## 实验企业信令 CI

Linux CI 单独运行 `check-enterprise-signaling.sh`：显式 check/clippy 覆盖 desktop main 与 experimental-enterprise-media、experimental-enterprise-files（含 signaling），lib 与 UI headless tests 覆盖实验入口（默认 jobs=1）；先检查三个实验 feature 均不能被 default 或 desktop 传递启用。它不导出feature环境变量，不修改NSH配置或现有package命令，因此不会把实验信令加入默认Release。native-signaling本身仍由常规质量脚本单独测试。这些是本地/CI代码检查，不替代真实企业认证与生产SurrealDB验收。

### Android 企业协作实验构建

`ANDROID_ENTERPRISE_COLLABORATION=1` 是单独显式选择，必须同时指定已有 `ANDROID_NATIVE_MEDIA=1` 和 `ANDROID_NATIVE_OAUTH=1`。它启用宿主 `enterprise-collaboration` feature；直接调用低层宿主构建脚本且未指定时默认关闭；标准 package.sh 已显式指定完整协同功能。封装仍须显式启用匹配的媒体与 OAuth Java/manifest 组件，不能把仅 Rust feature 当作完整宿主。此入口不配置生产登录、更新信任或签名，也不绕过更新门禁；构建与设备验收结果按具体产物 receipt 单独记录。

### Android 标准包的 updater 集成

标准 `package.sh android` 不再直接复制 NSH 基础 APK：CI 先获取 android-host 的锁定依赖，构建两 ABI 的 enterprise-collaboration/updater host，合并更新、文档、媒体与 OAuth Java DEX/manifest，检查实际 JNI 导出并沿用基础 APK 的签名身份。最终包必须通过签名证书一致性、DEX 类表、组件及 16KiB 对齐检查；标准入口显式启用媒体/OAuth；低层宿主构建仍默认关闭这些功能。可用 `python scripts/native-client/test_android_host.py` 回归命令路由及组件边界。

本地已验证静态打包，不代表系统安装权限、更新提交、进程重启或远端策略服务已验收。缺失 `SURREAL_UPDATE_CONFIG_JSON` 仍阻塞启动；不更改信任、签名凭据或更新安全门。
