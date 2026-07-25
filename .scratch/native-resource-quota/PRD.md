Status: open
Label: ready-for-agent

# surreal_ck 订阅配额控制面实施规格

更新时间：2026-07-25

## 一句话

把 Plus/Pro/Max、订阅、试用、人工调整和运营控制建模为 `_system` 中不可变资源权益，经确定性 compiler 与可恢复 reconciler 物化到配额受管 SurrealDB；浏览器继续直连业务 database，Bun 只承载资源控制面、角色化读取和运营动作。

## 规格来源

- canonical 决策地图：[`SurrealDB 原生配额与 surreal_ck 订阅控制面决策地图`](../native-resource-quota-wayfinder/PRD.md)
- 当前控制面审计：[`surreal-ck-control-plane-audit.md`](../native-resource-quota-wayfinder/research/surreal-ck-control-plane-audit.md)
- SurrealDB fork 实施规格：[`/Users/y/IdeaProjects/surrealdb/.scratch/native-resource-quota/PRD.md`](/Users/y/IdeaProjects/surrealdb/.scratch/native-resource-quota/PRD.md)

实现中若本规格与已关闭决策票冲突，以 canonical 决策票为准。

## 锁定边界

- workspace 是资源权益主体，billing account 是付款主体；同一真人可分别拥有工作区、付款和平台运营能力。
- Plus/Pro/Max 是稳定 plan；额度模板是不可变 plan revision。workspace 当前 entitlement 与 projection 都保留 desired/applied 指针。
- `_system` 是商业与调和权威；workspace database 内旧 plan/usage/event 数据不得升级为权威。
- Bun 使用 root 的窄 NativeQuotaClient 下发/INFO/REBUILD；浏览器不拿 root、不直接访问 `_system`、不管理 quota DDL。
- 普通工作簿/数据表 DDL、DML、SELECT 与 LIVE 仍由浏览器直连 SurrealDB。
- 新 workspace 在权益解析、原生策略物化、INFO readback 与账本 ready 前不能 active 或签发 scope。
- 新版本只连接通过 `native-quota-v1` 能力握手和 backend 认证的 fork；不兼容即 fail-closed。
- 运营面板只写审计意图，由同一 resolver/compiler/reconciler 执行，不直接修改 applied、usage 或 native policy。

## 不做

- 支付 provider 选型、checkout、价格、税、优惠券、退款或完整发票 UI。
- 业务 CRUD/LIVE 代理、service JWT、NS-admin 或把 root token 下发浏览器。
- index/storage/LIVE/query-rate quota。
- 终止后的自动删数、严格 native suspension 或实时 quota LIVE feed。
- 从可篡改旧 workspace plan/counter 自动认定用户已购套餐。

## 目标模块

- `shared/src/native-quota/**`：跨仓 DTO、capability/INFO/error schema、领域映射
- `shared/sql/system/**`：billing/plan/subscription/entitlement/projection/operation/operator/alert 权威 schema
- `server/src/db/native-quota/**`：NativeQuotaClient、capability gate、migration conductor
- `server/src/quota/**`：resolver、compiler、reconciler、sweep、alert、operator intent
- `server/src/routes/quota*.ts`、`server/src/routes/ops*.ts`：角色化控制面接口
- `web/src/lib/quota/**`、workspace settings 与独立 operations console
- deployment manifest、Docker/compose、跨仓 E2E

## 实施路线图

| 名称 | 主体 | 依赖 |
|---|---|---|
| [`建立跨仓 quota contract、SDK 固定版本与启动能力门`](issues/01-contract-sdk-capability-gate.md) | shared DTO、NativeQuotaClient surface、capability/readiness、compat manifest | SurrealDB contract fixtures |
| [`建立 _system 订阅、权益、调和与运营权威 schema`](issues/02-system-control-plane-schema.md) | plan/revision、billing、subscription/item、override、entitlement/projection、operation/alert/operator | 可与引擎并行 |
| [`实现 entitlement resolver 与确定性 policy compiler`](issues/03-entitlement-resolver-policy-compiler.md) | 来源优先级、immutable snapshots、stable rule ids/digest、retention | system schema + grammar fixture |
| [`实现 NativeQuotaClient、reconciler 与四类恢复循环`](issues/04-native-client-reconciler-sweeps.md) | INFO-first、generation guard、lease/attempt、audit/drift/rebuild | contract + compiler + candidate fork |
| [`改造 workspace provisioning、scope 与 capability-aware migrations`](issues/05-workspace-provisioning-migration-gates.md) | fail-closed saga、迁移 manifest、deferred cleanup、scope gate | schema + reconciler |
| [`实现 subscription lifecycle、service mode 与运营意图`](issues/06-subscription-lifecycle-operator-intents.md) | trial/active/past_due/cancel/retention、manual/contract、override、ops commands | schema + compiler + reconciler |
| [`实现角色化 quota API、错误映射、缓存与预警`](issues/07-quota-api-errors-alerts.md) | customer/ops DTO、SDK errors、80/90/100、notification state | native client + lifecycle |
| [`实现客户配额页面与平台运营面板`](issues/08-quota-settings-operations-ui.md) | workspace/billing/participant views、plan controls、operation tracking | API + operator intents |
| [`实现旧事件配额盘点、回填与分批切换 conductor`](issues/09-legacy-quota-migration-conductor.md) | approved assignment manifest、ledger rebuild、atomic cutover、cleanup eligibility | certified fork + control plane |
| [`完成双仓 E2E、部署切换与发布验收`](issues/10-cross-repo-e2e-release.md) | bypass/并发/生命周期/兼容/恢复测试、digest pin、rollout | 前述全部 + signed fork release |

