Status: ready-for-human

# 12 · 全场景会议端到端验收与种子律所试运行闭环

**目标**：以独立 QA 视角对“日常办公会议 + 外部访客会议 + 名册核验正式大会（模拟破产债权人会议）”做一次完整上线前综合演练，输出可复现的验收包与种子律所操作手册。

## 范围

1. **四大真实场景串联验收**：
   - 场景 1（日常内部）：macOS 原生 APP ↔ Windows 原生 APP ↔ Web 浏览器跨网络音视频、共享与显式文件传输；
   - 场景 2（日常外部访客）：无账号隐私浏览器访客经等候室放行、交流、被主持人移出并验证旧会话失效；
   - 场景 3（正式外部大会 / 破产债权人会议模板）：批量签发 30+ 模拟外部主体令牌 → 勾选存证知情确认并多端（含手机 4G 浏览器）实名入会 → 单活互踢与吊销负例 → 禁自开麦/举手点名发言 → 发起 2 项表决 + 1 项异议 → 结束全体会议 → 签到与表决结果回写工作簿 → 核验并下载完整加密《会议存证包》（签到 + 录像水印 + 混音/分轨音频 + 举手表决账本 + SHA-256 根哈希校验通过）；
   - 场景 4（异常恢复）：主持端断网重连、外部手机端切网重连、微信内置浏览器提示引导、摄像头权限拒绝降级。
2. **安全与隐私专项核查**：核查服务端日志与数据库确认零令牌明文/访问码/凭据泄漏、日常会议无意外录制落盘、存证会议录像与存证包严禁公网直链且仅本工作区管理员可鉴权下载、外部主体零越权读取工作区其他数据。
3. **种子律所交付包**：编写 1 页《律所管理人开会手册》与 1 页《外部参会人免安装操作图解》（可直接发给债权人）。

## 非目标

- 不使用真实客户案件资料做测试；不跳过真机跨网络实测直接以本地模拟替代。

## 独立验收标准

- [ ] 四个核心场景在固定候选 SHA 上全部实测通过，每个场景均有脱敏证据（含 SHA、环境、网络类型、参与端类型与关键断言结果）。
- [x] 本地安全负例全部按预期拒绝。覆盖未放行访问媒体或信令、吊销重放、越权调用主持人接口、访客会话连工作区 DB、统一核验错误与枚举限流、超配额回写；环境和覆盖见下文。
- [ ] 在获准候选环境复测上述安全负例，核对脱敏日志和数据留存。
- [x] 产出面向种子律所的两份手册，并按当前 Web 页面操作名称校对。[律所管理人开会手册](../../../docs/pilot/meeting-host-guide.md) · [外部参会人免安装 3 步入会指南](../../../docs/pilot/external-participant-guide.md)
- [ ] 两份手册经产品独立复核。
- [ ] 发现的所有 P0/P1 缺陷全部关闭并复测通过，形成可交付种子律所试运行的正式验收结论。

**依赖**：`03`、`05`、`06`、`09`、`10`、`11`、`13`。  
**验证方式**：独立 QA 生产/候选环境实测 + 脱敏验收报告留档。

## 合入范围与本轮基线

2026-11-28 UTC。对照 `main` 基线 `3fd77731745034be21dbc52a659302504797a0a6`，本轮修复提交为 `c6872552286f0d8c32f11ac702608741b3217df7`。`#304` 锁定架构与证据口径，`#305`–`#307`、`#318` 落 TURN 签发、原生接入与中继配置，`#308`–`#310` 落 Web、访客与私有媒体，`#313`–`#317` 落名册、会控、回写、存证及参会引导。`#319` 落原生 UI v2，`#320` 是同机媒体部署方案，`#321`、`#322` 与 `#334` 修正 Web 会议返回值、管理员入会和状态提示，`#323` 增加公开入口保护。首期外部名册参会按 `#339` 仅走 Web。合入记录用于定位代码和既有证据，候选四场实测仍逐场验收。

