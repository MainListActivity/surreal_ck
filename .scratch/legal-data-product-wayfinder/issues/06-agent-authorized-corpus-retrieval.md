Status: done
Label: done
Assignee: product-architecture

# 设计智能体的授权语料解析与可核验引用

Parent: [`律师行业订阅与平台法律数据产品决策地图`](../PRD.md)

## Question

智能体如何根据当前工作区的内容访问权自动选择法规、案例、专业模块和用户私有材料，并生成可打开、可验证且不会越权的引用？

## Dependencies

- [`拆分内容访问、资源容量、AI 额度与功能能力`](03-entitlement-domain-model.md)
- [`设计平台法律内容目录、版本与授权生命周期`](05-content-catalog-licensing-lifecycle.md)

## Expected decision

- 定义授权语料解析器的输入、输出、缓存和拒绝语义。
- 明确区分平台内容、用户材料和模型推断。
- 定义引用快照、来源版本、更新时间和权限检查时点。
- 定义未授权内容的发现预览与专业模块推荐边界。

## Source audit

- 当前 `ResourceAgent` 只检索调用者 workspace database 内的 `resource_item`，执行器和 tools 仅接收一条 `surrealSession`。
- 当前 `searchResources` tool 允许模型传入 `workspaceId`，虽然真正权限由绑定 session 兜底，但这个参数会让未来双库授权 Interface 变浅并增加误用空间。
- 当前 `ResourceCitationDTO` 只有 workspace `resourceId`、标题、URL 和证据摘录，不能表达平台内容稳定身份、精确版本、数据集发布、引用定位、授权 revision 或来源类型。
- 当前 workflow 会持久化步骤与 citations，并在 suspend/resume 后使用新 workspace session 恢复；未来不得把短期 content token、平台全文或未授权候选持久化进 workflow snapshot。
- 当前高置信检索结果可直接拼成回答，缺少“模型只能引用已登记证据”“逐引用版本校验”和“平台内容、用户材料、模型推断”三分机制。

## Decision

### 1. 建立深 `Authorized Corpus Module`

Mastra Router、ResourceAgent、虚拟员工和未来 API 都通过同一个小 Interface 使用授权研究能力：

```text
research(question, userContext, mode, filters?) -> AuthorizedResearchResult
resolveCitation(citationRef)                    -> AuthorizedCitationDetail
```

调用方不传 workspaceId、subject、collection ID、entitlement revision、数据集或数据库会话。这些安全上下文由 run runtime 注入，Module 内部负责：

- 捕获当前工作区与调用者身份；
- 获取内容读取会话与内容权益 lease；
- 生成法律检索计划；
- 分别检索平台内容和 workspace 私有资料；
- 归一化、去重、重排和提取证据；
- 固定内容版本与引用定位；
- 返回 coverage、候选、证据与结构化拒绝原因。

Module 的 Interface 同时是调用方与测试的唯一 seam；collection 选择、授权过滤、向量实现和内容数据库细节留在 Implementation 内。

### 2. 每个执行窗口持有两条调用者会话

Router runtime 在现有 `surrealSession` 之外增加独立 `contentSession`，两者均绑定当前真人和工作区：

- `surrealSession`：读取 workspace 私有 `resource_item`、业务记录和用户材料；
- `contentSession`：读取平台法规、案例、实务内容和授权投影；
- `productEntitlementRevision`：记录该执行窗口捕获的产品权益；
- `contentEntitlementRevision`：固定本次平台内容授权视图。

请求和 resume 都重新建立短期会话。一个正在执行的检索/生成步骤固定启动时 revision；workflow suspend 不延长授权 lease，恢复时必须重新授权。任何路径都不存在 root 或无授权 fallback。

### 3. 授权语料解析顺序

1. 从用户问题和界面上下文提取争点、当事人角色、法域、程序阶段、时间范围和材料范围。
2. 根据 content entitlement 解析允许的 content collection 和动作；模型生成的分类不能扩大授权。
3. 在 workspace session 下检索当前真人有权读取的私有资料。
4. 在 content session 下检索允许 search/read/AI-retrieve 的平台内容。
5. 分别生成候选并在授权范围内做混合检索、去重和重排。
6. 读取精确内容版本和引用片段，登记到本次 run 的 evidence registry。
7. 只把 evidence registry 中允许进入 AI context 的证据交给模型。
8. 对模型输出的引用句柄做校验后生成最终 citations。

授权必须在数据库读取路径强制，应用层再做防御性校验；禁止先取回所有平台内容，再在 Bun 中删除未授权结果。

### 4. 双语料检索与排序

- 平台内容和 workspace 私有资料使用独立 retrieval adapter，因为二者的授权、字段、质量信号和索引生命周期不同。
- 每个 adapter 可以结合关键词、结构化过滤和 SurrealDB HNSW KNN；向量只能做候选召回，不能单独决定法律相关性。
- HNSW 召回必须在数据库权限及允许 collection 范围内执行。若索引过滤造成 under-recall，可按授权 collection 分区查询或安全 oversample 后在数据库内过滤；不得以应用层越权取回换取召回率。
- 平台法律排序综合语义、关键词、法源层级、裁判层级、适用法域、程序阶段、争点匹配、效力状态和内容质量；“越新越相关”不作为通用规则。
- workspace 资料排序综合语义、关键词、与当前工作簿/记录关系、用户标注和资料质量。
- 两条检索通道先各自归一化，再由统一重排器合并；原始 vector distance 不能跨索引直接比较。
- 同一法律文书的多来源副本按稳定 content item、来源身份和内容哈希去重，但保留来源差异供引用选择。

