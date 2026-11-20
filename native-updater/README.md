# 原生客户端强制更新信任核心

本目录已实现可执行 Rust 信任核心、真实 HTTPS 下载器、原子持久状态和 Linux 用户目录安装/重启，不是已上线的完整更新服务。生产信任根及签名策略端点未配置时，应用必须停留在更新门禁。macOS/Windows/Android安装适配尚未接入，保持拒绝而不是假报安装。不可用环境变量、跳过按钮或测试签名解锁正式客户端。

## 已实现与验证

- 默认关闭业务入口。每次启动取得新鲜策略并验签，版本严格相等才能进入。版本偏旧强制更新；本地版本高于签名策略拒绝降级。
- Ed25519 验证 payload 原始 UTF-8 字节，签名失败不解析/信任其业务字段。公钥固定在已签名应用内，不从镜像/网络载入。
- 策略绑定 app_id、channel、platform、arch，严格 SemVer（不接受 prerelease/build），序号与最近已接受策略 hash 防回放，同序号改内容拒绝。
- 签发默认有效期7天，核心硬上限30天（含边界）；过期、时钟回退、离线、未知平台、缺配置均阻止进入。有效期不是离线许可：每次启动真实联网检查，发送禁止缓存/要求重新验证的请求头，网络适配器不能拿缓存冒充网络成功。
- GitHub 主源失败后依次尝试明确签入策略的镜像，所有来源共用相同版本、size、SHA-256。拒绝 HTTP、带用户凭据、异常端口和非白名单主机。没有默认第三方代理。
- 测试使用公开确定性测试种子，不生成生产密钥、不存储密钥、不部署、不安装软件、不设置持久权限。

## 集成 API

依赖：`surreal-ck-native-updater = { path = "../native-updater" }`。

1. 在挂载业务 UI、P2P 线程、文件/通话功能前创建 `Gate::default()`。
2. 从发布时固化的可信端点下载策略，设超时、128 KiB上限；端点也可有显式镜像，但所有响应必须验同一固定公钥。网络失败调用 `gate.block(UpdateError::NetworkUnavailable)`，不读缓存放行。
3. 填充 `TrustConfig { public_key: [u8;32], app_id, channel, download_hosts }`；`CheckContext { installed_version, platform, arch, now_unix, highest_sequence, previous_policy_hash, last_seen_unix }`。安装版本来自原生包内版本而非 UI 输入；序号/hash/时间读受保护持久存储。
4. 调 `gate.check(bytes, &config, &context)`；返回 Ok 不代表能进应用：必须检查 `gate.can_enter()`。`UpdateRequired` 也是成功验证的策略，但保持锁定。
5. 若有 `gate.acceptance()`，原子持久化序号、策略hash及时间。存储失败必须 `block`；成功后才允许挂载业务。不同 app/channel 的存储必须隔离。
6. `UpdateRequired(release)` 时自动调用 `download_verified(release, fetch)`。fetch 是平台网络适配器，需要超时、流式size上限、TLS验证、可信跳转控制。GitHub release URL 常跳转至其资产域名；应仅显式信任官方资产主机、禁止 HTTPS 降级、限制跳转次数。没有任意跟随 Location 的许可。
7. 校验包内容后交平台原生签名/发布者验证与安装器。SHA-256成功绝不等于已安装。保持门禁，安装完成退出旧进程并重新启动，然后重做完整策略检查。不能调用“安装完成解锁”。失败明确提示并自动有限重试；不要无限循环下载耗尽流量。
8. 自动安装仅在业务 UI 尚未启动、没有未保存会话时直接重启；运行期升级应先安全保存草稿，排空或终止连接，禁止伪造发送成功。

`Gate::message()` 提供简体中文错误/更新提示；`status()`可呈现具体类别；`acceptance()`只包含非秘密状态。核心返回 Ready 的状态只用于本次启动验证，调用者不得跨进程序列化 Ready 或缓存为永久通行证。

## 签名格式

外层：`{"payload":"<原始JSON字符串>","signature_hex":"<64字节Ed25519签名的128个十六进制字符>"}`。

payload字段：`schema:1, app_id, channel, sequence, issued_at, expires_at, releases`；Unix时间单位秒；序号严格单调。每个 release：`platform, arch, version, url, mirror_urls:[], sha256, size, publisher`。平台 macos/windows/android/linux，架构 aarch64/x86_64。publisher 是真实平台发布者身份，不得填写 unsigned/test-key 来冒充可信。`deny_unknown_fields` 拒绝未知字段。

