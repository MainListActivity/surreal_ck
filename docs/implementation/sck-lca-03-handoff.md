# SCK-LCA-03 实施交接（任务 A）

公司任务 `1494f9cb-e2fe-430b-8b72-c751f9b7b5d4`。范围只到冻结基线、接口和撤权时限。本文不改父 PRD、不改 `ma_hono`、不表示生产已部署，也不能把 03 标成 done。

共享类型在 `shared/src/content-reader.ts`。B 与 C 直接消费该模块；要改字段、错误或 900 秒上限时，先改这个模块并在本文件留下变更说明，再由 D 集成。

## 老板口径与本任务能读到的决定

工程身份读取 G1 `fc5dc61b-b386-4b4e-ab7a-0d2212f3aea6` 的审计返回 `forbidden`，没有读到 `owner_approve` 原文。本任务上下文在拆解任务 `11bcc5fe-c142-425a-9cd2-258a06e958e6` 解锁后写明：八条 Acceptance criteria 都不缩减；最终验收是生产发布之后的逐项真实检查；隔离或合成数据只算开发检查。生产发布、权限、许可和投影状态变更等待 G2 `553ba0a0-79d8-4b72-bdc9-9f8ef1d4bdee` 对具体候选和操作方案的批准。

## 前置基线（代码，不是 done 标签）

| 前置 | 代码事实 | 生产部署 |
|---|---|---|
| SCK-LCA-01 / 02 | `surreal_ck` `main` = `15c49fb933dd473d25498799d5ac2425d959c743`。独立内容库脚本 `shared/sql/platform-content/001`–`005`，产品权益 `shared/sql/system/021-product-entitlement.surql`，解析器 `product-entitlement-v1`。本会话读了这些文件，没有重跑 01/02 的集成测试。 | 未知。交 E / G2。 |
| IDP-LCR-01 | 分支 `feat/content-reader-token-exchange` 与 `main` 同为 `f20b9d5b4fbaaada143a79b2e94b30b022777249`。`content_reader` 不在该提交里。未跟踪文件 `src/domain/tokens/content-reader-policy.ts` SHA-256 `2817960a41751a48152daf66e01ac14f54a72751727517a6c9c53b778daf7dd9`；handoff SHA-256 `1ed484ef05ec97d148f7e3eadae90a64b8c07ead99f2382fdcccda1d99f7e2d9`。`token-service.ts`、`platform-config.ts` 有未提交修改。本会话没有跑 IdP 测试，也没有改 `ma_hono`。 | 未知。未配置 `content_reader_allowed_client_ids` 时，工作区代码会拒绝签发。 |

已核对的 IdP 行为（来自上述未提交源码，不是发布制品）：

