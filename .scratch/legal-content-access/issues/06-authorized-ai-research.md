# 06 — AI 使用平台内容与私有资料生成可核验回答

**What to build:** 成员向 AI 提问后，AI 联合当前可访问的平台法律内容与工作区私有材料生成回答；每条法律引用能回到当时使用的精确版本和位置。

**Blocked by:** [04 — 检索、阅读和收藏授权法律内容](04-authorized-legal-search.md)；[05 — 工作区共享 AI 额度闭环](05-shared-ai-allowance.md)

**Status:** done

**ID:** SCK-LCA-06
**确认时序号:** 7
**Repository:** surreal_ck
**Parent:** [本簇实施规格](../PRD.md)

## Acceptance criteria

- [ ] 将现有资源检索入口接到 Authorized Corpus Module；调用方提供问题、模式与用户筛选，身份、工作区、集合授权和会话由执行 runtime 注入，模型不能选择安全上下文。
- [ ] 一个执行窗口分别持有调用者 workspace session 与 content session，捕获权益修订；AI 使用许可与 read/cite 等动作分别验证，未授权全文、片段和候选不进入模型上下文。
- [ ] 以关键词和结构化检索先完成双语料召回、去重和证据登记；证据句柄绑定来源类型、精确版本、定位、哈希、授权修订和允许引用的片段。
- [ ] 模型仅输出已登记的引用句柄；后处理拒绝伪造句柄、版本错配、无引用许可及无法由证据支撑的引用。页面区分来源事实、用户材料与模型分析。
- [ ] 平台不可用或权限未知时可继续私有资料分析，但明确标示 partial/unavailable；证据不足时说明缺口，不生成假装有来源的法律结论。
- [ ] 流式输出、消息保存和报告保存只携带允许保留的引用快照；content token、平台全文、向量和授权外候选不写入 workflow snapshot、消息元数据或诊断日志。
- [ ] 收费研究沿用 05 的报价、预留和结算，不因多个检索适配器重复扣费；普通打开引用不重复计费。
- [ ] 用可检查模型输入的替身及少量真实模型验收，证明授权外的唯一标记从未进入提示词、答案或引用；覆盖不同套餐、私有材料权限、内容撤回与伪造引用。
- [ ] 07 完成前，新平台语料路径对暂停恢复、缓存复用及带平台证据的历史追问采取明确拒绝或重新开始授权研究，不沿用不安全的旧快照。

## 范围与交接

实施前加载 Mastra 技能并核对安装版本文档。平台候选及引用改动须兼容既有 workspace 资料引用。

遵守本簇已确认的产品规则、授权边界与发布门槛。完成时在 Comments 记录实现范围、验证命令与结果、未解决限制和下游交接；只更新本票完成状态，不自动关闭或修改产品设计父票。

## Comments

- 2026-09-24：用户确认拆分后发布；当前为实施规格，尚未执行实现与验收。
- 2026-09-24（LCA06 实现，分支 task/c57ed96f）：
  - **实现范围**：
    - `server/src/research/window.ts`：受控研究窗口工厂——服务端为调用者开设 content_reader 会话（复用 LCA04 search exchange），token 不回传浏览器；失败归一 unavailable，不外泄细节。
    - `server/src/research/corpus-retrieval.ts`：`retrieveAuthorizedCorpus`——CONTENT_SEARCH_QUERY 召回 → content_read_gate 生效动作（gate∩license，ai_use 需 research/generate）→ StringRecordId 读 content_version（body_text 不可见即 read_denied）→ 法规按条 / 文书按 cite 片段 / 受限摘录兜底登记证据；locator.bodyDigest ≠ body_sha256 即 version_mismatch；sourceKey 从版本行 source 记录 id 派生（content_source 表对读者不可见）；RESEARCH_QUOTE_MAX_CHARS=400、RESEARCH_EVIDENCE_LIMIT=12。
    - `server/src/research/research-answer.ts`：证据登记表（去重/上限/句柄）、提示词（仅含登记证据，quoteAllowed=false 标注「仅参考不可引用」）、后处理校验（forged / cite_not_allowed 剔除）、citationDTO（绑定 versionId/itemId/sourceKey/locator）、三段式回答组装（来源事实/用户材料/模型分析/覆盖说明，partial/unavailable 标注与缺口披露）。
    - `server/ai/mastra/agents/legal-research-agent.ts`：legal-research agent + 联合执行器——Promise.all 并行私有检索与开窗；无证据不调用模型；平台证据不进 workflow state；窗口 finally 关闭。
    - 贯穿改造：router-workflow / router-chat / chat-service / routes/ai-chat / assemble-mastra / app.ts 的 `openContentSession` 线程；生产装配默认注入 `createContentResearchSessionFactory()`。
  - **验证命令与结果**：
    - `pnpm --filter @surreal-ck/server exec bun test src/research/... ai/mastra/agents/legal-research-agent.test.ts --preload ./test/setup-env.ts`：36 pass（含真实引擎联调 `corpus-retrieval.integration.test.ts`，RUN_LOCAL_PLATFORM_CONTENT_TESTS=1 + 本地 SurrealDB + ES256 JWKS 签发 content_reader JWT，证明 gate 之外条目在库层不可见、哈希与 locator 核验通过）。
    - `pnpm test`：server 625 pass / 4 fail（4 个均为 OIDC middleware 本地环境既有失败，main 同样失败、与本分支无关；CI Quality gate 同提交通过）；shared 135 pass；ops 1 pass。
    - `pnpm typecheck` 全 workspace 通过；`pnpm lint` 0 warning。
    - 替身模型验收：授权外唯一标记 CANARY-DENIED 绝不进入提示词与回答。
  - **迁移类型**：无 schema 迁移。
  - **新环境变量**：无。
  - **限制与下游交接（07 之前的安全边界）**：挂起 payload 只携带工作区资源候选，平台证据不进 suspend data / workflow snapshot；恢复路径不重放平台证据——执行器每次回答重新开窗召回，不沿用旧快照。citations 快照经 state schema 白名单持久化（itemId/versionId/sourceKey/locator，不含全文、向量或授权外候选）。收费结算沿用 05 链路，平台检索经既有 search exchange 不重复扣费；普通打开引用不经研究路径不产生额外计费。前端消息 citations 渲染（含 platformContent 绑定）与报告保存为 07 交接点。

