# 平台内容维护契约 v1 草案

状态：可评审草案，尚未实现；需与 [真实样本](legal-content-samples.md) 一起评审。继承 [12 号决定](../issues/12-legal-content-ingestion.md)，不改变已确认五工具范围。

## 与现有模型的衔接

现有 shared/src/research-save.ts 将 legal_case/legal_article 标为未启用的用户资源预留类型；本契约属于独立平台内容域，不解锁 workspace resource_item 来承载平台全文。复用 05 号 content_item/content_version/content_source，法规与文书作为类型化内容，不再重复维护平行目录。

## 统一约定

- 请求与响应使用 camelCase JSON；contractVersion 为固定版本字符串 `1`。公开 ID 均为服务端返回的不透明字符串，不暴露或接受数据库 RecordId 语法。
- 时间戳用带时区的 RFC 3339；公布、生效、裁判等纯日期用 YYYY-MM-DD，禁止隐式转成 UTC 午夜。日期不完整时保留原文 dateText，精确日期填 null，不补造月份或日期。
- 必填语义字段未知时以 null + 对应 fieldIssues 表明 unknown/ambiguous；字段遗漏、类型错误与业务未知分开处理。来源、标题、正文和采集时间等已确定的必需接收信息缺失则条目阻断。
- fieldIssues 包含字段路径、问题代码、简短说明及可选证据定位。模型置信度不作为核验通过的依据。
- sourceKey 是已登记来源的公开键；未知来源返回 source_not_registered。来源登记和许可配置放在 ops 最小管理能力，不增加第六个 MCP 工具，也不允许 submit_batch 自行授予来源许可。
- 首期建议限制每批 50 项、JSON 请求 5 MiB；get_data_contract 返回实际生效限制，客户端超限自行拆批。正文过大不得静默截断，返回明确错误；这些数值为待实现验证的运行默认值。
- 原始附件暂用引用元数据，不在 JSON 嵌入大体积 base64。服务端不自动访问任意附件 URL；若后续加入文件上传，另定传输和校验契约。

## 提交信封

submit_batch 接受 contractVersion、idempotencyKey、可选 supersedesBatchId 和 items。每条 item 有本批唯一 entryKey、operation、对应操作载荷。新增与更新使用 operation=upsert；withdraw/restore 使用目标操作载荷。

- 幂等键按当前运营身份与操作域隔离；同键同规范化请求返回同一批次，同键不同请求返回 idempotency_conflict。
- upsert 携带 kind、source、document 和可选 target。target 明确 itemId/expectedVersionId，用于修改已知内容；新内容由服务端去重，不接收客户端指定最终身份。
- withdraw/restore 携带 target、reason 和可选 evidenceRefs，不要求重传正文。恢复指向既有内容版本，不能借恢复上传新正文。
- expectedVersionId 表示操作者审阅时的当前版本前提；前提变化返回 stale_version，不能覆盖其他运营的新发布。
- 同批多次修改同一内容目标视为冲突，要求客户端拆分或合并意图；不依赖输入顺序隐式覆盖。

## 共通内容载荷

| 字段 | 含义与约束 |
|---|---|
| source.sourceKey | 已登记来源 |
| source.url | 原始发布页面或文件地址；不单独充当跨来源稳定身份 |
| source.recordKey | 来源自己的记录标识，可 null；无标识时由服务端计算指纹辅助识别 |
| source.fetchedAt | 客户端取得该来源内容的时间；服务端另记 receivedAt |
| source.publishedAt / updatedAt | 来源明示的页面发布时间/更新时间，可 null；只有日期时用 publishedOn/updatedOn，时区不明保留 dateText，不编造时间；不得填成裁判或法定生效时间 |
| document.title / bodyText | 标题和完整清洗正文；bodyText 不接受摘要冒充全文 |
| document.sourceForm | full_text / excerpt / case_summary / amendment_notice；限定对应文档实质，摘要不能作为完整裁判文书发布 |
| document.evidence | 来源证据摘录或允许留存的原文、可选附件元数据；正文和来源证据分离 |
| document.fieldIssues | 未知、歧义及处理说明 |
| document.processing | 处理方法/版本、可选 agent/model 标识及清洗说明；不包含内部思维链、令牌或凭证 |
| document.clientDigest | 客户端可选声明；服务端自行复算正文/证据哈希 |

