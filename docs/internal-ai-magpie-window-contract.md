# FV06 Magpie 受控新窗口接口契约（magpie-window/v1）

本契约是产品仓 `surreal_ck` 与公司证据链（`0ec530ce -> 571b1bb2 -> ffdae0f3`）共享的
**版本化线上形状**。共享 zod 定义在 `shared/src/internal-ai-window.ts`，导出常量
`MAGPIE_WINDOW_CONTRACT_VERSION = "magpie-window/v1"`。

产品只负责「受控接收 + 冻结 + 逐请求计量」。本契约**不签发批准**、不证明供应商免费或订阅、
不创建容量、不购买/充值/提额/追加产品 AI grant，也不把供应商积分换算成次数或美元。

## 1. 端点与权限

全部走现行 operator 会话（`ops_operator_login`），要求 `subscription.manage`；
经 `ops_request` 代理调用，不手动 DML。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/ops/internal-ai/windows` | 创建新授权窗口（幂等） |
| GET | `/api/ops/internal-ai/windows/:id` | 只读窗口投影 |
| GET | `/api/ops/internal-ai/envelopes/current` | B 档包络只读用量（已用/已承诺/剩余/USD） |
| POST | `/api/ops/internal-ai/windows/:id/bind` | 绑定到活动（`window_revision` CAS，幂等） |

活动读面 `GET /api/ops/internal-ai/activities/:id` 追加 `window`、`activityRevision`
与逐 attempt 新字段。窗口投影的 `window.id` 是**裸 UUID**（不含
`internal_ai_window:` 或 `⟨⟩`），create 响应可直接用于 GET/bind。

## 2. 创建请求

```json
{
  "activity": "lca-v2-deploy-qa01",
  "approvalDigest": "<64 hex sha256>",
  "approvalTask": "<新独立批准任务 id>",
  "accountRef": "<批准的供应商账户标识>",
  "evidenceExpiresAt": "2026-10-29T00:00:00Z",
  "sourceBudgetAttempts": 1,
  "sourceBudgetNanoUsd": 100000000,
  "perAttemptNanoUsd": 10000000,
  "route": {
    "revision": "magpie-route-<revision>",
    "digest": "<64 hex>",
    "requestedModel": "group/work",
    "servedModel": "sn-sensenova-6-8-flash",
    "endpoint": "http://127.0.0.1:<port>/v1",
    "accountBinding": "<与 accountRef 一致>",
    "priceRevision": "magpie-free-<revision>",
    "priceBasis": "free-evidence",
    "freeEvidenceHash": "<64 hex>",
    "maxOutputTokens": 8192,
    "sampledAt": "2026-10-28T00:00:00Z",
    "expiresAt": "2026-10-29T00:00:00Z"
  },
  "capacity": {
    "database": "ws_ddad14a98469",
    "entityTables": 4,
    "fieldsPerTable": 12,
    "recordsPerTable": 12,
    "ttlSeconds": 3600,
    "destructive": false,
    "source": "9e44a95d"
  },
  "idempotencyKey": "<ops 重试稳定键>",
  "reason": "<受控操作原因>"
}
```

严格 schema：未知字段（例如 `purchase`、`recharge`、`grant`、`points`）直接 400。

## 3. 硬性不变量

1. **次数不重领**：
   `remaining = 30 − max(全部历史 attempt 行数, target.attempts + 单例 measurement cycle.attempts) − Σ(未过期 active 窗口未用次数 attempt_limit − attempts)`。
   `sourceBudgetAttempts > remaining` 一律拒绝；failed / uncertain 历史行同样计入。
2. **USD 上限继承**：`sourceBudgetNanoUsd ≤ 活动 total_limit`，`perAttemptNanoUsd ≤ 活动 per_attempt_limit`；
   窗口只增加次数与路由/价格依据，不放宽活动预算包络。
3. **证据期**：`evidenceExpiresAt` 必须晚于当前时间；绑定与每次预留都会复核。
4. **旧证据拒绝**：`approvalDigest` / `approvalTask` / `accountRef` 命中
   `a7537d2c`、`f3974e8f`、`4fff2947` 前缀即拒绝；同一活动同一批准摘要只能建一个窗口；
   不复活旧 proof、不延长期。
5. **账号与路由自洽**：`accountRef == route.accountBinding`；真实端点（scheme/host/port/path）
   必须由受控来源给出。运行时与冻结端点或 `requestedModel` 任一不符即 `internal-ai-route-drift`。
6. **容量**：只记录 9e44a95d 已批 scope——库 `ws_ddad14a98469`、表 3..5、每表字段 ≤23、
   每表记录 ≤24、TTL ≤24h、`destructive=false`、非空来源。产品**不创建**任何表/字段/记录。
7. **幂等与并发**：同一 `idempotencyKey` + 同一载荷返回既有窗口；同键不同载荷 409；
   同批准摘要 409。创建/绑定事务先写活动 `window_revision` 形成串行化锁，并复核
   active 窗口承诺次数，防并发超支。**重试必须原样重放同一请求体**（含 `sampledAt`/
   `expiresAt` 等时间字段）；任何字段变化都视为新载荷。
8. **窗口生命周期**：同一活动同时只绑定一个未过期且未耗尽的 active 窗口。旧窗口
   证据期到期或次数耗尽后，绑定新的独立批准窗口会把旧窗口状态改为 `expired`/
   `exhausted`（只改状态，历史 attempt/路由/预算字段不改写），旧窗口未用次数不再
   占用 30 次全局剩余；不会把旧窗口的已用次数返还为新预算。

## 4. 价格依据与成本状态

| `priceBasis` | 预留金额 | 完成时 `cost` | `cost_status` |
| --- | --- | --- | --- |
| `free-evidence` | 0 | 仅当 servedModel 匹配且 usage 合法时为 0 | `free-evidence` |
| `per-token` | 已核证书 `worstCost` | `actualCost` 核定值；不可核定则 null | `assessed` / `invalid-usage` |
| `subscription-amortized` | `perAttemptNanoUsd` | 恒 null；独立披露 `amortized`/`marginal` | `unassessed` |
| `unknown` | 拒绝发起 | — | `internal-ai-price-unassessed` |

`servedModel` 缺失/漂移 → `cost=null`、`cost_status=route-drift`、`route_drift=true`、state `uncertain`；
缺 usage → `usage-missing`；非法 usage（cache>input、reasoning>output 等）→ `invalid-usage`。
**null 永远不等于 0**；旧 SenseNova 零费率证书语义不变。

## 5. 逐请求记录字段

`internal_ai_attempt` 新增（只增不改历史）：

- `window`、`requested_model`、`served_model`
- `route_revision`、`route_digest`、`account_binding`
- `usage_raw`（SDK 解析后的 provider usage 忠实投影；绝不落 HTTP 正文/请求/响应）
- `request_id`、`run_hash`、`attempt id`/`sequence`、`retry_index`（当前恒 0）、
  `failure_class`、`state`
- `price_revision`、`price_basis`、`cost_status`
- `amortized_cost_nano_usd`、`marginal_cost_nano_usd`、`route_drift`

## 6. 错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `magpie-window-body-invalid` | 请求体不合法或含未知字段 |
| 404 | `magpie-window-activity-unknown` / `magpie-window-unknown` | 活动/窗口不存在 |
| 409 | `magpie-window-idempotency-conflict` | 同幂等键不同载荷 |
| 409 | `magpie-window-approval-consumed` | 批准摘要已用过 |
| 409 | `magpie-window-already-bound` | 活动已绑定另一个 active 窗口 |
| 409 | `magpie-window-revision-conflict` | 绑定 CAS 失配 |
| 422 | `magpie-window-legacy-rejected` | 命中旧周期/旧批准/旧 proof |
| 422 | `magpie-window-evidence-expired` | 证据期已过 |
| 422 | `magpie-window-remaining-insufficient` | 剩余次数不足（含并发落败方） |
| 422 | `magpie-window-cap-inheritance` | USD 上限超出既有活动 |
| 422 | `magpie-window-envelope-expired` | B 档包络已过期或证据期超出包络期限 |
| 422 | `magpie-window-envelope-cap-exceeded` | 超出 B 档次数/USD 总额/单次上限 |
| 422 | `magpie-window-envelope-invalid` | 包络账本行不存在或与批准摘要不一致 |
| 422 | `magpie-window-capacity-out-of-scope` | 容量声明超出 9e44a95d |
| 422 | `magpie-window-account-mismatch` | 批准账号与路由账号绑定不一致 |
| 422 | `magpie-window-price-basis-invalid` | 价格依据/披露自相矛盾 |
| 422 | `magpie-window-price-revision-unavailable` | 价目修订无已核证书 |
| 422 | `magpie-window-route-invalid` / `magpie-window-route-expired` | 端点/路由证据不合法或过期 |
| 503 | `magpie-window-store-unavailable` | 存储不可用（原始拒绝保留在服务日志） |

预留/完成侧错误：`internal-ai-route-drift`、`internal-ai-price-unassessed`、
`internal-ai-price-or-bound-unavailable`、`internal-ai-budget-exhausted`、
`internal-ai-evidence-unavailable`（全部 fail-closed，不发送 provider 请求）。免费窗口（v3，见第 9 节）
门禁停止时，请求侧抛出 `internal-ai-free-quota-stopped`：该窗口已进入 `stopped` 终态，本次不发送，不重试，不切路由。
v3 的依据与门禁错误码统一列在第 9 节。

## 7. 第二阶段 B 档独立采样包络

老板 `b796de49` 批准、`4e2ac8dd` 再次确认的 B 档包络是**新的独立额度**，不复活旧 30 次周期：

| 字段 | 值 |
| --- | --- |
| 包络标识 | `fv06-b-2026-11-05`（不含旧前缀） |
| goal | `e159e40ad4e50080` |
| 最大调用次数 | 20 |
| USD 总额 | 700000000 nanoUSD（0.70 USD） |
| 单次上限 | 35000000 nanoUSD（0.035 USD） |
| 期限 | 2026-11-05T12:10:07Z |
| 批准引用 | `b796de49`、`4e2ac8dd` |

- 创建窗口时传 `"envelope": "fv06-b-2026-11-05"`；未传则完全沿用上一节的旧 30 次全局路径。
- 账本行是 `internal_ai_envelope:fv06-b-2026-11-05`（固定 ID，受控字段只读），首次使用时按上述常量建立；字段与常量不一致时拒绝。
- 该包络内（实时口径，不写入累计列）：`剩余次数 = 20 − 已用 − 已承诺`。`已用` 为带 envelope 归属的 attempt 行数
  （含 failed/uncertain/timeout/cancelled），`已承诺` 为该包络内未过证据期的 active 窗口的未用次数之和
  （`attempt_limit − attempts`）。旧 `internal_ai_target` / 活动 / 旧周期计数**不参与**新包络计算，也不因新包络调用而增加或清零。
- USD：`已承诺 USD = Σ(sourceBudgetNanoUsd − spent − reserved)`，仅统计未过证据期的 active 窗口。每次预留增加
  `reserved`，结算把预留转为 `spent`（失败/不确定仍计已用并保留预留，绝不把未知成本当 0）。窗口创建要求
  `已承诺 USD + 包络 spent + 包络 reserved + sourceBudgetNanoUsd ≤ 700000000`；预留要求
  `包络 spent + 包络 reserved + 本次金额 ≤ 700000000`；窗口与单次金额均 `≤ 35000000`。
- 期限：包络到期或窗口证据期超过包络期限都拒绝创建；预留时再次复核。
- 只读核对：`GET /api/ops/internal-ai/envelopes/current` 返回 `usedAttempts`、`committedAttempts`、
  `remainingAttempts`、`committedNanoUsd`（未过证据期 active 窗口的未用额度之和，实时计算）、`spentNanoUsd`、`reservedNanoUsd`、
  `remainingNanoUsd` 与 `expired`，供 qa 在调用前核对。
- 新错误码（422）：`magpie-window-envelope-expired`、`magpie-window-envelope-cap-exceeded`、
  `magpie-window-envelope-invalid`。

## 8. 迁移与环境

- 数据库迁移：**只新增结构**（`shared/sql/system/039-internal-ai-window.surql`：
  新表 `internal_ai_window`、活动 `window_id`/`window_revision`、attempt 新字段；
  `shared/sql/system/042-internal-ai-sampling-envelope.surql`：新表 `internal_ai_envelope`、
  window/attempt 的 `envelope` 归属字段；
  `shared/sql/system/043-internal-ai-window-remote.surql`：window 的三个 route 字段放宽为
  `option<string>`（既有行保持原值）并新增 magpie-window/v2 的 contract/observation/gaps/
  expiry/pricing 分层字段）。不回填、不改写、不删除既有生产数据。
- 新环境变量：无。新主机准备：无。
- 新窗口的正式创建/绑定与容量/源候选启用属于后续受控任务；本契约落地不启用任何调用。
- 远端窗口契约 v2（`magpie-window/v2`，兼容 `remote-magpie-evidence/1` 的 null+gap）：
  `POST /api/ops/internal-ai/remote-windows`；route.revision/digest/expiresAt 可为 null，
  与 `gaps` 声明一一对应；requestedModel/endpoint/provider 由受控运行配置交叉核对后冻结；
  观测层（capturedAt/快照摘要/routingConfigurationVerified=false）与本地新鲜度层
  （证据期 = 采集 + 7200s）绝不写入远端 route 字段；价格独立硬门禁——reviewed=false
  的目录 0/0 一律 unknown（请求门禁闭锁），永不自动等于 free-evidence。
- 迁移 044（免费额度窗口 v3）：`shared/sql/system/044-internal-ai-free-quota-basis.surql`，只新增结构。
  `internal_ai_window.status` 的允许取值扩展为 `stopped`（`DEFINE FIELD OVERWRITE`，既有行取值不变）；新增
  `stop_reason`、`stopped_at`（既有行保持 NONE）；新增不可变表 `internal_ai_free_basis`。不回填、不改写既有行。

## 9. 免费额度窗口契约 v3（magpie-window/v3）

老板决定引用任务 `45b3ec63`（owner_approve，`owner:local-session`，2026-10-30T21:55:52Z）：固定路由按**零新增现金支出**处理。
这不是对未知现金风险的例外，也不是永久免费。它只适用于下表的固定路由与 B 档包络，到期即失效。

| 字段 | 值 |
| --- | --- |
| 适用路由 | host `data.maplayer.top`，path `/ofm/v1`，servedModel `sn-sensenova-6-8-flash`（仅 https，无端口、凭据、查询或片段） |
| 包络 | `fv06-b-2026-11-05`（见第 7 节） |
| 生效时刻 | 不早于老板决定时刻 2026-10-30T21:55:52Z |
| 到期时刻 | 不晚于 B 档包络期限 2026-11-05T12:10:07Z；窗口证据期不得超过依据到期时刻 |

**依据记录（内容寻址、不可变）**

- 依据内容为规范化 JSON（键排序、无空白），字段为 `version`（`free-quota-basis/1`）、`decision`、`route`、`envelope`、`effectiveAt`、`expiresAt`。内容不含供应商价目、金额或秘密。
- hash = SHA-256(规范化内容)，同时即记录 id。读回时服务端以 content 复算 hash，不一致返回 `magpie-window-free-basis-invalid`。`content` 为 READONLY，同内容重放返回既有记录（200），不同内容无法覆盖。
- 依据不写入 TARIFFS，不伪造供应商价目。目录 0/0 不能替代依据；目录 0/0 且 `reviewed=false` 仍按 unknown 闭锁。

**端点（运营鉴权）**

- `POST /api/ops/internal-ai/free-quota-bases`：请求体 `{basis, reason}`，新建返回 201，同内容重放返回 200，响应含 `hash`。客户端不得自填 hash（strict 拒绝）。
- `GET /api/ops/internal-ai/free-quota-bases/:hash`：hash 须为 64 位小写十六进制；复算通过才返回依据内容。
- `POST /api/ops/internal-ai/free-quota-remote-windows`：请求体为 v2 远端证据加 `envelope: "fv06-b-2026-11-05"` 与 `freeQuotaBasisHash`，新建 201、重放 200。窗口视图的 `contract` 为 `magpie-window/v3`，并含 `freeQuota.basisHash` 与 `stop`（`{reason, stoppedAt}`，未停止时为 null）。

**创建门禁**

依据必须存在且可复算；必须已生效且未到期；窗口证据期不得越过依据到期时刻；路由 host、path、servedModel 与依据一致；目录必须同时标注免费且原始单价为零，否则 `magpie-window-free-basis-conflict`。窗口价格由依据派生为 `free-evidence`，`priceRevision` 为 `free-quota-basis/1:<hash>`；目录 0/0 与 reviewed 状态都不参与价格派生。B 包络内的免费窗口必须是 v3，否则 `magpie-window-free-basis-required`。

**请求前复核（begin）**

每次请求前复核依据：依据缺失、不可复算或未生效，停止原因 `free-basis-invalid`；已到期，`free-basis-expired`；路由不符，`route-drift`；served model 不符，`served-model-drift`。命中即窗口进入 `stopped`，本次不发送，抛出 `internal-ai-free-quota-stopped`。

**请求后（finish）**

只有 served model 一致且 usage 合法（核定为 `free-evidence`）才继续。其余情况：served model 漂移，`served-model-drift`；缺 usage，`usage-missing`；非法 usage，`usage-invalid`；未知核定状态按 fail-closed 处理，`provider-uncertain`。provider 失败按远端错误形状分类：HTTP 402 归为 `billing-required`；错误文本含额度用尽关键字的归为 `quota-exhausted`；含计费关键字的归为 `billing-required`；其余为 `provider-uncertain`。任何失败都计入已用次数，不自动重试，不切付费路由，不充值，不新增订阅。

**停止语义**

停止与该次结算在同一事务内完成，同一包络内其它活动窗口同事务进入 `stopped`。此后 B 包络拒绝新的 B 窗口（`magpie-window-free-quota-stopped`，409），也不允许任何窗口绑定到活动。B 档免费口径整体关闭；恢复路径未定义，列为待决事项，须由运营另行受控处理。

**计量与兼容**

- 免费口径仍按次数计数（包络上限 20 次），USD 预留按第 7 节规则，免费证据结算为 0。
- v1、v2 行及其创建路径语义不变。v1 `POST /windows` 的 free-evidence 遗留路径保持原样，但 B 包络内禁止使用非 v3 的免费窗口。
- 新增错误码汇总：404 `magpie-window-free-basis-unknown`；400 `magpie-window-free-basis-hash-invalid`；409 `magpie-window-free-quota-stopped`；422 `magpie-window-free-basis-invalid`、`magpie-window-free-basis-not-effective`、`magpie-window-free-basis-expired`、`magpie-window-free-basis-route-mismatch`、`magpie-window-free-basis-conflict`、`magpie-window-free-basis-required`。