公司 fork 使用 `$HOME/.surrealdb/surreal`，版本 `4.0.1-native-quota.1+sha.eab8473e4d4e9f0bfecde6013862ff18a7a676a9`（macOS arm64），制品 SHA-256 `a7e26e79edf7fa44a8ee437882c700a77bf9076bd16bd90987c9f00552569a4c`。`069-native-meeting.surql` SHA-256 `eb06a3cc5318a73628b2af4e4a56eaf88d8d14d48ad3e2ac8b9f81bad449df8a`，完整 workspace 模板末版 `073`。所有数据库测试使用本机隔离库。主要环境为 Apple Silicon、Bun 1.3.11、pnpm 10.32.1、Rust 1.99.1，媒体运行在本机隔离的 LiveKit 1.9.9 / Track Egress 1.15.0，浏览器为本机无界面 Chrome 158。测试输入均为合成数据。

## 本地验收回执

本地 fork 验证 V2 访客状态和数据库隔离、名册签发配额/事务、代际吊销、归档幂等与工作区证据守卫。真实 LiveKit 验证只听禁推流、仅麦克风授权、协办共享、旧入会授权和会控拒绝。存证测试实际调用 `scripts/verify-meeting-evidence.py` 验证下载包和可信根，修改一字节视频或表决内容即拒绝。浏览器组件试验使用临时独立 Chrome 上下文及受控接口响应，覆盖微信标识、访客等候和失权、名册知情及只读姓名、表决和个人回执。

