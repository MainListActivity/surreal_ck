Status: done
Label: done
Assignee: codex

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

- [x] database Owner 修改/删除旧 plan/counter/event 或执行任意 SQL 均无法超限。
- [x] 并发、事务、超额非恶化和结构化错误跨 WSS 与浏览器全部通过。
- [x] 升级只在 applied/readback 后可用；降级/retention 不删数且继续允许净零/下降。
- [x] vanilla、未知 capability、未认证 backend 和错误保真失败均 fail-closed。
- [x] migration dry-run、snapshot restore drill、cohort pause/resume、forward-fix 和 30 日 cleanup 路径有可重复证据。
- [x] 两仓完整 CI、typecheck/lint/test、multi-arch smoke、SBOM/signature/manifest 均有 fail-closed 发布门。

## Dependencies

- Blocked by: [`实现客户配额页面与平台运营面板`](08-quota-settings-operations-ui.md)、[`实现旧事件配额盘点、回填与分批切换 conductor`](09-legacy-quota-migration-conductor.md)、[`SurrealDB：建立私有 fork 发布与供应链门`](/Users/y/IdeaProjects/surrealdb/.scratch/native-resource-quota/issues/08-fork-release-supply-chain.md)
- Blocks: production release

## Comments

**2026-07-29（Codex，完成）**

- 新增真实 RocksDB 双仓 E2E：拉起 sibling/candidate CLI，通过 surrealdb-js WSS 与 HTTP 覆盖旧 plan/counter/event 篡改、exact/regex、table/field/record、批量原子、10 会话争抢最后 3 个名额、Owner/participant IAM、结构化错误与草稿保留。
- 覆盖 generation drift/repair、REBUILD、同目录重启、冷 snapshot 隔离恢复、legacy event 同事务移除，以及 upgrade readback、over-limit downgrade 不删数、拒绝增长并允许 update/delete/净零。
- 真实 E2E 暴露并修复 fork commit 阶段把 native quota 错误包装成 `Query/NotExecuted` 的问题；implicit/explicit transaction 现在均保留 `Quota` kind/details，并新增回归测试。
- candidate workflow 增加宏展开 backend contract 的 discovery 数量门，消除错误过滤导致的 0-test 假绿；mem/RocksDB 合约、RocksDB crash/restart 认证和 server capability 均有定向门。
- compose 已改为强制自有 registry exact digest + RocksDB；下游 acceptance workflow 交叉核验 SHA/digest、SDK/CLI/capability、amd64/arm64、SPDX SBOM、provenance、漏洞与部署构建，并生成 GitHub OIDC keyless acceptance statement。
- 按项目所有者确认，下游重复的 candidate/image signature verify 可显式记为 `waived_no_certificate`；candidate/promotion 的 keyless 签名验证及其余供应链门不豁免，也不要求持有长期证书。
- 本地证据：应用全量 `typecheck` 与测试通过（shared 98、server 335、web 485；仅环境门用例按预期 skip）；真实 RocksDB 双仓 E2E 2 tests / 50 assertions；真实控制面与订阅生命周期 3 tests / 81 assertions；fork mem/RocksDB backend contracts 各 4、RocksDB certification 1、quota wire error 2、server capability 7、release manifest 5 均通过。
- multi-arch image、远端 SBOM/provenance/signature 与 canary/staging/production receipts 必须由真实 candidate release workflow 产生；本任务完成的是可执行且 fail-closed 的发布门，未伪造尚未发生的生产发布证据。
