Status: done
Label: done
Assignee: codex

# SCK-NQ-08 — 实现客户配额页面与平台运营面板

## Parent

[`surreal_ck 订阅配额控制面实施规格`](../PRD.md)

## What to build

- workspace settings 增加当前 applied plan、待应用变更、table/field/record 用量、capacity/compliance/sync/service mode 与刷新时间。
- billing admin 视图显示账户分配、subscription/grace/cancel 与聚合利用率；普通成员只展示当前失败的裁剪说明。
- `/api/ops` 独立运营入口支持 workspace/account 搜索、四指针、usage/drift/ledger、operation/attempt/audit 时间线。
- 支持 manual/contract、override、排期降额、retry/audit/reapply/adopt/rebuild 等审计意图和 operation tracking。
- 所有高影响动作显示 current/target diff、fresh usage、预计 overage、effective_at、原因与二次确认。

## Acceptance criteria

- [x] 同一用户多能力页面按 capabilities 组合，不靠角色名硬编码。
- [x] stale/unknown 明示，不把缓存用于乐观允许写入。
- [x] 运营浏览器从不获得 root token、完整 native DDL、业务记录或内部 provider payload。
- [x] 手工计划控制不能直接修改 current/applied/usage。
- [x] quota error 后 draft 保留，用户能理解删除/升级/联系管理员等恢复路径。

## Dependencies

- Blocked by: [`实现 subscription lifecycle、service mode 与运营意图`](06-subscription-lifecycle-operator-intents.md)、[`实现角色化 quota API、错误映射、缓存与预警`](07-quota-api-errors-alerts.md)
- Blocks: [`完成双仓 E2E、部署切换与发布验收`](10-cross-repo-e2e-release.md)

## Comments

**2026-07-29（Codex，完成）**

- workspace 设置页新增角色化原生配额摘要：管理员/运营可查看 applied/desired、table/field/record（固定表与正则 selector）用量、capacity/compliance/sync/service mode、ledger、freshness；billing admin 只看账户计划、订阅生命周期与聚合利用率；participant 不获得全表/跨表信息。
- 新增计费账户独立页、侧栏配额通知菜单和结构化 quota failure 恢复文案。直连写入命中 native quota 时保留现有草稿，不解析英文 message，并按 participant/admin 视角裁剪详情。
- 新增 `/ops` 与 `/api/ops/quota/**`：平台运营能力由细粒度 capability 并集驱动，支持 workspace/account/subject 搜索、商业与执行四指针、usage/drift/ledger、operation/attempt/audit 时间线。返回 DTO 是明确 allowlist，不包含 root、native DDL、业务记录、provider payload 或内部 error details。
- manual/contract plan、subscription end、override/排期、retry/audit、pause/resume、drift reapply/adopt、ledger rebuild 全部先做服务端 fresh INFO preflight，再持久化审计意图；高影响动作显示 current/target、fresh usage、预计 overage、effective_at、双原因和二次确认。浏览器不能写 current/applied/usage，HTTP 202 仅表示意图已持久化。
- 正则展开资源会还原为语义 rule key（例如 `record/ent`），避免把 `record/ent:ent_claim` 错写进 override；新 selector 无法从当前策略可靠映射时显示 unknown 而非 0。手工计划只开放 commercial/contract revision。
- ledger rebuild 已接入 durable worker：lease/fencing 校验后由 root 侧执行 `REBUILD QUOTA IF NEEDED`，随后 fresh INFO readback 并写入统一 observation/alert 管道，不再落库后必然终止失败。
- 验证：`pnpm run typecheck`、`pnpm test`（shared 98 / server 322 / web 485 pass）、`pnpm --filter @surreal-ck/web run build`、真实 SurrealDB `_system` schema 50 assertions、subscription lifecycle + ops context/search/timeline 54 assertions、`git diff --check` 均通过。仓库没有 `lint` script；浏览器验证确认 `/ops/quota` 受 OIDC 门保护，当前浏览器无登录会话，未引入测试认证后门。