| 命令（仓库根目录执行） | 实际结果 |
| --- | --- |
| `pnpm lint`（通过 `rtk proxy`） | 0 错误，0 警告 |
| `pnpm typecheck` | 退出 0，Svelte 0 错误、既有 12 条警告 |
| `pnpm test`（macOS 初跑） | server 2152 通过、166 跳过、2 失败，失败均为依赖 Linux `/proc/meminfo` 的维护脚本用例 |
| `pnpm --filter @surreal-ck/server test --test-name-pattern='^(?!.*(当前制品的未认证 SurrealKV\|runner 预检硬限制内存))'` | 稳定校时后 2158 通过、158 跳过、0 失败，含全部已启用会议集成测试 |
| Linux 虚拟机内从 `server/` 执行 `bun --no-env-file test ./src/deploy/surrealdb-upgrade.test.ts --preload ./test/setup-env.ts` | 4 通过、0 失败，含 macOS 初跑的两项 Linux 用例 |
| `pnpm --filter @surreal-ck/server exec bun --no-env-file test ./src/routes/meeting-{ice,roster,sfu,v2}.test.ts ./src/meeting ./src/db/native-meeting-gc.test.ts ./src/db/workbook-template-contract.integration.test.ts ./src/public-entry/protection.test.ts --preload ./test/setup-env.ts` | 45 通过、0 跳过、0 失败，含真实 fork、4 项真实 LiveKit 信令及 2 项真实 Track Egress 相关测试 |
| `pnpm --filter @surreal-ck/server exec bun --no-env-file test ./src/meeting/evidence-ledger.test.ts --preload ./test/setup-env.ts` | 5 通过、0 失败。真实执行 Python 校验，原包通过，视频及表决明细各改一字节均拒绝 |
| `pnpm --filter @surreal-ck/server exec bun --no-env-file test ./src/meeting/roster.integration.test.ts --preload ./test/setup-env.ts -t '真实名册存证' --rerun-each 3` | 稳定校时后 3 通过、0 失败，四类录像标记最大偏差 1446 毫秒 |
| `pnpm --filter @surreal-ck/web exec bun --no-env-file test ./src/lib/meeting` | 49 通过、0 失败 |
| `pnpm --filter @surreal-ck/web test` | 827 通过、30 跳过、0 失败 |
| `pnpm --filter @surreal-ck/shared exec bun --no-env-file test ./sql/template-packs/index.test.ts ./sql/workspace-template/index.test.ts` | 61 通过、0 失败 |
| `pnpm --filter @surreal-ck/shared --filter @surreal-ck/ops test` | shared 242 通过、7 跳过，ops 46 通过，0 失败 |
| `pnpm --filter @surreal-ck/web dev --host 127.0.0.1 --port 18890 --strictPort` 与 `pnpm exec node .meeting-acceptance-tmp/browser/meeting-components.mjs` | 4 项本地 Chrome 组件场景通过（临时探针） |
| `SURREAL_TEST_BINARY="$HOME/.surrealdb/surreal" pnpm exec bun --no-env-file native-signaling/tests/meeting-fork-rules.ts` | 2 组断言通过，含权限/容量/定向信令和实际租约/过期 |
| `cargo +1.99.1 test --locked --manifest-path native-client/Cargo.toml --lib --tests --features experimental-enterprise-meeting,experimental-enterprise-files` | 143 通过、0 失败 |
| `cargo +1.99.1 check --locked --manifest-path native-client/Cargo.toml --lib --tests --features experimental-enterprise-meeting,experimental-enterprise-files` | 退出 0 |
| `cargo +1.99.1 clippy --locked --manifest-path native-client/Cargo.toml --lib --tests --features experimental-enterprise-meeting,experimental-enterprise-files -- -D warnings` | 退出 0 |
| `cargo +1.95 test --locked --manifest-path native-identity/Cargo.toml` | 51 通过，另有 2 项默认忽略的真实 fork 联测 |
| `SURREAL_TEST_BINARY="$HOME/.surrealdb/surreal" cargo +1.95 test --locked --manifest-path native-identity/Cargo.toml -- --include-ignored` | 53 通过、0 跳过、0 失败，含未迁移工作区拒绝连接和 4 秒收件箱节奏 |
| `cargo +1.95 clippy --locked --manifest-path native-identity/Cargo.toml --all-targets -- -D warnings` | 退出 0 |
| `"$HOME/.surrealdb/surreal" validate native-identity/sql/signal-probe.surql` | 只读信令探测语法校验通过 |
| `cargo +1.95 test --locked --manifest-path native-signaling/Cargo.toml` | 21 通过、0 失败 |
| `cargo +1.99.1 test --locked --manifest-path native-call/Cargo.toml` | 32 通过、0 失败，用临时 macOS 打包目录提供 FFmpeg |
| `cargo +1.99.1 test --locked --manifest-path native-transport/Cargo.toml` | 53 通过、3 默认忽略、0 失败，含会议传输单元测试 |
| `cargo +1.99.1 test --locked --manifest-path native-transport/Cargo.toml --test meeting_mesh` | 1 个三端媒体测试通过，1 个 coturn 用例在下一条执行 |
| `cargo +1.99.1 test --locked --manifest-path native-transport/Cargo.toml --test meeting_mesh -- --ignored` | 1 个真实 coturn 双向 relay 用例通过，另用 `turnutils_uclient` 验证有效、错签、过期 3 项认证通过 |
| `cargo +1.99.1 test --locked --manifest-path native-transport/Cargo.toml --test loopback -- --ignored` | 1 个本机真实接口加密文件传输用例通过 |
| `cargo +1.99.1 build --locked --manifest-path native-transport/Cargo.toml --example meeting_interop_peer` | 互通夹具构建成功 |
| `pnpm exec node native-transport/examples/meeting_interop_drive.mjs offerer 18892 12` 与 `pnpm exec node native-transport/examples/meeting_interop_drive.mjs answerer 18892 12` | 各 1 场，共 2 场通过。每场原生与 Chrome 均接收至少 10 个音频包及每路 10 帧视频 |
| `python3 -B scripts/native-client/test_meeting_schema_preflight.py` | 5 通过、0 失败 |
| `python3 -B scripts/native-client/meeting-schema-preflight.py --candidate 3fd77731745034be21dbc52a659302504797a0a6 --migration 069-native-meeting.surql` | 1 次候选模板预检通过 |

重跑服务端会议套件时，指定 `SURREAL_BINARY="$HOME/.surrealdb/surreal"`，`LIVEKIT_SERVER_BIN` 指向固定版本的 LiveKit 1.9.9。`M13_TEST_LK_CLI`、`M13_TEST_BROWSER` 指向本地 `lk` 2.20.1 和 Chrome，`M13_TEST_ENDPOINT`、`M13_TEST_WEBHOOK_PORT` 指向回环测试服务。`M13_TEST_KEY`、`M13_TEST_SECRET` 仅使用夹具临时凭据。`M13_TEST_SPOOL` 指向 LiveKit Egress 1.15.0 共用的 `2770` 暂存目录，FFmpeg 须支持 `drawtext`。

