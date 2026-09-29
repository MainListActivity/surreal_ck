# 03 — 订阅成员打开一篇获授权的法律内容

**What to build:** 工作区内的获授权成员通过独立的内容读取会话，在真实页面打开一篇已发布法律内容；没有权限的成员无法通过直接连接数据库或伪造内容 ID 绕过限制。

**Blocked by:** [01 — 将内容维护迁到独立内容库](01-isolated-content-publishing.md)；[02 — 工作区绑定产品套餐并展示内容权益](02-product-entitlement-assignment.md)；[IDP-LCR-01 — 短期内容读取凭证](/Users/y/IdeaProjects/ma_hono/.scratch/content-reader-scope/issues/01-content-reader-token-exchange.md)

**Status:** done

**ID:** SCK-LCA-03
**确认时序号:** 4
**Repository:** surreal_ck
**Parent:** [本簇实施规格](../PRD.md)

## Acceptance criteria

- [x] Workspace Scope Module 校验调用者当前身份、有效成员关系、工作区和当前内容权益，再换取独立短期内容凭证；不替换浏览器现有工作区 token，也不接受模型或客户指定授权 revision。
- [x] 权益以可重试、可核验方式投影到内容数据库；只有完整匹配的 revision/digest 才开放读取。来源动作、发布状态与工作区授权取交集，未知事实或投影异常拒绝扩大访问。
- [x] content_reader 为 RECORD 身份；授权由 schema 中的表/字段权限强制，业务查询只带用户过滤条件。工作区管理员携带的 system role 不赋予内容库 DDL/DML。
- [x] 提供可从工作区内容入口访问的最小正文阅读页，显示内容版本、来源与授权状态；同工作区管理员和普通成员可共享商业内容范围，但各自身份均须有效。
- [x] 分别验证 search、read、cite、AI 使用及 export 的许可边界；仅 metadata 权限不能读取正文、摘录、法条全文或隐藏字段，批量查询和直接 RecordId 访问同样受限。
- [x] 固定读取 lease、会话到期与撤权收敛上限并写入配置/运维契约；lease 不超过权益和许可有效期。已建立连接的新读取不能凭旧 token 无限延续授权，投影停止续期时在确定期限内关闭访问。
- [x] 授权投影只能由受限控制面同步能力写入；客户不能自授权限。root 不进入客户查询，不能用 root 读取后在应用层过滤，也不把任何会话或 secret 落入日志。
- [x] 真实数据库和浏览器验收覆盖两个工作区、两个成员角色、非成员、移除成员、错误 revision、过期 token、投影中断、许可过期、内容撤回以及内容库 DDL/DML 拒绝。

## 范围与交接

本票以已知内容指针完成最小读取闭环，检索入口由 04 扩展。跨仓凭证格式和到期约束以 IDP-LCR-01 为前置。

遵守本簇已确认的产品规则、授权边界与发布门槛。完成时在 Comments 记录实现范围、验证命令与结果、未解决限制和下游交接；只更新本票完成状态，不自动关闭或修改产品设计父票。

## Comments

- 2026-09-24：用户确认拆分后发布；当前为实施规格，尚未执行实现与验收。

- 2026-09-29：已实现并随 PR #30 及后续修复链上生产，QA 独立验收 accept，全部 8 条 AC 于生产实测通过。实现范围：Workspace Scope Module `/api/session/content-reader` 换票（不替换工作区 token、不接受客户端指定 revision）、`platform_content` 隔离库 + `content_reader` RECORD access、schema 表/字段权限强制、权益投影（digest/revision 严格匹配）、最小正文阅读页 `/w/<slug>/content/<contentPublicId>`、IdP `/scope` 端点 `content_reader.v1` 签发（ma_hono PR #1）。

  **生产入口（真实验证）**：`https://l.maplayer.top/w/sck-lca03-a/content/version_b26c8be35f0948058a85055f81dacb1a`，以测试成员账号 `sck-lca03-a-member`（sub `0a06e1a6`）登录即渲染「法律内容·独立授权阅读」页：精确版本 2020年修正·#1、来源 flk.npc.gov.cn 官方 URL、授权状态、内容指针与著作权法正文全文。验收集合 `lca03_acceptance`；许可来源 `flk.npc.gov.cn.legislation.lca03-allow`（9 客户动作、无 AI 动作）。

  **已上线版本**：surreal_ck 生产 main = `d9db533c9f44364c636a0e36dd3787b1d167d3f5`（PR #30 merge `a31900e` + 链A迁移钩子 PR #38 + 成员重加修复 PR #39 + 集合绑定 PR #40 + 错误映射 PR #41）；Deploy production run `36538080967` success。IdP ma_hono PR #1（head `8edc9474`）已部署（Worker 版本 `2445b4aa`），`/scope` 签发 content_reader。

  **QA 逐项结果（2026-09-29 生产实测）**：AC1 四类身份换票 200（contractId=content_reader.v1、expiresInSeconds=900；夹带 revision→400 client_authority_rejected）；AC2 投影交集（digest sha256:0040f3… 与换票一致，confirmed_until−confirmed_at≈899s；未绑定→collection_denied、许可过期→license_expired、撤回→content_withdrawn）；AC3 RECORD 边界（读成功、UPDATE/DELETE/INSERT 零行、DDL 拒；RL=Owner 不越权）；AC4 浏览器真实页渲染正文；AC5 动作/字段边界（browse/search/read/cite/export 允许，research/generate/ai_use 拒；隐藏字段空；metadata-only 权益下正文剥离）；AC6 租约收敛（TTL≤900s、token exp=leaseEnd、过期 token authenticate 拒绝、rev4 token 在 rev5 撤权后被拒）；AC7 控制面隔离（内容库仅三个 access、客户写投影零行、审计只记 claim 名）；AC8 矩阵（两工作区/成员角色/移除重加/错误 revision/过期 token/投影更迭/许可过期/撤回/DDL·DML 拒）。

  **运维契约**：lease=min(主体 token 剩余、权益/许可有效期、900s)；投影 confirmed_until≤confirmed_at+15m；投影停续后访问在确定期限内关闭。回滚：应用侧回退上一 main commit 重部署（迁移为只新增结构，不随代码回滚，新代码回退后旧代码仍可用既有结构）；IdP 侧 `wrangler rollback` 至上一 Worker 版本（`5f914aa8`）。

  **已知限制**：>15 分钟墙钟「连接保持逐查询收敛」未做长等待（上限链已核）；ops sources 读视图 `effective_until` 显示异常（enforce 不受影响，另案记录）；pointWorkspace 单调保护缺陷（恢复指派 digest 命中旧快照不回指）已独立复现并拆链（实现 e9c9a241→部署 7094ba31），不影响本票门禁。

