# RocksDB → TiKV 数据搬迁

本流程仅负责逻辑搬迁，不切换 systemd、流量或写围栏。不直接打开、复制或删除
RocksDB 数据目录，也不检查其他应用的 TiKV keyspace。SurrealDB 没有可见命名空间
不代表 TiKV 没有旧数据：只有已确认专用的空集群才能作为目标。不得在生产数据库
旁做试导、恢复演练或全量校验。

## 开始前

1. 在独立环境使用合成数据演练，并用经过许可的异机备份完成全量恢复演练。核验
   源备份、目标容量、访问限制、复制和故障恢复；生产镜像必须来自同一候选的
   keyless 签名与验收回执，并按 digest 启动。
2. 停止所有业务写入（包括浏览器直连和现有 WebSocket、后台作业），验证写围栏仍
   生效。对仍运行的原 RocksDB 服务只执行读取；保留物理备份和原数据目录。
3. 目标实例仅绑定 loopback，用 `--no-defaults` 启动，以同名 root 账号引导，
   不接入业务。确认目标实例的运行配置和源一致。两个地址都必须使用显式端口的
   `http://127.0.0.1:<port>`。

## 搬迁与验收

在上述前提成立后，以 root 执行
`python3 scripts/deploy/surrealdb-tikv-transfer.py <export|restore|verify>`。
每步提供 `--bundle`、`--endpoint`、`--git-sha`（该实例获准的完整 SHA）与
`--confirm-isolated-and-fenced`。账号从受保护的
`/etc/surrealdb/surrealdb.env` 读取。数据包父目录须由 root 管理；包内 SQL、
元数据和日志按数据库备份保护，异机传输须加密并核验完整性。

- `export` 在源实例生成新的数据包，记录数据库定义、目录、记录数及可信配额用量。
- `restore` 核对 SQL 哈希后仅向空目标写入，恢复配额策略、重建账本并对账。
- `verify` 可在重启后重做目录、记录数和配额用量对账；不会写入目标。

导出隐藏的 access 签发密钥不会被保留；脚本遇到这些定义默认拒绝恢复。
只有在接受密钥轮换并准备好刷新或重签会话后，才给 `restore` 传
`--allow-access-key-rotation`。用真实类型的账号验收密码登录、OIDC/JWKS 和
RECORD 会话，不用 root 代替业务身份。除记录数外还要抽查记录内容、索引、视图、
权限、HTTP、WebSocket、LIVE、重连和硬配额拒绝行为。

任何失败都保留写围栏。不要向部分导入的目标重试，也不要清理未获处置授权的
集群。首次业务写入前可恢复原 RocksDB 服务；目标一旦收到业务写入，旧库会落后，
必须先处理写入差异，不能直接切回。
