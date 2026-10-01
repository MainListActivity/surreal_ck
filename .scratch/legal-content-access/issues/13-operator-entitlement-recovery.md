# 13 — 运营解释、临时授权与交付修复

**What to build:** 平台运营在独立运营端定位工作区权益交付问题，重试正确的交付修订，并按能力发放或撤销有期限的内容赠送，客户看到可解释的结果。

**Blocked by:** [03 — 订阅成员打开一篇获授权的法律内容](03-authorized-content-reader.md)；[05 — 工作区共享 AI 额度闭环](05-shared-ai-allowance.md)；[08 — 订阅变更驱动内容权限生效与收回](08-subscription-content-lifecycle.md)

**Status:** done

**ID:** SCK-LCA-13
**确认时序号:** 14
**Repository:** surreal_ck
**Parent:** [本簇实施规格](../PRD.md)

## Acceptance criteria

- [ ] 工作区运营页展示基础产品、各类权益来源/有效期、当前与期望修订、内容投影核验和 AI 预留/结算状态；资源使用可信原生配额事实。
- [ ] 对投影失败提供限定修订的幂等重试；旧修订任务不能覆盖新的撤权，失败不重复下单、不重复发额度，核验后客户状态同步更新。
- [ ] 临时内容赠送是独立版本化来源，必须有范围、动作、理由、操作者和有效期；撤销只移除该来源，与基础订阅重叠时保留仍有效的授权。
- [ ] 运营能力分别控制查看、订阅调整、内容赠送及交付修复；工作区管理员或普通客户不能调用，失去运营资格的旧 token 不继续执行动作。
- [ ] 动作前显示当前与目标影响，审计记录来源、修订、结果及关联事件；运营不能直接改当前快照或绕过来源许可，也不读取客户私有研究材料。
- [ ] 异常队列区分已确认商业来源但尚未交付、内容投影故障及 AI 结算异常；正常到期与合法 over_limit 不当作系统失败。
- [ ] 在 UI 完成一次模拟交付失败修复、重叠赠送的授予/撤销及赠送到期；测试并发修订、越权运营、重复请求、来源许可收紧和服务重启恢复。

## 范围与交接

复用独立 ops 与已有审计、运营身份和订阅控制面，不另建通用数据库管理界面。

遵守本簇已确认的产品规则、授权边界与发布门槛。完成时在 Comments 记录实现范围、验证命令与结果、未解决限制和下游交接；只更新本票完成状态，不自动关闭或修改产品设计父票。

## Comments

- 2026-09-24：用户确认拆分后发布；当前为实施规格，尚未执行实现与验收。

## Comments

- 2026-10-01（engineering-factory-droid-33df59）：实现范围——运营解释视图增强（getForOperator 注入 AI 预留/结算真实账本事实、内容投影核验（复用 reader gate 受限会话）、来源理由/操作者/撤销状态）；交付修复（POST /api/ops/product-entitlements/workspaces/:slug/delivery-repair，限定修订护栏 expectedCurrentRevision，只算当前绑定修订，digest 幂等＋auditByKey 幂等，重驱幂等 plan-cycle 同步，不下单不直接发额度）＋只读 delivery-preview；临时内容赠送撤销（content_grant 不可变，新增 022 迁移 content_grant_revocation 追加式撤销，解析读取排除，撤销只移除该来源、基础订阅保留）；能力分权（新增 entitlement.gift / entitlement.repair，grants 端点从 subscription.manage 改挂 entitlement.gift）；异常队列（GET /api/ops/product-entitlements/exceptions：delivery_pending / projection_failure / ai_settlement_anomaly；正常到期与合法 over_limit 不入队）；ops 前端（来源明细+撤销、赠送表单、修复预览+确认、异常队列面板）。验证：`pnpm --filter @surreal-ck/shared run test`（155 过）、`pnpm --filter @surreal-ck/ops run test`（5 过）、`pnpm --filter @surreal-ck/server run test`（新增 6 用例全过；13 项失败为基线既有需真实 SurrealDB/OIDC 的集成测试，A/B stash 对照一致）、`pnpm run typecheck`（0 错）、`pnpm run lint`（0 警告）。迁移类型：只新增结构（022 新表）。未解决限制：旧 claim-analysis 类目记录无生产存量，兼容路径由三处单测覆盖（classifier/workflow/suspend）；真实内容赠送的产品数值（费率/额度）仍需获批修订后启用。下游交接：LCA14 可用 exceptions 队列与 delivery-repair 做生产灰度演练；运营人员需授予新能力行（entitlement.gift/entitlement.repair）。
- 2026-10-02（engineering-devin-5011dd，运营验收退回修复）：三处阻断修复——① 交付预览严格只读：`describeDeliveryRepair`/`repairDelivery` 改走 `readOnlyView`（只读已交付快照，不触发 read-heal），`materializePreview` 保持纯计算；`repairDelivery` 护栏（expectedCurrentRevision）移到一切写入之前，护栏失败零写入；无活跃订阅时预览不再指向修复目标。② 投影核验重写：单语句批量取数、按 SDK 真实形状取末尾 `RETURN`；核验对象改为「工作区当前已交付快照指定的投影」——`content_authorization_projection` 行与快照 revisionNumber+digest 比对（absent/active/closed/expired），逐集合逐来源过许可矩阵（来源状态/许可窗口/动作交集，口径同 `fn::content_reader_visible`），verdict 细化 ok/empty_collection/license_blocked/projection_stale/projection_error/unavailable，fail closed；异常队列只在 license_blocked/projection_stale/projection_error 入 projection_failure（empty_collection=内容侧未供稿、unavailable=核验不可用，均不算系统失败）。③ 撤销安全回滚门：旧代码不读 `content_grant_revocation`，回滚到不含本 PR 的 SHA 会让已撤销赠送重新生效——回滚目标必须通过 `git merge-base --is-ancestor <LCA13-merge-sha> <rollback-sha>` 校验，否则先合入带撤销过滤的兼容补丁作为中间回滚点；能力交接期运营账号同时保留 `subscription.manage` 与 `entitlement.gift`/`entitlement.repair`，确认不回滚后再收窄。验证：新增 preview 零写入四场景回归、护栏失败零写入、并发收敛、异常队列分型、投影核验 10 用例（许可过期/未生效/停用/缺失/动作拒绝/多来源/最新修订/版本缺失/空集合/absent）、路由级 AC7 闭环（预览→修复、赠送撤销到期、失格 403、同键并发、重启回放）、公司 fork 集成复验（projection-verify.integration.test.ts 通过）。测试夹具抽至 server/test/entitlement-recovery-store.ts；路由新增 requireOperator 测试注入点（默认仍 requirePlatformOperator）。
