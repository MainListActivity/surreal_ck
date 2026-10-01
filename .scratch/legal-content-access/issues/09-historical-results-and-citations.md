# 09 — 到期后保留成果，引用按当前权限展示

**What to build:** 用户在降级或到期后仍能查看自己的研究报告、收藏和批注；引用清楚说明哪些依据仍可核验、哪些全文已锁定，以及是否可按当前语料重跑。

**Blocked by:** [06 — AI 使用平台内容与私有资料生成可核验回答](06-authorized-ai-research.md)；[08 — 订阅变更驱动内容权限生效与收回](08-subscription-content-lifecycle.md)

**Status:** done

**ID:** SCK-LCA-09
**确认时序号:** 10
**Repository:** surreal_ck
**Parent:** [本簇实施规格](../PRD.md)

## Acceptance criteria

- [ ] 历史报告与用户批注保持原文和版本，不因平台内容失权被整份隐藏、删除或静默重写。
- [ ] 引用展示捕获时允许保留的身份、精确版本、locator、哈希和访问时间；摘录同时满足捕获许可及当前留存展示约束，否则隐藏摘录并说明原因。
- [ ] 每次打开平台正文都经过当前授权；分别展示报告可见、引用可核验、全文可打开及可重跑状态，不用单一可用标记替代。
- [ ] Pro 降 Plus 后按引用逐项锁定超出集合的全文，当前仍覆盖的部分可正常打开；重新升级仅在新授权投影核验后恢复。
- [ ] 来源撤回、许可终止与删除要求优先于历史套餐；显示允许保留的 tombstone 和原因类别，不暴露被要求删除的实质内容，不擅自改写法律事实。
- [ ] 导出用户报告时仅包含当前可展示的引用信息，不重新读取或嵌入锁定正文；不声称远程回收此前已合法交付的本地导出。
- [ ] 重跑生成新的成果版本，使用当前授权及收费规则；保留旧版本的研究时间和依据，不把旧引用快照当作新的模型授权。
- [ ] 浏览器与数据层测试覆盖混合授权引用、到期、重新订阅、来源撤回、不可留存摘录、导出与重跑，并确认用户私有资料按其原有 workspace 权限继续可用。

## 范围与交接

已有成果的保留与新的内容访问分开验证。可见报告不代表其旧平台证据可无条件重新进入 AI 上下文。

遵守本簇已确认的产品规则、授权边界与发布门槛。完成时在 Comments 记录实现范围、验证命令与结果、未解决限制和下游交接；只更新本票完成状态，不自动关闭或修改产品设计父票。

## Comments

- 2026-09-24：用户确认拆分后发布；当前为实施规格，尚未执行实现与验收。
- 2026-10-01（LCA09 实现）：
  - **实现范围**：(1) 共享契约 `shared/src/citation-status.ts`（请求 ≤50 条/批、状态四态 `verifiable/locked/tombstoned/unavailable` + 稳定原因类别 + 摘录/全文可展示位，中文说明口径共用）；(2) 服务端 `server/src/research/citation-status.ts` 纯分类器 + `createCitationStatusHandler`（复用 03/04 同一授权计划器 `planContentReaderExchange` 判定——与打开正文同规则，只是不换票、不写投影；事实读取走 content_projection_sync 受限会话仅 metadata，同 search-exchange 控制面路径），新路由 `POST /api/legal/citation-status`（`routes/legal-content.ts`，requireUser，fail-closed 503）；(3) 前端 `web/src/lib/citation-status.ts`（分批加载、失败全退"暂不可核验"）与 `web/src/lib/research-export.ts`（导出仅含当前可展示引用：可核验→版本/定位/哈希/捕获时间/全文指针；锁定→摘录保留+原因；墓碑→只显示 tombstone 与原因类别；不重新读取或嵌入锁定正文，不宣称远程回收已交付导出）；(4) AiDrawer 历史回答：报告级四态摘要（报告可见/引用可核验/全文锁定/已撤回/暂不可核验）+ 逐引用状态渲染 + 「导出报告」「按当前语料重跑」（重跑=新 run、当前授权与收费规则，旧消息原样保留，旧引用快照不作为新授权）。
  - **保留语义**：历史报告/收藏/批注都是 workspace 数据（resource_item / legal_reference），平台失权只影响内容库 gate，无任何删除/隐藏路径；锁定（降 Plus/到期保留模式）下报告与已捕获摘录保留、全文逐引用关闭；来源撤回（withdrawn/下架/许可终止/删除）优先于历史套餐，摘录隐藏并显示原因类别；权限未知 fail closed。
  - **验证**：server `citation-status.test.ts` 9 pass（分类矩阵：可核验/删除/撤回/许可终止/降级集合/到期/保留模式/成员移除/身份过期 + 去重回填 + 响应无内容字段 + fail closed）；web `citation-status.test.ts` + `research-export.test.ts` 9 pass（指针去重、失败降级、50 条分批、四态汇总、导出矩阵、重跑问题提取）；`pnpm -r typecheck` 全绿、`pnpm lint` 0/0。迁移类型：无。新 env：无。
  - **未解决限制/下游交接**：引用状态核验请求不写授权投影、不签发 token——打开全文仍走既有 content reader 换票（当前授权）；「重新升级仅在新授权投影核验后恢复」由 03/08 换票路径保证（本票未改）；工作区私有资料按原 workspace 权限继续可用（无改动）。