媒体虚拟机与 Bun 需使用同一时间基准。时差约 5.3 秒且自动校时回拨时，两个全套回归各有 1 项超出 2 秒门槛，另一次名册录制单项 3 次重复均超限。暂停隔离虚拟机校时服务并用宿主时间校准后，全套运行前后时差区间分别为 −61…78 和 −59…92 毫秒。稳定校时后的共享、重入、发言授权及表决标记偏差分别为 869、131、440、523 毫秒，原断言保持 2 秒。

本轮修复了原生信令迁移探测。4.0.1 fork 查询缺失信令表可返回空数组，原探测误判为已迁移。修复后经普通 RECORD 调用 062 已有只读函数，准确识别缺少迁移，并增加结构化错误及 4.0.1 封装错误的回归断言。原生身份真实 fork 夹具同步更新认证制品和最小前置表结构。

测试夹具另修正三点。会议脚本按文件名定位 069，分别覆盖 069 前和完整模板。原生身份 HTTP 夹具将 macOS 接受的套接字显式设为阻塞。Rust–Chrome 互通夹具用浏览器内合成音视频绕过设备权限等待，原生对端退出时及时结束协商等待。

## 待候选环境及人工验收

候选环境需匹配同一 SHA、企业候选包及默认预览包、实际迁移审计和公司 fork 版本。需取得三个独立测试身份、授权网络和临时 TURN 租约。现有本地夹具未使用这些人工凭据，也未执行生产写入或压测。[三账号验收步骤](../../../docs/runbooks/native-meeting-acceptance.md) · [脱敏记录模板](../../../docs/runbooks/native-meeting-evidence.md)

- [ ] **场景 1 · 内部日常会议**。真实 OIDC 三账号先同机再跨网，含 macOS、Windows 原生和 Chrome/Safari。确认双向音视频/聊天/共享、桌面显式文件传输、同版默认预览门禁，记录每条边选中的直连/relay、RTP 增量、单边故障续租及设备回收。复核 coturn 错签/过期、限权对端与分配回收。
- [ ] **场景 2 · 日常外部访客**。无登录隐私浏览器走实际公开入口人机校验及等候室，放行后与内部 Web/原生进行双向媒体及共享。计时移出或散会后 3 秒内断流，并回查旧会话、公开入口限流和各工作区访问边界。
- [ ] **场景 3 · 正式名册大会**。在隔离候选实例安排 30+ 合成名册、桌面与手机蜂窝网参会，演练批量签发、单活互踢/拒并发、补发吊销、知情红标、锁麦/举手/聚焦、两项表决及一项异议、真实重连签到、回写及 PDF/CSV 抽检。测量收麦 2 秒、散会 3 秒和音画事件轴 2 秒。全包需从管理员入口下载，并由独立持有可信根的人在离线电脑验真。
- [ ] **场景 4 · 异常恢复**。主持端断网重连、手机 Wi-Fi ↔ 4G/5G、来电/切后台、纯音频/恢复画面、微信内真实跳转及摄像头被拒后的纯音频连通，核对签到连续和设备灯回收。
- [ ] **部署边界及容量**。检查 SFU 管理口和存证内容公网不可达、跨角色拒绝、实际日志与数据库无明文泄漏、日常默认不录制、实际存证隔离与匿名访问拒绝。仅在隔离目标规格实例执行 30+ 连接持续 15 分钟，采集开/关直录对照的 CPU/RSS、磁盘 IO、出网、丢包与恢复、同期 Hono/SurrealDB 延迟及资源清理回执。当前部署配置单房 15 席，容量验证使用隔离实例。
- [ ] **人工确认**。完成签名候选与更新门禁核对、产品独立审阅两份手册和独立 QA 放行。本期 TSA 合同测试使用替身，商用 TSA 供应商配置和真实回执在授权后另验。

## Comments

- 2026-11-28 本地验收。归档隔离真实 Bun origin、公司 fork、Chrome、LiveKit/Track Egress 和 coturn 的实测，以及 Apple Silicon ad-hoc 原生预览与门禁回执。保留四场候选、公网真机、已装原生应用登录 Web 联测、正式签名和独立 QA 放行。[Web 与无证书原生本地验收](../../../docs/runbooks/meeting-pilot-web-verification.md)