sourceForm 为 excerpt/case_summary 的数据可进入待处理批次，但首期不作为完整法规/裁判文书发布。若要销售摘要型独立内容，应另立类型，不自动放宽全文要求。

## 法规载荷

kind=legislation；附 legislation 对象：issuingAuthorities、instrumentType、documentNumber、promulgatedOn、effectiveOn、repealedOn、legalStatus、versionLabel、versionResolution、amendsRefs。

- 发布机关和规范类型按已确认最小要求提交，无法确定时给出 fieldIssues；法规版本无法确定标记 unresolved，不自动采用当前最新版本。修订合并文本末条可能保留最初施行日，版本生效时间必须关联修订依据，不能直接取正文最后一个日期。
- legalStatus 使用 effective/not_yet_effective/repealed/partially_effective/unknown 等受控值建议；状态必须有 evidenceRef，不能单凭日期推测法规全部失效。
- 修订决定和被修订法规是不同内容项，amendsRefs 表达关系；不是把修订决定正文直接覆盖目标法规。只有取得完整合并文本或完成有证据可核验的版本重建后，才可发布完整新法规版本。
- 可提交条款候选 articles，每项保存原始条号 label、层级路径、正文位置及可选有效时间。未提交候选时服务端解析；结构有歧义则待核验，禁止只用简单换行或“第X条”匹配将引文误拆为条款。
- 法条版本身份属于法规版本；跨修订的条号相同不自动表示同一条款，条款沿革单独记录。

## 裁判文书载荷

kind=judicial_document；附 judgment 对象：documentType、caseNumber、court、decidedOn、causeOfAction、instance、procedure、outcome、citationExtractionStatus、citations。

- documentType 必须有明确值或待核验说明；案号和法院可未知但必须标明。caseNumber 不是全局唯一键。
- instance/procedure 从来源抽取，不按案号字符串或某个法院层级盲目补齐。outcome 为可选结构化提取，不替代裁判正文。
- citationExtractionStatus 区分 not_processed/processed_none/processed_partial/processed_complete。citations 空数组不等于文书没有引用。
- 典型案例、指导案例介绍与原始裁判文书区分；官方来源身份不意味着页面一定包含完整原文。

## 引用与定位

每项 citation 包含 localCitationKey、relationKind、speaker、quotedText、locator、rawLawName、rawArticleLabel、resolution 和可选候选目标。

- relationKind 区分 explicit_citation 和 inferred_relation；speaker 区分 court/party/editor/other/unknown。系统推断只能属于 inferred_relation；指导案例的编辑注释和现行法对照归入 editor，不得归入法院原文依据。
- locator 固定于接收版本的 bodyText：UTF-8 字节起止区间 [start,end)，服务端验证边界合法且对应 quotedText；同时可提供原始页码/段落/条号作为 sourceLocator。
- 规范化只在计算定位前完成。服务端若改变正文，必须重新计算定位并形成新的校验修订，不能沿用失效 offset。
- locator 绑定 bodyDigest；重复引文不得自动取首个匹配，必须提供明确位置。清洗和换行变化使旧定位失效。
- resolution 区分 unresolved/ambiguous/proposed/verified；客户端最多提交 proposed 和候选 item/version/article ID，verified 由服务端证据校验或可审计人工核验产生。
- 历史文书中的旧法引用不自动重连新法，判断版本所需证据不足时保持 unresolved/ambiguous。
- 可选 treatment 表达 applies/rejects/discusses/unknown，必须附所在材料的原文证据；明确引用不等于法院采纳。同一法条在不同主体和不同语境中的引用分别保存。

## 样本验证状态

