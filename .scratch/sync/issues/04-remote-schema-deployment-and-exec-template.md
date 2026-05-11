Status: ready-for-human
Label: ready-for-human

# SYNC-004 — 远端 schema 部署 + execTemplate DDL 代理通道

## Parent

`docs/adr/sync.md`

## What to build

把远端 schema 的部署/升级与客户端 DDL 入口走通。客户端不再直接对远端 DEFINE，所有远端 DDL 通过代理服务 `POST https://auth.maplayer.top/api/db/execTemplate { id, params }` 调用预定义模板。

具体范围：

- 仓库根目录新增 `templates/` 目录。第一批模板覆盖落地必须用到的 DDL：
  - `app.schema-upgrade-v1.sql`：远端首次部署，DEFINE 所有 ADR §6 同步表 + CHANGEFEED + `_origin_session_id` + 注入 EVENT + `schema_version` 表 + 初始数据。
  - `ent.create.sql`：参数 `table_name` + workspace 字段约束，创建一个 ent_* 表（含同步元字段）。
  - `ent.field-add.sql`：参数 `table_name`、`field_name`、`field_type`、`field_assert?`。
  - `ent.field-overwrite.sql`：同上，使用 DEFINE FIELD OVERWRITE。
  - `ent.field-remove.sql`：参数 `table_name`、`field_name`，REMOVE FIELD IF EXISTS。
  - `rel.create.sql`：参数 `table_name`、`from_table`、`to_table`、可选字段集合。
- 远端 `schema_version` 表：
  - 由 `app.schema-upgrade-v1.sql` 创建并 UPSERT 初始版本号 `1`。
  - PERMISSIONS：所有登录用户可 SELECT；create/update/delete NONE（仅 root 通过 execTemplate 修改）。
- 新增 `src/main/sync/exec-template.ts`：
  - `execTemplate(id: string, params: Record<string, unknown>): Promise<void>`
  - POST `https://auth.maplayer.top/api/db/execTemplate`，Bearer 用当前 access_token。
  - 网络错抛 `OFFLINE_DDL_FORBIDDEN`；4xx 抛 `TEMPLATE_REJECTED` 携带 server 错误信息；5xx 抛 `REMOTE_DDL_FAILED`。
- 在 `tryRestoreSession` / `connectRemote` 后增加 schema 版本对账：远端 `SELECT version FROM schema_version:current` 与客户端常量比较，不匹配时进入“本地-only”模式（同步 worker 不启动）+ 在 RPC `getSyncStatus()` 中标识 `incompatibleSchema`。
- maintainer 文档：`templates/README.md` 说明如何把仓库内 `.sql` 模板部署到代理服务（手工操作步骤）。

## Acceptance criteria

- [ ] `templates/` 目录下存在上述 6 个模板文件，参数风格一致、命名一致。
- [ ] `app.schema-upgrade-v1.sql` 内含所有同步表 + CHANGEFEED + `_origin_session_id` + 注入 EVENT + `schema_version` 表。
- [ ] `templates/README.md` 描述 maintainer 部署流程。
- [ ] 远端 schema 通过 maintainer 部署完成（人工动作，本 issue 完成时确认已部署）。
- [ ] `src/main/sync/exec-template.ts` 提供 `execTemplate`，覆盖三类错误分类。
- [ ] 客户端启动版本对账：版本一致时正常进入；不一致时 `getSyncStatus().incompatibleSchema = true`，业务读路径仍可用，写路径在状态栏强提示但本 issue 不做禁用（禁用在后续 slice 中）。
- [ ] 单测覆盖：`execTemplate` 三类错误的 mock。

## Blocked by

- `.scratch/sync/issues/02-sync-meta-tables-and-session-id.md`
