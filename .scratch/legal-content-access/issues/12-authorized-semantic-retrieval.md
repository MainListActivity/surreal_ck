# 12 — 授权范围内的语义类案检索

**What to build:** 成员以自然语言寻找相关法条和类案，平台在其有权访问的内容内结合关键词和语义召回，提高相关性，并能解释采用的法律依据。

**Blocked by:** [06 — AI 使用平台内容与私有资料生成可核验回答](06-authorized-ai-research.md)

**Status:** done

**ID:** SCK-LCA-12
**确认时序号:** 13
**Repository:** surreal_ck
**Parent:** [本簇实施规格](../PRD.md)

## Acceptance criteria

- [x] 在既有授权检索接口内部引入独立的平台与私有资料 retrieval adapter，保留调用者会话与许可约束，接口不接受模型指定授权集合。
- [x] HNSW 候选必须在数据库权限允许范围内召回和返回；跨集合过滤导致召回不足时使用经验证的授权分区或数据库内筛选，不以取回未授权全文再过滤换取召回率。
- [x] 关键词、语义、法源/裁判层级、法域、程序、争点、效力和质量信号进入可版本化排序；不跨索引直接比较原始向量距离，也不把越新越相关作为通则。
- [x] 按稳定内容身份、来源及哈希处理重复文书，保留可引用的来源差异；结果仍携带精确版本并经过证据注册与引用校验。
- [x] 向量不可用时在同一授权范围内降级到关键词/结构化检索并说明能力变化；普通语义检索不逐次扣 AI 研究额度。
- [x] 缓存标识包含 embedding/ranking 与 release 版本；旧索引、重建和滚动更新不能复活已撤回内容或串用别的工作区候选。
- [x] 在固定且可合法使用的法律检索集上报告召回率、排序质量、延迟及授权泄露检查，与关键词基线比较；参数和阈值由测量记录决定。
- [x] 浏览器展示相关结果及有限排序解释，检验低召回、索引故障、授权集合变化、无 AI 使用许可来源和跨工作区私有资料的负例。

## 范围与交接

实施前加载 surrealdb-vector 与 surrealql 技能并验证实际引擎行为。任何召回优化都不得降低数据库授权要求。

遵守本簇已确认的产品规则、授权边界与发布门槛。完成时在 Comments 记录实现范围、验证命令与结果、未解决限制和下游交接；只更新本票完成状态，不自动关闭或修改产品设计父票。

## Comments

- 2026-09-24：用户确认拆分后发布；当前为实施规格，尚未执行实现与验收。
- 2026-10-01：实现完成（branch task/08aaa38b）。
  - 范围：`shared/src/legal-retrieval.ts`（strict 请求契约 + legal-rrf-v1 RRF 排序，含中文 bigram 分词、稳定身份去重）；`server/src/research/platform-retrieval.ts`（调用者会话内关键词 + HNSW 探针 + 库内精确召回，授权谓词全程在引擎侧）；`server/src/research/private-retrieval.ts`（workspace db 内向量检索 + 文本 hash 新鲜度校验）；`server/src/content/semantic-index.ts`（发布者派生索引，索引失败不否定已提交发布）；`shared/sql/platform-content/009-semantic-retrieval.surql`（仅新增结构）；`POST /api/legal/search`（租约前后复查 + no-store）；`ContentEntryScreen` 语义模式与排序解释。embedding 沿用既有 provider，不新增付费服务；普通语义检索（ai=false）不检查 ai_use、不消耗研究额度。
  - 验证（公司 fork `~/.surrealdb/surreal`，memory）：`server/src/research/`、`src/content/`、`src/resources/`、`src/routes/content.test.ts` 与 `shared/src/legal-retrieval.test.ts` 全绿；`RUN_LOCAL_PLATFORM_CONTENT_TESTS=1` 下 store/migrate 集成 5/5 过；固定语料评测 `platform-retrieval.eval.test.ts` 实测 keyword recall@10=0.5 → hybrid=1.0、授权泄露 0、撤回文档不复活、release 不一致即空；私有向量 `private-retrieval.integration.test.ts` 验证写侧 hash 与库侧重算一致、过期向量剔除、跨 database 不可见。`pnpm typecheck`（shared/server/web）与 `pnpm lint` 清洁。
  - 已知限制：旧关键词查询按字段解引用会逐字段触发 fn::content_reader_action，实测 29 文档语料上约 1.5s 贴近 2s 超时，已改为 `FETCH version` 每行单次解析（约 300ms）；大规模语料下的延迟曲线未测。`resource_item.evidence` 在 008 模板为裸 `TYPE array`，fork 的 SCHEMAFULL 拒绝带字段的对象元素（疑似 RR-013 移植回归，legacy schema 为 `TYPE any`），测试 fixture 以 `evidence.* TYPE object FLEXIBLE` 补齐；建议另开 schema 修复票。生产环境未实测。

