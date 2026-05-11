# Sync DDL Templates

这些文件是 `POST https://auth.maplayer.top/api/db/execTemplate` 的模板源。客户端只提交 `{ id, params }`，远端代理负责校验参数、替换标识符、以 root 权限执行模板。

维护流程：

1. 修改本目录 SQL。
2. 用 maintainer 凭证把模板部署到代理服务，模板 id 等于文件名去掉 `.sql`。
3. 部署 `app.schema-upgrade-v1.sql` 后，确认远端 `schema_version:current.version = 1`。
4. 客户端启动会读取 `schema_version:current`；版本不一致时进入本地-only 模式。

动态标识符参数（如 `table_name`、`field_name`）必须由代理服务做白名单校验后再替换，客户端不会直接向远端发送 `DEFINE`。