- 公司法版本与指导案例样本支持上述日期精度、条款版本及 editor/party/court 区分，证据链接见 [样本研究](legal-content-samples.md)。
- 已读取的指导案例是整理稿，不是原裁判文书全文；公报详情未取得，不能用搜索摘要宣称完成全文验证。
- 2026-09-05 已通过网页读取核实 CICC（2022）最高法商初7号完整公开判决文本；网页发布 2024-09-04，裁判日 2024-01-24。同文明确出现不同修订年份的民诉法引用，版本候选必须逐引用解析。
- 本地直接 HTTP 请求该页发生重定向循环；未取得可复现的原始全文快照。网页可读不等于已验证稳定采集接口。
- [定位实验](verify-citation-locator.mjs) 使用真实短引文及合成前后文，通过 UTF-8 位置、正文哈希、中文/emoji 字节边界、旧定位失效、重复引文及换行变化检查。它不代表完整文书哈希、MCP 或数据库端到端验证。
- 全文提交、来源资格、数据库事务及法规拆分仍需实施验证。

## 五工具输入输出

| 工具 | 主要输入 | 主要输出 |
|---|---|---|
| get_data_contract | 可选 contractVersion | 当前契约、操作分支、字段说明、示例、限制、可用来源及分页入口说明 |
| search_content | filters、cursor、limit | 稳定 itemId、版本摘要、来源、发布状态与 nextCursor；包括用于匹配的受权法规条款详情，正文按限制返回 |
| submit_batch | 提交信封 | batchId、receivedAt、逐条接收结果、当前处理状态 |
| inspect_batch | batchId、cursor、limit | validationRevision、逐项错误/警告、内容差异、可发布 entryKey、当前发布结果与 nextCursor |
| publish_batch | batchId、validationRevision、entryKeys、idempotencyKey | publicationId、逐项结果/执行中状态；异步结果继续通过 inspect_batch 读取 |

- tool 调用中的 actor 由 OAuth 注入，客户端不能传 subject 来选择身份。
- inspect 分页必须固定校验修订；翻页期间有新修订则明确返回版本变化，不把不同修订结果拼接。
- publish 对明确清单逐项执行，重新校验权限、来源资格、校验修订与版本前提。结果区分 published/unchanged/blocked/failed/pending；失败可幂等恢复。
- sourceKey 枚举可在 get_data_contract 中按 sourceCursor 分页，避免引入无法发现的新来源配置或无限大工具返回。

## 校验与错误

协议级无效请求与业务级条目错误分开。业务错误返回 code、entryKey、fieldPath、message、retryable 和可选相关版本标识，避免客户端猜测。

建议固定错误类别：unsupported_contract、payload_too_large、source_not_registered、source_not_authorized、required_field_missing、locator_mismatch、identity_ambiguous、stale_version、validation_stale、idempotency_conflict、publish_failed。

- 关联待核验为警告；正文缺失、证据位置不匹配及来源资格不满足为阻断。
- 前端字段可空与可发布规则不是同一件事；本草案不把所有可选元数据变成发布硬门槛。
- 发布即取当前可服务许可，审核时许可有效但发布时到期必须拒绝。
- 对网页证据只验证内部一致性无法证明来源真实性；需记录人工核验/来源获取证据状态，不把通过 JSON 校验标成官方认证。

## 数据库存储映射草案

| 外部概念 | 复用/新增逻辑存储 |
|---|---|
| 来源与许可 | content_source + source_license_revision |
| 稳定法规/文书身份 | content_item，kind 区分 |
| 不可变正文与专属字段 | content_version，类型化 legislation/judgment 载荷 |
| 法条拆分 | 法条版本实体，归属精确法规 content_version |
| 文书法条引用 | 独立引用关系实体，起点文书版本，解析后指向法条/法规版本；未解析时仍保存证据 |
| 提交与校验 | 批次、条目及不可变校验修订 |
| 发布与撤回/恢复 | publication_event，与既有 dataset_release/可服务投影衔接 |

表名、索引、事务与 SurrealQL 权限尚未定稿；后续实现须加载 surrealql 技能并用真实样本测试。此文件不是已部署 schema，也不是已经验证的完整爬取契约。