发布资产可长期存GitHub；策略独立于安装包续签，默认7天并不会自动延期，到期仍锁定全部用户。当前只有准备、外部签名验证及只读检查工具，**未部署持续签发/监控服务**。密钥轮转需专门受信任迁移，禁止下载新公钥即信任。

## 策略续签与到期预警

### 时间窗口与安全取舍

- 默认7天给每日续签提供周末/短期故障恢复余量，30天是协议上限，不能用长期静态策略代替运营。正常运行不建议直接使用上限。到期瞬间（now == expires_at）拒绝，不设宽限期。
- 同一序号只允许**完全相同的原始 payload 字节**，重复分发无需重新签名；任何内容变化，包括只延长有效期，都必须提高序号。客户端原子保存最高序号、payload SHA-256 和已观察时间，失败启动也先保存时间下限，回拨时钟不能清除已观察到的过期时间。网络失败、错误签名和必须更新均不会解锁。
- 较长 TTL 的代价：尚未看到新序号的客户端可能接受仍在有效期内的旧签名策略，默认最多7天、上限最多30天。HTTPS 在线访问、缓存重新验证及本地序号下限，不构成“全局最新序号”的密码学证明。策略服务须始终返回最新已提交对象，镜像保持一致；如需严格抵御端点冻结/重放，还需要受信任时间与在线挑战/版本服务，不能仅把 TTL 调长就宣称解决。
- 已有仅支持24小时的旧二进制会拒绝7天策略，甚至无法自动下载新版。若已分发旧版，先通过仍 ≤24h 的策略升级客户端，或为新版固化新端点并持续刷新旧端点，直到旧版迁移完成。不能直接替换共用端点使旧版锁死；首次尚未分发的版本没有这个兼容负担。

### 可执行但尚未部署的发行流程

工具为 `scripts/native-client/update-policy.py`，仅依赖 Python 标准库及已有 OpenSSL 的 Ed25519 验证。它不生成/读取私钥、不调用签名服务、不上传、不安装定时任务。输出文件必须不存在，防止覆盖前序已签名历史。

1. 每个 app/channel 维护持久发布账本：最高已签署/保留序号、原始 payload hash、签名 envelope、签署/发布结果及时间。发行和续签使用同一个单写者锁，或具备 compare-and-swap 的事务序号分配器。并发任务不能分别从相同旧文件签不同的 sequence+1。签署后但发布失败也保留该序号；重试同一原始 envelope，或使用更高序号，不能重用序号签另一份内容。普通文件命令本身不提供分布式锁/CAS。
2. 首次发行使用 `prepare ... --sequence 1 --initial`。以后发行必须使用 `prepare ... --sequence N --previous-envelope last-signed.json --public-key-hex PUBLIC`，脚本验证历史签名、app/channel、时间和版本不倒退。`--initial` 只适用于从未发行的通道，不得用于故障恢复或跳过账本。上游签名审批必须核对账本，不能仅信任命令行参数。
3. 建议每日 UTC 固定时间续签一次，即使没有发布新安装包。以下命令复制前序资产/URL/hash/发布者，默认序号+1、有效期7天；可对已过期但签名正确的前序执行恢复续签：

```sh
python3 scripts/native-client/update-policy.py renew \
  --previous-envelope last-signed.json --public-key-hex "$PUBLIC_KEY_HEX" \
  --output next-payload.json
```

4. 由**外部已授权的 Ed25519 signer** 签署 next-payload.json 的精确 UTF-8 字节，返回 signature.hex。操作人或后续获批执行器完成该步，本仓库脚本不能签名。然后包装并再次验签与检查续期序号：

```sh
python3 scripts/native-client/update-policy.py envelope \
  --payload next-payload.json --signature-hex signature.hex \
  --public-key-hex "$PUBLIC_KEY_HEX" --previous-envelope last-signed.json \
  --output next-envelope.json
```

5. 授权发布者原子替换指定 HTTPS 策略对象并保留历史；服务端设置 `Cache-Control: no-store`，不缓存负向响应，端点返回 HTTP 200。镜像只能复制同一 envelope，不能重签成不同内容；已见过新序号的客户端在部署/传播期间读到更低序号仍锁定。发布者需从所有客户端配置的真实端点重新读取并验证，而非只检查本地文件：

```sh
python3 scripts/native-client/update-policy.py check \
  --url https://YOUR-APPROVED-HOST/policy.json --public-key-hex "$PUBLIC_KEY_HEX" \
  --previous-envelope next-envelope.json \
  --expected-payload-sha256 "$APPROVED_PAYLOAD_SHA256"
```

