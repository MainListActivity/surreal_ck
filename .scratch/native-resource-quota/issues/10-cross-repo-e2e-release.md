Status: open
Label: ready-for-agent
Assignee: unassigned

# SCK-NQ-10 — 完成双仓 E2E、部署切换与发布验收

## Parent

[`surreal_ck 订阅配额控制面实施规格`](../PRD.md)

## What to build

- 建立由 surreal_ck 拉起签名 candidate fork digest 的双仓测试环境，固定 SDK/CLI/capability manifest。
- 覆盖 bypass、exact/regex、table/field/record、并发最后名额、批量原子、Owner/participant/IAM、upgrade/downgrade/grace/retention/override。
- 覆盖 drift、commit unknown、rebuild、engine/app 重启、vanilla/旧 fork 拒绝、snapshot restore 与 cleanup migration。
- 更新 Docker/compose/部署清单为自有 registry digest，发布 migration-conductor、product cutover、cleanup 三阶段 runbook。
- 记录 cohort metrics、abort gate、恢复演练与最终签字。

## Acceptance criteria

- [ ] database Owner 修改/删除旧 plan/counter/event 或执行任意 SQL 均无法超限。
- [ ] 并发、事务、超额非恶化和结构化错误跨 WSS 与浏览器全部通过。
- [ ] 升级只在 applied/readback 后可用；降级/retention 不删数且继续允许净零/下降。
- [ ] vanilla、未知 capability、未认证 backend 和错误保真失败均 fail-closed。
- [ ] migration dry-run、snapshot restore drill、cohort pause/resume、forward-fix 和 30 日 cleanup 路径有可重复证据。
- [ ] 两仓完整 CI、typecheck/lint/test、multi-arch smoke、SBOM/signature/manifest 全绿。

## Dependencies

- Blocked by: [`实现客户配额页面与平台运营面板`](08-quota-settings-operations-ui.md)、[`实现旧事件配额盘点、回填与分批切换 conductor`](09-legacy-quota-migration-conductor.md)、[`SurrealDB：建立私有 fork 发布与供应链门`](/Users/y/IdeaProjects/surrealdb/.scratch/native-resource-quota/issues/08-fork-release-supply-chain.md)
- Blocks: production release
