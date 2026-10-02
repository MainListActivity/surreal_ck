# 能力灰度开关与回滚 runbook（LCA-14）

适用范围：含 `_system` 迁移 `027-capability-rollout-switch.surql` 的 origin
版本起。该迁移新增两张控制面表（`platform_capability_switch`、
`platform_rollout_batch`）并把 `capability.switch` 能力并入
`platform_operator_capability` 白名单。全部改动纯新增/放宽校验，不改写
既有数据；回滚不需要删表。

核心事实：

- **开关行在 `_system`，record id 即能力键**：
  `platform_capability_switch:content` / `platform_capability_switch:ai`。
  `mode` ∈ `on`（默认/全量）· `cohort`（仅 `workspaces` 内 workspace slug
  放行）· `off`（全部拒绝）。**行不存在按 `on` 处理**——未初始化的部署
  行为不变；这意味着灰度前必须先显式建行再收窄。
- **强制点在新会话签发入口**，三处：
  - `POST /api/chat` 新 run（早于 caller session 与额度预留，关闭期间
    **零计费**）；`POST /api/chat/runs/:runId/resume` 同样判定；
  - `POST /api/session/content-search`（检索会话换票）；
  - `POST /api/session/content-reader`（单篇正文换票）。
- **关闭对已下发会话不追溯撤销**：存量 content_reader token 到期即止
  （≤15min 短约），既有 run 在 RunBus 里跑完终态；已有成果（投影行、
  账本、历史记录）全部保留——满足「回滚维持权限收紧和已有用户成果」。
- **开关读失败 fail closed**：求值查询失败映射 503
  （`ai-capability-unavailable` / `content-reader-unavailable` /
  `content-search-unavailable`），不放行新会话。
- **写端仅 ops API + `capability.switch` 能力位**，读取需 `quota.read`；
  无控制台 UI，操作用 `ops_query`/`curl` 携带运营 token 直连端点。

## 端点

```text
GET  /api/ops/capability-switches            quota.read
GET  /api/ops/capability-switches/batches    quota.read（最近 100 条批次）
PUT  /api/ops/capability-switches/:key       capability.switch
     body: { "mode": "on|cohort|off", "workspaces": ["slug"...], "note": "" }
POST /api/ops/capability-switches/batches    capability.switch
     body: { "capability": "content|ai", "workspaces": ["slug"...],
             "note": "", "idempotencyKey": ">=8 chars" }
```

错误码：未知能力键 `404 capability-switch-unknown`；非法请求体
`400 capability-switch-invalid` / `capability-batch-invalid`；缺能力位
`403`；无 token `401`。

## 灰度开启顺序（受控 cohort）

1. **选定批次**：挑 1-3 个真实 workspace slug 作为第一波（建议先内部
   验收工作区）。用 `GET /api/ops/quota/search?query=` 确认 slug 拼写。
2. **先建档再收窄**（顺序不可颠倒，否则行缺失期间等于全量开放）：
   ```bash
   # a) 建开关行并直接置 cohort（含白名单）——单 UPSERT 原子完成
   curl -X PUT $ORIGIN/api/ops/capability-switches/content \
     -H "authorization: Bearer $OPS_TOKEN" -H "content-type: application/json" \
     -d '{"mode":"cohort","workspaces":["ws-alpha"],"note":"LCA-14 批次一"}'
   curl -X PUT $ORIGIN/api/ops/capability-switches/ai \
     -H "authorization: Bearer $OPS_TOKEN" -H "content-type: application/json" \
     -d '{"mode":"cohort","workspaces":["ws-alpha"],"note":"LCA-14 批次一"}'
   # b) 追加批次记录（幂等键去重，审计留档）
   curl -X POST $ORIGIN/api/ops/capability-switches/batches \
     -H "authorization: Bearer $OPS_TOKEN" -H "content-type: application/json" \
     -d '{"capability":"content","workspaces":["ws-alpha"],"note":"批次一","idempotencyKey":"lca14-wave1-content"}'
   curl -X POST $ORIGIN/api/ops/capability-switches/batches \
     -H "authorization: Bearer $OPS_TOKEN" -H "content-type: application/json" \
     -d '{"capability":"ai","workspaces":["ws-alpha"],"note":"批次一","idempotencyKey":"lca14-wave1-ai"}'
   ```
3. **放行验证**（批次内 workspace）：浏览器/会话执行一次检索换票与一次
   AI 问答 → 均应正常（检索 200，AI 受理返回 runId）。
4. **负例验证**（批次外 workspace）：同请求应分别返回
   `503 capability_disabled`（两内容端点）与 `503 ai-capability-disabled`
   （chat 端点）。**AI 负例还要确认额度账本无新增 reserve 行**——开关
   判定在计量之前。
5. **扩批**：PUT 更新 `workspaces` 列表 + POST 新批次行（新
   idempotencyKey）。批次行是追加式审计，不覆盖。
6. **全量**：两键 PUT `{"mode":"on"}`，再追加一条 `note` 说明全量放开
   的批次行（workspaces 留空亦可，记录的是动作）。

## 回滚（关闭某项能力）

```bash
curl -X PUT $ORIGIN/api/ops/capability-switches/ai \
  -H "authorization: Bearer $OPS_TOKEN" -H "content-type: application/json" \
  -d '{"mode":"off","workspaces":[],"note":"回滚：AI 报错率异常，批次二后关闭"}'
```

- 即刻生效：下一次新 run / 新换票被拒，存量会话自然到期。
- 随后 POST 一条批次行记录收窄动作（`note` 写明原因、关联缺陷号）。
- **回滚不删除批次行、不改写开关历史之外的任何数据**；
  `_system` 的开关行与批次表在所有版本上都是休眠表——代码回滚到
  不含本功能的版本时，残留行无副作用（读端代码不存在，权限仍由
  schema 保持 NONE = 仅 root 可读）。

## 回滚演练（QA 可复测脚本）

前置：运营 token（`capability.switch` 能力）、批次内 workspace A、
批次外 workspace B 的测试账号各一。

1. `PUT ai→off`，A、B 两个账号各发 `POST /api/chat`：
   均 `503 ai-capability-disabled`；A 的 `ai_ledger_entry` 无新行。
2. `PUT content→off`：A、B 各调 `POST /api/session/content-search` 与
   `POST /api/session/content-reader`：均 `503`（error
   `capability_disabled`）。
3. A 账号在关闭前已开着的检索会话仍可读（不追溯撤销），token 到期后
   续期被拒。
4. `PUT ai→cohort {workspaces:[A]}`：A 恢复 200/受理，B 仍 503。
5. `PUT ai→on`：B 恢复。`GET …/batches` 应见每步对应的批次行。
6. 开关行删除/读失败的模拟（可选，仅在预发）：删行 = on 语义；
   `_system` 不可达时入口 fail closed 503。

## 恢复与重新开放条件

- 缺陷修复合入并通过 Quality gate → 部署后按「灰度开启顺序」从当前
  最小批次重新放行，每一波对应一条新批次行；不得直接把开关拨回 `on`
  而不留批次记录。
- 恢复验证同第 3-4 步：批次内正例 + 批次外负例同时核。

## 已知限制

- cohort 匹配按 **workspace slug**（`workspace.slug`）；slug 改名后须
  同步更新白名单。
- AI 开关判定只在 run 建立与 resume 时；进行中的 run 不中断（符合
  不删既有成果语义）。如需立即止血，另按 production-release runbook
  的应急通道处理。
- 开关不是配额/权限替代品：它控制「新会话是否签发」，行级权限仍由
  SurrealDB schema PERMISSIONS 兜底；任何情况下不回退到 root 查询。
