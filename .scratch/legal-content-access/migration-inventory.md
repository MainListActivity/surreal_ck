# SCK-LCA-01 内容库迁移清单与切换步骤

## 现有路径

旧 shared/sql/platform-content/001–004 由 server/src/content/schema.ts 应用到 _system。
server/src/content/store.ts 承载来源登记、许可修订、批次校验、发布请求、版本、
撤回/恢复和搜索；此前 server/src/app.ts 用共享 root 连接装配 store。
server/src/startup.ts 的引用解析也曾用 root 在 _system 运行。
运营 HTTP /api/content/*、运营站点 ops/src/main.js 和五个 MCP 内容工具
最终都调用同一个 PlatformContentService。平台运营身份和能力权威留在
_system.platform_operator / platform_operator_capability。

## 迁移范围

下列 18 张表由 CONTENT_MIGRATION_TABLES 明确列出，按依赖顺序迁移并核对每一行。

| 类别 | 表 |
| --- | --- |
| 来源与许可 | content_source, source_license_revision |
| 内容身份与版本 | content_item, content_source_record, content_version, legal_article_version |
| 引用关系 | content_citation, citation_resolution, cites_article, cites_legislation |
| 接收与校验 | ingestion_batch, ingestion_entry, validation_revision |
| 发布与审计 | publication_request, publication_item_result, publication_event, content_publication_projection, platform_content_audit_event |

新库另有 platform_content_schema_version、content_publisher_identity、
content_publisher_credential、content_migration_state；这些不从 _system 复制。
迁移保留原 record ID、公开 ID、全文及哈希、来源许可、发布状态、批次幂等键和引用边 ID。
逐表比较数量与每行字段，并确认每个类型化内容引用的目标记录存在；
updated_at / last_seen_at 是 schema 计算时间，比较时忽略。
已有目标记录必须与源记录相符，重跑不会重复创建版本或发布事件。

## 切换

1. 在隔离的测试 namespace 用合成许可来源完成法规、文书、撤回和恢复演示。
2. 停止旧服务的全部内容写入者，包括运营 HTTP/MCP 与后台发布作业。保持冻结直到新服务接流量。
3. 配置 CONTENT_DATABASE=platform_content 和至少 32 位的 CONTENT_PUBLISHER_SECRET。
   运行 pnpm --filter @surreal-ck/server run content:migrate -- --writes-frozen。
   失败后保持冻结，修复原因并重跑同一命令；不清空目标库。
4. 脚本在所有表通过数量和字段核对后才写 content_migration_state:legacy。
   启动逻辑发现 _system 仍有旧内容而无该标记时拒绝接流量；有标记时仍
   重新核对每条旧记录及其引用端点。目标库切换后新增的合法记录允许保留，
   旧库漂移、旧记录缺失或断链会拒绝启动。
5. 部署新服务并验证受限 publisher 登录、运营页面和五工具、拒绝 DDL/版本篡改。
   只有上述结果满足后解除写入冻结。旧 _system 内容保持原状作为可审计副本；
   清理由独立工单批准与执行。

切换后新增合法写入只存在新库。回滚应用版本时必须让旧应用继续连接新库，
或者先将新增记录反向迁回并核验；直接切回 _system 会丢失这些写入。
迁移时若来源仍可写，逐表比对无法证明最终一致，因此不得跳过冻结。

## 验证边界

2026-09-24 在 `MainListActivity/surrealdb` 的 `sck-3.3.0-native-quota.1-candidate.105`
Linux arm64 release 二进制上，以 RocksDB 运行测试；该候选版已晋级正式
`sck-3.3.0-native-quota.1`。二进制 SHA-256 为
`8a946791f52af63bfbe3c51a5a28b7f5d7d3fdabcef7d6ba6c2df5da680de490`，
与 release 附带校验文件一致，版本报告为
`3.3.0-native-quota.1+sha.f30704bce914`。

测试命令（`LOCAL_SURREAL_URL` 指向该 release 的本地实例）：

```sh
RUN_LOCAL_PLATFORM_CONTENT_TESTS=1 RUN_NATIVE_QUOTA_PLATFORM_CONTENT_TESTS=1 \
LOCAL_SURREAL_URL=ws://127.0.0.1:8998/rpc \
SURREAL_URL=ws://127.0.0.1:8998/rpc SURREAL_ROOT_USER=root SURREAL_ROOT_PASS=root \
OIDC_ISSUER=https://idp.example.test OIDC_JWKS_URL=https://idp.example.test/jwks \
OIDC_AUDIENCE=test IDP_HOOK_SECRET=test-secret \
pnpm --filter @surreal-ck/server exec bun test \
  src/content/store.integration.test.ts src/content/migrate-legacy.integration.test.ts
```

连续五次均为 2 pass / 0 fail。合成整份法规与文书、法条引用边、运营 HTTP
合同入口、五个 MCP 工具、客户 403、publisher DDL/已发布版本拒写、并发同键发布、
迁移半途失败后的重跑与重复执行均通过。客户 workspace 的原生 record quota
设为 0，写入被引擎以 `quota_exceeded` 拒绝；内容库发布仍成功，工作区 quota
usage 前后相等。`pnpm run lint`、`pnpm run typecheck`、`pnpm run build:ops` 通过。

生产数据迁移与运营 OIDC 交互仍应在实际部署时按“切换”步骤执行；本次未接触生产
数据库、真实许可资料或真人登录，不将合成内容视作真实法规/文书。