`APPROVED_PAYLOAD_SHA256` 是签署的原始 payload 字节 hash，不是 envelope hash。URL 为占位符，必须替换为获批且固化在客户端的真实端点。在线 check 只允许直接 HTTPS、无重定向、30秒超时、128KiB响应上限。离线 `check --envelope ...` 仅用于发布前检查，不能证明线上可用；工具 JSON 输出包含 source、sequence、剩余秒数及 payload hash。

### 预警与故障处置

建议在与签发任务相互独立的已有监控运行位置，每小时对每个正式端点执行一次在线 check。退出码：0 为剩余时间 >48小时；1 为剩余时间 ≤48小时且 >24小时；2 为剩余时间 ≤24小时且 >0；3 为已过期、未来签发时间、签名/内容/序号错误、网络或运行错误。边界均包含等于，可通过 `--warn-before`/`--critical-before` 调整，但不能把工具失败当正常。监控必须固定该通道的最新已发布 envelope/hash 或最低序号，避免旧的有效策略被误报健康。

第一次警告通知已授权值班人，严重阈值/验签错误/端点不可用立即升级；每日续签失败即告警，不等到 TTL 临界。监控任务自身缺失/无结果也要由外部运行平台告警。无人处理时应用按既有规则到期锁定，不能删状态、回拨时间、使用测试签名、延长本地缓存或提供跳过入口救急。恢复为在正确时钟上签发更高序号的新策略并验证线上发布。

**部署前仍需用户明确选择/批准：**

- 续签执行位置及周期（建议现有受控发行 runner 每日一次），账本的持久路径/对象及单写者或 CAS；不要选择会被清空的临时 runner 磁盘。
- 既有签名服务/硬件中的具体 key ID，以及该执行身份只对该 app/channel 审核后的 payload 使用此 key 签名的权限。私钥不导出、不进仓库/环境日志；创建 key、凭据或持久访问需另行批准。本次未配置。
- 发布身份只可读写指定 app/channel 的策略对象和对应不可变历史，不需仓库管理、机器管理员、数据库、任意 bucket 或其他应用权限。私钥持有人与发布者可分离。
- 监控位置只需读取端点、公开验证公钥和发布基线，无签名/写策略权限；具体告警收件人、通道与发送权限也需批准。本次未安排计划或发送第三方消息。

## 分平台自动安装路线及未完成项

### macOS：可以自动下载、安装并重启

采用 Sparkle 2 原生集成，Developer ID 签名、Hardened Runtime、公证并staple，更新包独立EdDSA签名，保留相同bundle ID/Team ID。开启自动检查与自动下载，在门禁阶段使用 updater delegate `willInstallUpdateOnQuit:immediateInstallationBlock:` 的 immediateInstallHandler 自动安装重启，不要求用户每次点“更新”。Sparkle官方API支持无UI交互此路径。所有Sparkle appcast资产必须与本核心签名策略的版本/hash一致，不能让appcast绕过强制策略。

应用包所在位置需要可写；权限不足、签名/公证无效、系统安全规则等可能触发授权或阻断。不得以 `xattr -d`、关闭Gatekeeper或隐式sudo绕过。新安装首次系统启动确认与后续自动更新分开说明。

本目录尚未链接Sparkle.framework、编写Objective-C/Swift桥、实际生成签名appcast或执行macOS安装重启测试，不能声称macOS端已完成全自动更新。

官方依据：
- https://sparkle-project.org/documentation/api-reference/Protocols/SPUUpdaterDelegate.html
- https://sparkle-project.org/documentation/customization/
- https://sparkle-project.org/documentation/

### Windows

可对已安装在用户可写目录的应用使用成熟更新框架，自动下载、验证 Authenticode 证书链及固定发布者后，通过进程外helper等待旧进程退出、原子更换、回滚及重启。不要直接覆盖运行中的EXE；安装器exit code=0仍需重启读新版本确认。安装在Program Files且需要提权时不能保证零提示；不能静默新增服务或修改UAC。本目录未实现Windows helper、WinVerifyTrust或实机安装测试。

### Android

包须与已安装版本具有相容签名证书、相同package name且递增versionCode，镜像不能改签。普通未受管设备的未知来源首次授权及安装流程可能要求系统交互；后台自更新例外取决于Android版本、安装来源/更新归属、权限与目标SDK，不能仅设置 USER_ACTION_NOT_REQUIRED 就保证静默。

