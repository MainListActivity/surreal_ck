# 03 — 订阅成员打开一篇获授权的法律内容

**What to build:** 工作区内的获授权成员通过独立的内容读取会话，在真实页面打开一篇已发布法律内容；没有权限的成员无法通过直接连接数据库或伪造内容 ID 绕过限制。

**Blocked by:** [01 — 将内容维护迁到独立内容库](01-isolated-content-publishing.md)；[02 — 工作区绑定产品套餐并展示内容权益](02-product-entitlement-assignment.md)；[IDP-LCR-01 — 短期内容读取凭证](/Users/y/IdeaProjects/ma_hono/.scratch/content-reader-scope/issues/01-content-reader-token-exchange.md)

**Status:** ready-for-agent

**ID:** SCK-LCA-03
**确认时序号:** 4
**Repository:** surreal_ck
**Parent:** [本簇实施规格](../PRD.md)

## Acceptance criteria

- [ ] Workspace Scope Module 校验调用者当前身份、有效成员关系、工作区和当前内容权益，再换取独立短期内容凭证；不替换浏览器现有工作区 token，也不接受模型或客户指定授权 revision。
- [ ] 权益以可重试、可核验方式投影到内容数据库；只有完整匹配的 revision/digest 才开放读取。来源动作、发布状态与工作区授权取交集，未知事实或投影异常拒绝扩大访问。
- [ ] content_reader 为 RECORD 身份；授权由 schema 中的表/字段权限强制，业务查询只带用户过滤条件。工作区管理员携带的 system role 不赋予内容库 DDL/DML。
- [ ] 提供可从工作区内容入口访问的最小正文阅读页，显示内容版本、来源与授权状态；同工作区管理员和普通成员可共享商业内容范围，但各自身份均须有效。
- [ ] 分别验证 search、read、cite、AI 使用及 export 的许可边界；仅 metadata 权限不能读取正文、摘录、法条全文或隐藏字段，批量查询和直接 RecordId 访问同样受限。
- [ ] 固定读取 lease、会话到期与撤权收敛上限并写入配置/运维契约；lease 不超过权益和许可有效期。已建立连接的新读取不能凭旧 token 无限延续授权，投影停止续期时在确定期限内关闭访问。
- [ ] 授权投影只能由受限控制面同步能力写入；客户不能自授权限。root 不进入客户查询，不能用 root 读取后在应用层过滤，也不把任何会话或 secret 落入日志。
- [ ] 真实数据库和浏览器验收覆盖两个工作区、两个成员角色、非成员、移除成员、错误 revision、过期 token、投影中断、许可过期、内容撤回以及内容库 DDL/DML 拒绝。

## 范围与交接

本票以已知内容指针完成最小读取闭环，检索入口由 04 扩展。跨仓凭证格式和到期约束以 IDP-LCR-01 为前置。

遵守本簇已确认的产品规则、授权边界与发布门槛。完成时在 Comments 记录实现范围、验证命令与结果、未解决限制和下游交接；只更新本票完成状态，不自动关闭或修改产品设计父票。

## Comments

- 2026-09-24：用户确认拆分后发布；当前为实施规格，尚未执行实现与验收。