- 端点仍是 `POST /scope`（或带租户前缀）。只接受 confidential client。
- 请求 claims 只能是 `ac=content_reader`、`db`、`workspace_id`、`entitlement_revision`、`lease_end`。多键、少键或未知键为 `invalid_request`。
- `workspace_id` 与 `entitlement_revision` 匹配 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`。`db` 匹配 `^[A-Za-z0-9_-]{1,128}$`。
- 成功响应沿用 workspace scope 的 `access_token` / `token_type` / `expires_in` / `scope`，`Cache-Control: no-store`。签发 claims 含 `ac`、`db`、`workspace_id`、`entitlement_revision`，不含 `lease_end`，不含 `RL`。
- TTL = `min(subject 剩余寿命, lease_end - now, 服务端 max TTL)`。默认 max TTL 是 900 秒。代码允许把配置上限设到 86400，应用不得靠提高该配置延长授权。
- `subject_token` 本身已是 `content_reader` 时返回 `invalid_scope`。换票不撤销、不改写浏览器里的工作区 token。
- 错误码：`invalid_client`、`invalid_grant`、`invalid_scope`、`invalid_lifetime`、`invalid_request`、`temporarily_unavailable`。

## 应用换票

浏览器只调用应用自己的接口，不拿 client secret 调用 IdP。请求体只有 `contentPublicId`。`workspaceId`、`entitlementRevision`、`digest`、`leaseEnd`、`ac`、`db`、`subject` 出现即 `client_authority_rejected`。

服务端从当前工作区 token 推导调用者，并在调用 IdP 之前核对：

1. 工作区为 active，且 token 的 `db` 等于该工作区 `db_name`（`ws_` + id）。`workspace_id` 使用这个 `db_name`。
2. 调用者是该库 `user` 中 `kind=human` 且 `disabled_at = NONE` 的成员。没有索引记录是 `not_member`；`disabled_at` 已写是 `member_removed`。管理员和普通成员都要过这一关，管理员不额外获得内容库权限。
3. 当前 `workspace_product_entitlement` 的 `revision` 与 `digest`。`digest` 继续用 `server/src/quota/canonical.ts` 的 `canonicalSha256`（`sha256:` 前缀）。revision 用十进制字符串交给 IdP，例如 `12`。摘要不进 token。
4. 权益 `effective_until`、当前内容来源许可 `effective_until`、subject `exp`。没有宽限。许可行缺失是 `license_unknown`，不按无限期处理。权益或许可截止为空，只说明快照没写截止点，lease 仍不得超过 900 秒。
5. 内容 `publication_status`。`published` 才继续；`withdrawn` 为 `content_withdrawn`；其他状态为 `content_not_published`。集合必须落在当前权益集合里，否则 `collection_denied`。

成功响应使用 `ContentReaderExchangeSuccess`：Bearer 内容 token、`expiresInSeconds`、namespace（现有 `SURREAL_NS`，默认 `main`）、database（现有 `CONTENT_DATABASE`，默认 `platform_content`）、workspace、revision、digest、`leaseEndSeconds`、`contentPublicId`。响应和日志都不带正文。IdP 或应用日志沿用 `idp-scope-adapter.ts` 的脱敏，不记录 token、secret、subject token 或正文。IdP 失败对页面统一为 `idp_rejected`，可另带 `idpError`，不转发 IdP 响应体。

换票失败或成功都不得替换浏览器现有工作区 token 和连接。

## 动作与字段

内容动作以 02 已冻结的 `browse | search | read | cite | export` 为准。AI 动作以 `research | generate` 为准。未知动作是 `projection_incomplete`。

| 边界 | 允许 | 拒绝 |
|---|---|---|
| search | 权益含 `search`。本票不实现 04 的检索入口。 | 不含 `search`。search 本身不打开正文。 |
| read | 权益含 `read`，可读已发布版本的 `body_text` 和法条 `body_text`。 | 否则这两类字段不可读。 |
| cite | 权益含 `cite`，可读摘录和 `quoted_text`。 | cite 不隐含 read。 |
| export | 同时含 `export` 和 `read` 才允许导出能力位。本票不实现导出产品。 | 只有 export 或只有 read 都拒绝导出。 |
| AI 使用 | 含 `read`，且 AI 动作含 `research` 或 `generate`。本票只给出能力位，不调用模型，不扣 05 的额度。 | 缺 read 或缺 AI 动作。 |
| metadata-only | 只有 `browse` 和/或 `search`。可见公开 ID、标题、版本标签、来源、发布状态、授权状态。 | 正文、摘录、法条全文、隐藏字段，包括单条、批量和直接 RecordId。 |
| 隐藏字段 | 无 | `evidence`、`field_issues`、`processing`、`content_kind_payload`、`created_by_subject`、许可 `evidence_text`、凭证哈希、审计与迁移状态。任何动作都不开放。 |

`contentReaderPermissions` 与 `contentReaderFieldAllowed` 是上述矩阵的可执行声明。客户查询只带内容指针、版本和用户选择的过滤条件，不再写一套鉴权 `WHERE`。

## 投影与数据库身份

B 追加 `shared/sql/platform-content/006-*.surql`，使连续版本从 5 变成 6。不要改 001–005。

- 表 `content_authorization_projection`：每个 `workspace_id` 至多一行 active。字段至少包括 revision 字符串、整数 revision、digest、resolver 版本、集合、内容动作、AI 动作、`allowed_subjects`、`confirmed_until`、`status=active|closed`。
- 缺 digest、动作、主体列表或 `confirmed_until` 时不得保持 active。未知事实拒绝扩大访问。
- 写入身份是新的 RECORD access `content_projection_sync`。root 只负责安装 schema 和保管该凭证，不进入客户读取。`content_publisher` 不写客户授权行。客户、工作区管理员和 `content_reader` 都不能写这张表，也不能在内容库执行 DDL/DML。
- `content_reader` 使用 RECORD WITH JWT，时长与现有 publisher 子句相同：`DURATION FOR TOKEN 15m, FOR SESSION 15m`（`005-isolated-publisher.surql`）。禁止抄工作区 participant 的 `DURATION FOR TOKEN 1h, FOR SESSION NONE`。
- 读权限同时要求：token 的 `workspace_id` 与 `entitlement_revision` 等于 active 投影、`$token.sub` 在 `allowed_subjects`、`confirmed_until` 未过、发布状态与来源动作/许可仍成立。投影停止续期后，客户读取不得把 `confirmed_until` 往后推。

## 撤权时限

`contentReaderLeaseEnd`：

`lease_end = min(now + 900 秒, subject exp, 权益 effective_until（若有）, 当前内容许可 effective_until（若有）)`

已到期的权益或许可直接失败，不能发一个仍为正的 lease。900 秒默认值不是“每 15 分钟自动无限续期”的授权；每次换票都要重新做成员、权益、摘要和许可检查。

总收敛：

- 撤权写入成功：投影改为 closed 或从 `allowed_subjects` 去掉该主体后，下一次内容查询由 schema 拒绝。
- 撤权写入没有落地：新读取仍须在 `remainingContentReaderCloseSeconds` 内停止。该值是 token `exp`、数据库会话截止、投影 `confirmed_until` 三者剩余时间的最小值，因此不超过 900 秒。
- 成员移除今天只在工作区 `user.disabled_at` 和 `_system.user_workspace_index.disabled_at` 打时间（`member-manager.ts`），不删除用户，也不撤销已发出的 IdP token。participant 的 AUTHENTICATE 不检查 `disabled_at`。所以旧工作区连接不能当作内容撤权机制。内容换票看到 `disabled_at` 必须拒绝；已建立的内容连接靠投影主体列表和上面的 900 秒上限关闭。

## B / C / D 边界

| 顺序 | 任务 | 可写 | 不可写 |
|---|---|---|---|
| B | `0e1d3ab1-4f94-4750-b92c-18e47ef9f8f0` | `server/` 中换票、投影同步、内容读取相关模块与测试；`shared/sql/platform-content/006`；必要的 system 增量 | C 的 `web/` 文件、`ma_hono`、父规格、把正文复制进客户 workspace |
| C | `203f6330-2f1a-452e-b0dd-0b6e51739f6c` | `web/` 中已知内容指针的入口、阅读页、独立内容连接和组件测试 | `server/`、schema、父规格。共享接口以本文件和 `content-reader.ts` 为准 |
| D | `86b409f0-df70-4293-b2a7-cbb1f728fade` | 集成已验收的 A/B/C。领取人是唯一集成人，在自己的 `task/86b409f0` worktree 解决冲突并固定候选 | 未经 G2 批准的生产部署；抢先把 03 标 done |

C 可以按本接口做页面，但模拟响应不能写成真实联调。真实数据库和浏览器矩阵归 D，生产矩阵不在 A/B/C 的完成定义里。

## 工作量与风险（估计，不是日期）

- B：一条内容库迁移、受限投影写入、服务端换票和 RECORD 正反例。大约三到五次专注实现。最大风险是已建立连接是否在每条查询上重新检查 JWT `exp`；本会话没有对照运行中的引擎证明这一点，B 必须用真实会话做到期和移除后的新读取实验。IdP 尚无提交，也没有生产 allowlist。
- C：工作区入口、第二连接和拒绝页。大约一到两次专注实现。依赖 B 的真实响应后才能称为联调。
- D：合入、锁定依赖、预发布八条 AC。大约一到两次，另加环境准备。预发布样本不是最终验收。

## 仍未知并交给后续关口

- 目标 IdP 是否已部署这份未提交契约，allowlist / max TTL 的生产值。
- `15c49fb` 是否就是当前生产版本，内容库迁移是否已在生产执行。
- 正式内容集合、来源许可和真实客户身份。本契约不把合成 fixture 当成商业内容。
- SurrealDB 对 `TYPE RECORD WITH JWT` 长连接的逐查询 `exp` 行为。