PackageInstaller返回STATUS_PENDING_USER_ACTION时保持锁定并明确显示系统要求，不模拟点击。企业设备已有device-owner/受管部署等合法前提时可另行实现静默安装，当前不得创建这些权限。Play分发需遵循其更新路径。当前没有Android PackageInstaller适配器或设备验证。

官方依据：https://developer.android.com/reference/android/content/pm/PackageInstaller.SessionParams#setRequireUserAction(int)

## 安全边界

本地管理员/root可替换程序或删除反回滚状态，单靠客户端门禁不能构成服务器访问控制。对强安全场景，服务端同时执行最低版本/协议策略，并把强制要求纳入P2P握手；不能相信客户端自报版本。可信时钟与平台代码签名必须在平台适配器实际实现。反回滚状态已经原子持久化；本地管理员删除状态仍无法由客户端单独防御。本核心不是远程证明方案。

## 验证

`cargo test --manifest-path native-updater/Cargo.toml --locked --offline`。除签名/版本/镜像安全，还覆盖7天策略跨24小时、到期瞬间、30天上限、续签序号/内容绑定、失败后的时钟下限、持久状态不能替代下次联网；以及真实本地TCP下载、真实ELF 1.0.0→2.0.0安装及exec子进程重启、异常包保留旧版本、符号链接拒绝、锁互斥/异常遗留锁恢复、状态损坏拒绝。测试TCP使用依赖注入的本地HTTP传输，不声称实证公网TLS；生产下载器固定HTTPS并验证证书，没有测试后门。测试需要系统C编译器cc。

`python3 scripts/native-client/test_update_policy.py` 使用预先计算的公开测试签名，验证外部 OpenSSL 验签、续签、不可覆盖历史、序号/时间回退、7/30天边界、48h/24h预警边界及网络失败。不部署签发/监控，也不生成凭据。

`cargo clippy --manifest-path native-updater/Cargo.toml --offline --all-targets -- -D warnings`。


## 已实现运行入口（Linux）

`runtime::load_embedded_config(option_env!("SURREAL_UPDATE_CONFIG_JSON"), state_dir, install_dir, installed_version, platform, arch)` 只解析构建时公开配置。JSON结构为 `EmbeddedConfig { trust, policy_urls, network_hosts, linux_executable }`，trust.public_key为32个整数；私钥绝不进入此JSON。所有路径/当前版本/平台来自本地可信构建，网络不能覆盖。

`runtime::run_startup(&config, progress)` 是阻塞函数，应在工作线程中运行；内部持锁读取反回滚状态、验证策略、原子持久化后，才返回 `StartupOutcome::Ready`。旧版本返回 `RestartRequired(新版本可执行文件路径)`；调用 `restart_linux` 以exec替换旧进程，失败仍锁定。只把Ready用于挂载业务组件，不把RestartRequired当成功解锁。

生产网络 `fetch_https` 使用rustls系统独立WebPKI根验证TLS，每跳重定向重新检查HTTPS/显式主机白名单、最多5次跳转、60秒请求超时及响应大小限制。生产GitHub资产主机需在network_hosts内明确配置，没有内置未知镜像代理。发布包完整下载到内存后验hash，当前限制2GiB；移动设备/大包后续需流式临时文件以减少内存，不能称已优化。

Linux安装仅写入传入的用户拥有目录，不改系统目录/注册自启动/提权。严格拒绝tar路径穿越、软链接/硬链接/设备条目、重复文件、超限解压和非ELF入口。包内nsh/app.json的id/version及release-version.txt必须匹配已验签策略。独立版本目录全部写入后原子替换current软链；旧版本保留。exec新版本后再次启动验策略。异常中断遗留stage不复用，内核文件锁随进程退出释放，避免永久锁死。旧版本目录/遗留stage目前不自动清理，磁盘不足会阻止更新并保持门禁。

缺少平台默认目录解析、生产签名服务、真实公网发布版本端到端验收时，不能说应用已具备生产更新能力。Linux实测版本迁移使用签名测试清单和测试ELF，未冒充发行包签名。


平台接入：`run_startup_with_installer(config, progress, installer)` 在持久化策略/验证包后才调用 installer(&Release,&[u8])。平台回调返回Ok只产生 `PlatformInstallerStarted`，从不解锁业务；macOS Sparkle或Android事件循环应自行安排安全退出，UI不能收到此结果就强制结束进程。当前平台代码由独立native-updater-platform模块提供。适配器缺失返回UnsupportedInstaller；测试覆盖坏包不会调用适配器、适配失败不解锁、成功回调前状态已持久化。