### 5. 授权证据注册表

每个进入模型上下文的证据都先登记为不可伪造的 run-local evidence handle，至少包含：

- `source_kind`：`platform_content`、`workspace_resource` 或 `user_context`；
- 稳定 item/resource ID 与精确 version ID；
- dataset release / collection release（平台内容）；
- 标题、来源机构、来源 URL、法律效力与平台发布时间；
- paragraph/article/page 等精确 locator；
- 允许引用的 excerpt、excerpt hash 与内容 hash；
- retrieved_at、content entitlement revision 和许可动作；
- 召回及重排解释所需的有限 score，不向模型暴露授权外候选。

run-local handle 只在该执行窗口有效。持久化消息保存结构化 citation snapshot，不保存 content token、完整平台正文、原始向量或授权外候选。

### 6. 可核验引用

- 模型只能输出 evidence registry 已分配的引用句柄，例如 `[C1]`，不能直接生成 URL、content ID 或来源标题作为权威引用。
- 后处理器拒绝不存在、重复映射错误、版本不匹配或不允许 quote/cite 的句柄，并将合法句柄转换为统一 `LegalCitationDTO`。
- 平台引用固定 content item + version + locator + hashes；workspace 引用固定 resource record + evidence order/hash。
- 直接引文必须来自允许引用的精确 excerpt；转述也必须能够回到证据 locator。
- 法条/案例记载、用户提供事实与模型分析在输出结构中显式区分。模型推断可以有分析标签，但不能伪装成来源事实。
- metadata-only 或 discover-only 候选不能作为实体法律结论的证据。

### 7. 未授权内容发现与套餐推荐

- 未授权全文不进入正常检索 adapter、模型上下文、分数解释或引用。
- 只有来源许可和平台产品策略同时允许 `discover` 时，才查询独立的安全发现索引；该索引只含获准展示的标题、法院、日期、内容范围标签等元数据，不使用锁定全文或其向量泄露实质内容。
- 返回状态区分 `full`、`partial`、`locked`、`unavailable`。`partial` 必须说明缺失的内容范围，不能用已有少量证据冒充完整研究。
- 只有安全发现索引确认相关覆盖存在时，才推荐 Pro 或专业实务模块；推荐应解释新增的 collection/能力，不透露锁定内容摘要或裁判结论。
- 用户拒绝升级后仍可继续使用当前授权资料，不反复插入相同推荐。

### 8. 缓存、暂停和重新授权

- 检索缓存 key 至少包含 query/filter hash、workspace、content entitlement revision、collection release digest、embedding profile 和 ranking revision。
- 命中缓存后仍在读取证据详情前重新执行数据库权限检查；缓存结果不是授权证明。
- collection rolling release、entitlement 变化或 ranking/embedding revision 变化通过新 key 自然失效，不原地修改历史结果。
- workflow snapshot 只保存 query plan、coverage、用户选择、citation snapshot 和必要的 evidence handle 元数据；不保存平台全文、content token 或数据库 session。
- resource-candidates resume 必须用新会话重新读取并授权候选，不能直接信任浏览器回传 ID 或旧 evidence。
- 暂停期间 content entitlement 到期时，恢复返回结构化 `authorization_changed`，再由 08 号生命周期规则决定历史引用展示。

### 9. 失败与降级语义

- 内容权益或授权投影未知：平台语料 fail closed，可继续检索 workspace 私有资料，但必须将 coverage 标为 partial。
- content database 或 content session 不可用：不得假装完成全库研究；返回平台内容暂不可用，并可单独展示私有资料分析。
- 向量索引不可用：在同一授权范围内降级为关键词和结构化检索，并显式报告检索能力降级。
- 没有足够证据：请求用户补充事实或返回未找到，不依靠模型常识生成带权威语气的法律结论。
- 引用校验失败：删除不合格结论或重新生成，不能把裸链接当作校验成功。

### 10. 对现有 Mastra 路径的影响

- `RouterRuntime` 需要从单一 workspace session 扩展为绑定 run 的授权研究 runtime；resume 同样重建 content session。
- `ResourceAgent` 的 `searchResources/getResourceDetail` 将深化为授权语料 Module 的 Adapter，模型不再传 workspaceId 或 collection。
- `ResourceCitationDTO` 需要演进为能兼容 workspace citation 与 platform legal citation 的 discriminated union。
- `resource-candidates` suspend 使用受 run/授权 revision 约束的 candidate ref；恢复时重新授权。
- `manual-research` 保存用户新资料时仍走调用者 workspace session，绝不把平台全文复制为 `resource_item`。
- 额度预留发生在一次收费 AI/研究动作进入 Module 之前，引用读取和已生成成果查看不重复扣费。

### 11. 与后续任务的边界

- 试用用户的 discover 范围和推荐展示由 07 号任务确定。
- 授权到期后历史 citation snapshot 的可见范围由 08 号任务确定。
- 正式 HNSW 参数、索引分区、召回阈值和 ranking weights 需要用真实法律检索集验证，不在本票拍板。
