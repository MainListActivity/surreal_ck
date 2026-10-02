# LCA14 受控法律内容与 AI 灰度开关 Runbook

适用：`task/e71063b2` 起引入的 `_system` 灰度控制面（migration `028-legal-rollout-gates.surql`）。
本手册面向平台运营与 QA，不授权任何直接 DDL/DML、SSH 或服务重启；所有操作经
`/api/ops/rollout/*`（ops token + 运营能力）或 `ops_request` 运维代理完成。

## 开关目录与语义

| gate | 覆盖入口 | 关闭时的行为 |
| --- | --- | --- |
| `legal_content_access` | `POST /api/session/content-reader`、`POST /api/session/content-search`、`POST /api/legal/search`、AI 研究窗口 | 新内容会话/换票/检索被拒：`feature_suspended`（业务语义）/ HTTP 403 `legal-content-suspended` |
| `legal_research_ai` | `POST /api/chat` 新 run 与已暂停 run 续跑 | 新模型调用被拒：HTTP 403 `legal-research-ai-suspended` |

- 默认（无开关行）= enabled。开关是只收紧的运营覆盖层，不授予任何权益。
- 每请求实读 `_system.workspace_rollout_gate`，无缓存：关断即时生效，无失效缓存窗口。
- 开关读失败 fail closed：业务入口归一为 503，不放行。
- 两枚开关互相独立：关 `legal_research_ai` 不影响 `legal_content_access`，反之亦然；
  关闭只作用于目标 workspace，不影响其他 workspace，也不关闭产品中无关 AI 能力。
- 历史报告/引用按现有权限路径继续读取——开关只拦「新内容访问/新模型调用」。

## 能力要求

- 读（状态、批次、workspace 视图）：`quota.read`
- 写（开关切换、批次登记/流转）：`rollout.manage`

`PLATFORM_OPERATOR_CAPABILITIES` bootstrap 需显式包含 `rollout.manage`（见 `.env.example`）。

## 接口

```text
GET  /api/ops/rollout/gates                          开关目录与语义
GET  /api/ops/rollout/batches?limit=                 具名批次列表
GET  /api/ops/rollout/batches/:batchKey              批次详情（来源/费率/名单/缺项）
POST /api/ops/rollout/batches                        登记批次（幂等）
POST /api/ops/rollout/batches/:batchKey/status       draft→active / draft|active→closed
GET  /api/ops/rollout/workspaces/:slug               该 workspace 两枚开关状态+active 批次+近期操作
POST /api/ops/rollout/workspaces/:slug/gates         关闭/恢复单枚开关（幂等）
```

## 具名批次登记

一次受控发布登记一个批次，字段即验收事实清单：

```json
{
  "batchKey": "lca14-qa-001",
  "label": "LCA14 首批受控验收",
  "appRelease": "<git SHA 或 Deploy run id>",
  "idpRelease": "<ma_hono 发布版本>",
  "schemaRevision": "system-028 / 权益修订说明",
  "legalSources": [{ "sourceKey": "flk", "label": "法规库", "licenseNote": "商用许可/批准验收的依据" }],
  "planMapping": [{ "planKey": "pro", "displayName": "Pro", "aiRate": "每 run 预留口径", "trialAllowance": 50, "legacySubscriptionMap": "历史订阅→修订映射或“无”" }],
  "allowedWorkspaces": ["<company 专用验收 workspace slug>"],
  "gaps": ["未开放范围逐条列出"],
  "reason": "操作原因",
  "idempotencyKey": "<>=8 字符的幂等键>"
}
```

- 同 `batchKey` 重复提交同内容 → 幂等返回；内容不同 → 409（同名不覆盖）。
- `allowedWorkspaces` 是恢复的硬门槛：批次 active 后，名单内 workspace 才可被 restore。
- `gaps` 如实记录缺项；缺项不报等于虚报开放范围。

## 关闭与恢复

```json
POST /api/ops/rollout/workspaces/:slug/gates
{ "gate": "legal_content_access", "action": "disable",
  "reason": "QA 发现未授权内容进入候选", "batchKey": "lca14-qa-001",
  "idempotencyKey": "op-<n>" }
```

- `disable` 任意时刻可执行（关停永远安全），不依赖批次名单。
- `restore` 要求目标 workspace 至少在一个 **active** 批次 `allowedWorkspaces` 内；
  批次 `closed` 后名单立即失效。不满足 → 403 `rollout-scope_denied`。
- 每次切换写 `workspace_rollout_gate`（revision CAS）+ 不可变 `rollout_operation`
  审计事件（before/after state 与 revision、操作者、能力、原因、批次、幂等键、correlation id）。
- 恢复点 = 事件的 `before_revision`/`after_revision`；事件行本身不可改不可删（DEFINE EVENT THROW）。

## 回滚演练（验收要求）

1. 登记批次 → `active`，记录其 `allowedWorkspaces`。
2. 对名单内验收 workspace 执行 `disable`：确认 `GET workspaces/:slug` 两视图落 `disabled`、
   revision 递增，业务入口返回 `feature_suspended` / 403，其他 workspace 不受影响。
3. 执行 `restore`：确认恢复为 `enabled`、审计追加 `gate_restore`。
4. 批次 `closed` 后再 `restore` → 必须 403（名单失效），证明关闭后不可再扩口。
5. 生产回滚 = 保持开关 disabled + 通过批准的 CI 窗口回退应用版本；
   不回 root 查询、不恢复旧权限状态。

## 发布与重启窗口

- 生产 origin 重启/发版只走已批准 CI 部署（`production-release.md`），不允许 SSH 或重启 `surrealdb.service`。
- 开关本身是运行时状态，无需重启即生效；schema 028 随 origin 启动的 `ensureSystemSchema` 自动应用。
