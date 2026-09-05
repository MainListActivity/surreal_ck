# 平台内容 schema v1 结构草案

状态：结构设计，未生成或执行 SurrealQL migration。依据 05/12 号决定、content-contract-v1.md 及官方样本；使用 surrealql 技能核对 schema 组织方式。

## 表与约束

| 表 | 主要内容 | 身份与约束 |
|---|---|---|
| content_source | 来源说明 | source_key 唯一 |
| source_license_revision | 来源许可、动作、有效期、依据 | source + revision 唯一，不可变 |
| content_item | 法规/文书稳定身份、current_version | public_id 唯一 |
| content_source_record | 来源记录到内容的映射 | 非空 source + source_record_key 唯一；无源 ID 用候选匹配 |
| content_version | 正文、语义字段、哈希、来源证据 | item + revision 唯一，正文不可变 |
| legal_article_version | 法条、层级、原始条号、定位 | regulation_version + local_key 唯一 |
| content_citation | 引文、位置、主体、采纳语境 | document_version + local_key 唯一 |
| citation_resolution | 候选、核验依据、状态与操作者 | citation + revision 唯一，追加 |
| cites_article（关系表） | 引用到法条版本及核验修订 | 仅已解析目标，支持双向遍历 |
| cites_legislation（关系表） | 引用到法规版本及核验修订 | 仅解析到法规时使用，不捏造条款 |
| ingestion_batch | actor、幂等键、请求哈希 | actor + 操作域 + 幂等键唯一 |
| ingestion_entry | 操作、载荷、目标、版本前提 | batch + entry_key 唯一 |
| validation_revision | 输入哈希、规则版本、错误/警告 | entry + revision 唯一 |
| publication_request | 审阅修订、明确条目、幂等键 | 固定发布范围，重复不重发 |
| publication_item_result | 逐项执行状态、版本及错误 | request + entry 唯一 |
| publication_event | 发布、纠错、撤回、恢复事实 | 追加审计 |

dataset/release/collection 与客户授权投影继续复用 05 号模型，本表不替代完整内容授权模型。

## 一致性与权限

- 不对正文哈希设全局唯一：不同来源/记录可能正文相同。去重结合身份和规范化规则版本判断；案号不作唯一键。
- 法规版本及必需法条作为一致发布单元；大文档可先分批 staging，清单校验完成后切换可服务指针，不暴露半成品。
- 未解析引用保存为 content_citation，不能为建立边伪造法规目标；后续核验追加 resolution 和关系，历史报告仍固定当时证据。
- 关系具有引用属性与双向遍历需求，用关系表；版本/内容、批次/条目等系统归属用字段。
- 撤回/恢复需同时校验 expectedVersionId 和 expectedPublicationRevision；否则同版本已被他人撤回的状态变化不会被发现。inspect 返回此发布状态修订，publish 再次核验。
- 单条发布的当前版本、结果和发布事件同事务一致。外部索引通过持久化事件重试，不声称与外部服务具备原子事务。
- 客户只读可服务投影，不能读取内部批次或修改平台内容。历史版本的不可变性必须通过 schema 权限及受控发布入口验证，不能只靠应用约定。
- MCP 在服务端校验 OAuth actor；publisher 入库审计保留该可信真人 subject 和请求标识，不接受客户端自报 actor。agent 不拿数据库 root。

## 待验证

- 引擎权限、唯一冲突处理、受控发布函数、并发更新/撤回和幂等恢复。
- 真实完整文书及法规通过 MCP 与数据库的往返、条款拆分和索引发布。
- 目前仅完成结构设计与片段定位实验，未进行数据库部署或生产采集。
