# 原生客户端阶段交付状态

核对日期：2026-11-11 00:52 UTC。当前代码为分阶段实现，不是可直接投入生产的完整协作产品。没有远端 Actions 成功、三端正式 Release 发布或生产签名的证据。

## 已验证的能力

- Linux NSH 原生窗口实际显示，原始品牌 SVG 正常；缺少可信更新配置时保持门禁，重复重试不解锁，正常关闭退出。见 LINUX-GUI.md。
- 真实同机 IPv4 UDP 下 ICE/DTLS/SCTP 合成文件与 SHA256、合成 RTP/SRTP 通过。最新整合后完整同会话真实UDP用例在云桌面独立通过，见 real-udp-merged-session/；主exec无ICE候选失败保留，不混淆环境。另见 LINUX-P2P.md。公网 NAT、跨机 TURN 和真实采集不在该结论内。
- 同一对端会话的中文聊天、接受后多块文件、双向 ACK、背压中的停止及三条合成媒体轨测试通过；该组合测试使用虚拟网络和 FFmpeg 合成输入。
- 独立合成视频宿主完成真实同机 UDP → DTLS/SRTP → FFmpeg 解码 → GTK 原生纹理可见验收；坏帧拒绝后恢复，STOP清空且计数冻结，CLOSE拒绝三轨迟发，最终关窗exit0。它不是生产入口或真实摄像头/屏幕共享，音频播放未开启。详见 synthetic-video/README.md。
- 实际DTLS证书与已应用SDP绑定的完整指纹人工核对已接入UI；取消、重协商、满队列下关闭都会撤销旧快照。只记录用户经可信渠道比较的断言，不提供企业身份、角色或撤销权威。transport20项通过、1个既有OS网卡测试跳过，client49单测+5headless通过；完整双端原生UI核对仍未实机验收。
- 文件接收已改为固定目录句柄与匿名inode发布，实际Linux内核与协议负例通过；Android仅完成双ABI编译检查，未验证真实文件系统。macOS/Windows有独立候选后端，未接生产且未原生执行，明确禁止接收而保留发送。Android UI接受上限256 MiB，匹配SAF导出能力。
- 身份层 PKCE、回调及令牌边界有本地负例；Android 实验 OAuth 单次回调宿主双 ABI 检查和 Java/纯状态测试通过，默认关闭，已纳入 stage7 实验包，但尚未登记、设备启动或登录。
- 更新策略默认7天、最大30天，续签验证前序签名并递增序号；到期/离线/错误签名/升级未完成保持锁定。41个核心运行/安全测试和12个策略工具测试通过。工具不等于已部署续签服务。

## 企业信令最新验证（不等于生产上线）

- 本地提交 `efd3433` 的061身份防护与062认证信令候选已在用户fork完整001–062模板运行：36项真实RECORD权限断言（含并发配额和真实超时）通过。只在隔离数据库验证，没有部署生产。
- `fb878ea` 与 `e8bbde2` 接入固定WSS身份接口、成员绑定信令及实验聊天UI。默认构建不启用。原始scope token只留在身份连接，不放入SDP或对端消息。Owner JWT不能冒充已绑定的participant RECORD身份。
- 独立云桌面真实UDP企业会话r2测试3/3通过，前后101项源码与测试二进制SHA256一致；范围包括真实fork成员权限、邀请/应答、中文聊天、撤销后的停止与旧事件拒绝。见 `enterprise-signaling-e2e-r2/`。测试使用本地公司API夹具与测试主体，不是生产OIDC登录或公网NAT/TURN验证。主exec无ICE候选失败仍保留。
- 实验企业UI 61项单测与5项Headless测试通过，父任务独立复跑固定二进制并核对哈希。见 `enterprise-ui-r2/`。它们不能替代双端真实登录GUI验收。
- 企业媒体后台接线与文件取消安全修复已进入完整客户端回归：最终73单测+5Headless、strict clippy、默认check通过；transport33项通过，Android双ABI严格clippy通过。真实虚拟通道已验证发布先赢后取消仍双方获得保存回执。见 cancellation-final/。企业媒体UI仍未开放，需常驻隐私/停止区与可重放逐源快照；企业文件wrapper/UI未接通。没有新的设备、生产账号或三端Release验收。

