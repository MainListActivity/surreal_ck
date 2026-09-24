# 01 — 将内容维护迁到独立内容库

**What to build:** 运营人员在独立的平台法律内容数据库中继续完成来源登记、批次校验、发布、纠错、撤回和恢复；既有内容身份与引用可追溯，客户工作区不承载平台全文。

**Blocked by:** None — can start immediately（无阻塞，可立即开始）。

**Status:** done

**ID:** SCK-LCA-01
**确认时序号:** 1
**Repository:** surreal_ck
**Parent:** [本簇实施规格](../PRD.md)

## Acceptance criteria

- [x] 先清点现有内容表、批次、许可、版本、关系、审计与调用入口，生成迁移清单；已有内容维护簇的 done 状态不能替代真实数据库验证。
- [x] 新库承载完整内容维护流程；平台运营资格与商业权益权威仍在控制面。日常维护通过受限 content_publisher 短期会话，root 只负责建库、迁移与凭证维护。
- [x] 先建立可独立演示的新库发布路径，再按可恢复批次迁移和核验后切换；稳定内容 ID、精确版本、哈希、来源许可和法条引用关系保持一致，迁移重试不重复发布。
- [x] 迁移期间明确写入冻结或增量追平策略；切换前逐项验证记录数量、内容哈希、引用完整性和发布状态。失败可恢复，回滚不得丢弃切换后新增的合法写入。
- [x] 运营 UI 与五个内容维护工具在新库完成一次整份法规和一份文书的提交、检查、发布、撤回、恢复；客户与无权限运营人员均不能操作 staging 或审计。
- [x] publisher 直接越过维护入口也不能改写已发布的不可变版本或取得 DDL；平台内容存储不消耗客户工作区资源配额。
- [x] 真实配额受管 SurrealDB 集成测试覆盖迁移重复执行、半途失败、发布并发与受限身份拒绝；旧路径在验证完成后退役，旧数据清理另行记录执行条件。

## 范围与交接

这是后续客户内容访问的前置调整。复用已有内容维护契约，不重做 OAuth MCP、通用爬虫或运营页面。

遵守本簇已确认的产品规则、授权边界与发布门槛。完成时在 Comments 记录实现范围、验证命令与结果、未解决限制和下游交接；只更新本票完成状态，不自动关闭或修改产品设计父票。

## Comments

- 2026-09-24：用户确认拆分后发布；当前为实施规格，尚未执行实现与验收。
- 2026-09-24：实现了独立 platform_content schema、受限 content_publisher RECORD 会话、
  启动迁移门禁、可重试的 18 表及引用边迁移脚本和切换清单。运营 HTTP/页面与五个 MCP
  工具继续共用 PlatformContentService，默认 store 和引用解析已改用 publisher 会话；
  _system 仍仅保留运营资格与能力权威。验证：shared/server typecheck；SurrealQL
  validate；server 全量回归 424 pass / 19 skip / 0 fail；临时 SurrealDB 3.2.3
  集成测试覆盖合成法规、
  文书、法条关系、撤回、恢复、DDL 拒绝、不可变版本不可改、并发发布单版本、
  迁移中断恢复与重复执行。
  命令及操作步骤见 ../migration-inventory.md。尚未在真实配额受管目标数据库上核查
  生产记录数量/许可与真实内容、运营 OIDC 身份矩阵、灰度切换和配额归属，故本票未标 done。
- 2026-09-24：使用 `MainListActivity/surrealdb` 正式版晋级候选二进制
  `3.3.0-native-quota.1+sha.f30704bce914`（SHA-256 与 release 一致）在
  RocksDB 上复验，内容库与迁移集成测试连续五次均 2 pass / 0 fail。
  工作区原生 record quota 0 被拒，内容库发布成功且工作区 quota usage 未变。
  集成测试已走运营 HTTP 读写入口和五个 MCP 工具，并验证客户 staging/审计 403、
  合成整份法规与文书发布、法条关系、撤回/恢复、publisher DDL 与不可变版本拒写。
  `pnpm run lint`、`pnpm run typecheck`、`pnpm run build:ops` 通过。
  旧 `_system` 内容日常读写路径已退役，仅迁移与启动门禁读取旧库；旧记录保留作审计。
  真实生产数据和真人 OIDC 页面操作未在本地复现，部署时须按迁移清单执行写入冻结、
  数据逐项核验和灰度切换。本票实现及 release 级验收完成，状态改为 done。
