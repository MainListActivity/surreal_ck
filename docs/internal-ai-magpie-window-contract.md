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
`internal-ai-evidence-unavailable`（全部 fail-closed，不发送 provider 请求）。

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
- 该包络内：`剩余次数 = 20 − 已用(含 failed/uncertain/timeout/cancelled) − 已承诺(active 窗口未用次数)`；
  `已用` 来自带 envelope 归属的 attempt 行，`已承诺` 来自该包络的 active 窗口。旧 `internal_ai_target` /
  活动 / 旧周期计数**不参与**新包络计算，也不因新包络调用而增加或清零。
- USD：窗口创建按 `sourceBudgetNanoUsd` 记入包络 `allocated_nano_usd`；每次预留增加 `reserved`，结算把预留转为
  `spent`（失败/不确定仍计已用并保留预留，绝不把未知成本当 0）。窗口创建、预留与结算都必须满足
  `allocated_nano_usd + spent + reserved ≤ 700000000`，且单次 `≤ 35000000`。
- 期限：包络到期或窗口证据期超过包络期限都拒绝创建；预留时再次复核。
- 只读核对：`GET /api/ops/internal-ai/envelopes/current` 返回 `usedAttempts`、`committedAttempts`、
  `remainingAttempts`、`committedNanoUsd`（窗口已承诺额度）、`spentNanoUsd`、`reservedNanoUsd`、
  `remainingNanoUsd` 与 `expired`，供 qa 在调用前核对。
- 新错误码（422）：`magpie-window-envelope-expired`、`magpie-window-envelope-cap-exceeded`、
  `magpie-window-envelope-invalid`。

## 8. 迁移与环境

- 数据库迁移：**只新增结构**（`shared/sql/system/039-internal-ai-window.surql`：
  新表 `internal_ai_window`、活动 `window_id`/`window_revision`、attempt 新字段；
  `shared/sql/system/041-internal-ai-sampling-envelope.surql`：新表 `internal_ai_envelope`、
  window/attempt 的 `envelope` 归属字段）。不回填、不改写、不删除既有生产数据。
- 新环境变量：无。新主机准备：无。
- 新窗口的正式创建/绑定与容量/源候选启用属于后续受控任务；本契约落地不启用任何调用。