## 安装包证据不能混用

当前最新实验 APK 为 `SurrealCK-stage8-444135d-media-oauth-test-only.apk`，132,821,749 字节，SHA256 `27af460e827ff2b5bbc65f261b564594d92295362be35758e305fdb38a788e3f`，绑定源码 `444135da377ef53ca7d1c2b990f4fb78c628105f`。包含实验媒体/OAuth、真实DTLS指纹核对、Linux/Android安全文件接收与256 MiB Android UI边界。没有生产 OIDC/更新信任配置，仍会保持启动门禁。

双 ABI 实际离线release链接、Java媒体/SAF/OAuth纯测试、4项路由测试、9项打包正负例、最终APK实际DEX/JNI/manifest白名单、v3测试签名、16KiB ZIP及ELF LOAD对齐均通过。source receipt确认构建前后输入相同，验收时工作树干净。父任务再次独立计算APK SHA256一致。本包未安装或启动，不能继承旧包的设备结果，也不含此后企业信令与取消安全修复。证据在android-host/build/stage8-444135d，摘要receipt另保存在此验证目录。

stage7 `9a8251c74041959ab2b95f04f8dbfa7e0bc8d3073fa3fc10b1d17cba4d898fe3`仍保留，绑定1903111，不能继承stage8的安全修复或验证。

前一 stage6 包 `1da56a09213e7b51f60767eed14cf8802f28b727f165fc1c79ed2d46c138b462` 保留但不含 OAuth。更早媒体包实际安装成功后模拟器崩溃，没有获得界面、权限、SAF、摄像头或远端播放验收。

## 仍需打通的真实链路

1. **可信更新发布**：确认既有签名 key 的所有者、发布策略端点、独占签发账本、最小签名/对象写权限及告警目标，按批准流程配置。没有生产信任根时包锁定；不能关闭门禁冒充可用。旧24h客户端需要兼容迁移，不能直接切换7天策略。
2. **企业身份**：先核对已有原生 client。不存在时，另行批准 ck 组织 public native client、精确桌面 loopback、产品 audience 与必要 claim。登记可能是 first-party/skip，且 IdP 源码即使只请求 openid 也会保存 refresh 记录，须明确披露。详见 native-identity/REGISTRATION-CHECKLIST.md。
3. **认证信令与 relay 凭据**：061防护与062信令已通过隔离fork验证，生产仍未部署。客户端每次操作检查当前会话租约，成员状态按周期重验；撤销检测有检查间隔与请求超时，不声称瞬时全局撤销。真实公司测试材料、participant scope签发及生产reconciler仍待获准后验证。不能把旧scope当持续授权，不能把bearer交给对端。TURN 仍需合法服务账户、限额和短期凭据 broker；没有公共匿名 relay 可用证据。
4. **平台媒体、文件与安装**：macOS/Windows安全文件接收候选仍待原生验收与接线；Android 完整权限/FGS/SAF/Surface、macOS/Windows 采集与原生纹理、正式更新安装重启仍需平台真实验收。FFmpeg 对应源码/许可证材料与 macOS ARM 运行时分发尚未齐备。
5. **发布**：需先取得允许的远端提交/Actions 路径并验证对应 commit 的构建。公开候选资产准备好后再原子切换签名策略，不能让最新策略指向尚不可下载的文件而锁住用户。macOS 公证、Windows 证书、Android 正式密钥均不能用共享私钥代替。

这些前置项未完成前，任何可下载包只能标为实验验证产物，不标为完整产品或生产就绪。

## 当前平台候选验证边界

安全接收小harness的Apple ARM和Windows GNU真实目标check/clippy通过，只证明metadata类型检查，未链接或调用原生API。Apple Intel目标在云机未安装，没有下载补齐。新原生probe CI覆盖macOS ARM/Intel和Windows MSVC；尚未触发。CI使用实际CPU/OS/Rust host断言，拒绝交叉目标与Rosetta，不再由runner名称猜产物架构。

用户fork candidate.105已按固定SHA下载并真实执行。隔离现有权限测试4项通过，另1项SDK补测确认自身权限字段保护缺口；结果与未验证影响严格分开，见fork-identity/README.md。生产数据、测试grant、真实组织账号均未接入。