## 跨仓依赖顺序

1. surreal_ck 的 `_system` schema 可与 SurrealDB grammar/catalog 开发并行。
2. compiler 使用 SurrealDB 仓库发布的 canonical contract fixtures，不能自行复制一套未校验 grammar。
3. NativeQuotaClient 与错误映射必须在 candidate fork 的 HTTP+WebSocket contract test 上完成。
4. legacy migration conductor 只能使用至少一个 production-certified 持久 backend 的 signed candidate digest。
5. surreal_ck production release 必须 pin SurrealDB stable digest、精确 surrealdb-js 版本和同一 compatibility manifest revision。

## 迁移发布阶段

1. **盘点**：冻结旧 manual plan 修改，生成覆盖每个 active workspace 的运营批准 assignment manifest；旧表只作线索，不作权威。
2. **引擎维护窗**：停止 WSS/写入，验证 datastore snapshot，可逆迁移 format marker，启动 fork；对 `_system` 与全部 workspace database 执行账本回填并独立核对。
3. **维护窗内安全启用**：以内网方式启动迁移协调版，安装 `_system` 控制面 schema、导入批准 assignment、生成 entitlement/projection，并为全部 active workspace 应用/读回 native policy；任一 workspace 缺策略都不重新开放 WSS。旧 events 暂时保留形成双重保护。
4. **逐 workspace 原子去旧**：fresh INFO/影响预览；在一个 database transaction 中以 generation guard 重新断言同一 native policy 并移除静态与动态 legacy quota events；INFO readback 和事件缺失验证后推进 `native_verified`。
5. **分 cohort 晋级**：synthetic/internal → max(1,1%) → 10% → 50% → remainder；每批满足观察窗与 abort gate 才继续。所有 cohort 从一开始都已有 native enforcement。
6. **产品切换**：全部 active workspace native_verified 后开放新配额/订阅 UI，停止旧 manual scripts。
7. **延迟清理**：稳定运行 30 日且无回滚需要后，执行 capability-aware cleanup migration，删除旧 quota tables、events、installer、常量和字符串错误。

## 完成定义

- `_system` 中 plan revision、billing、subscription、entitlement、projection 与 operation 权威模型完整、幂等、可审计；旧 workspace quota 表无法改变执行额度。
- Plus/Pro/Max、trial、manual/contract、override、grace、retention、升级、降级和取消都产生确定性 desired/applied 状态。
- Reconciler 可从进程崩溃、lease 过期、commit unknown、policy generation race、ledger rebuild 和 external drift 恢复，不静默放宽。
- 新 workspace 未物化原生 quota 前不能 active；旧/vanilla/不兼容 backend 不提供 scope 或业务连接。
- 工作区管理员、计费账户管理员、普通成员和平台运营获得严格裁剪的不同 DTO；同一人兼任时能力取并集。
- 浏览器直连 quota error 保留草稿并映射结构化领域结果；不解析英文 message。
- 80/90/100 容量预警去重，quota compliance、capacity、sync、service mode 四类状态不混淆。
- 运营面板可手工查看/控制计划与 override，但动作全经审计意图、operation 和 INFO readback。
- 所有 active workspace 有经批准的 entitlement、native policy、可信账本和一致 applied 指针；旧 counters 从未导入。
- database Owner 直接修改旧 plan、counter、event 或使用 SQL 控制台都不能突破原生 table/field/record limit。
- `docker-compose.yml` 与生产部署不再引用官方 `surrealdb/surrealdb:v3.2.3`；生产以签名 digest 和兼容 manifest 为权威。
- 双仓 E2E、恢复演练和 rollout abort/forward-fix runbook 通过。

## 必跑验证

- `pnpm run typecheck`
- `pnpm run lint`
- `pnpm test`
- 各 workspace 的定向 Bun/Vitest 测试
- 使用签名 candidate fork 的 HTTP/WebSocket/CLI 集成测试
- 双仓并发、故障注入、迁移 dry-run/restore drill 和端到端场景

具体脚本以实施时的 `package.json` 为准；禁止引入 npm/yarn lockfile。
