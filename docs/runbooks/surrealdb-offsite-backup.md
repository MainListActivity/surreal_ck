# SurrealDB 异地备份与隔离恢复

目标为每日一份可验证的异地归档，RPO ≤ 24 小时，数据库恢复与验证 RTO ≤ 4 小时。生产数据规模下的耗时以首次异机演练实测为准。范围为同一实例的所有命名空间和数据库，包括 `_system`、各 workspace、`platform_content` 及同实例上的公司库。对象附件、会议存证文件、IdP、服务环境和签名材料需按各自的备份流程保护。

## 设置与每日执行

1. 在独立故障域创建私有对象存储，启用服务端版本/留存策略。按前缀设置 35 天保留，覆盖最近 7 天每日点及四周以上恢复点。备份使用仅允许该前缀写入和回读的凭证，恢复使用独立只读凭证。关闭公开访问。
2. 在独立恢复环境生成专用 RSA 3072 位或更强的密钥和 X.509 证书。保留证书指纹及轮换记录。生产只持有公钥证书，私钥存入独立密码库，恢复时才经批准暂时取出。证书轮换后，旧私钥至少留到关联归档全部过期。
3. 在已有受限运维执行环境准备 OpenSSL、rclone、Python 3.12+ 和同版公司 fork。scratch 使用 0700，放在加密磁盘上，预留可容纳数据库逻辑导出、转换副本与归档的空间。数据库凭证用 0600 JSON 文件（`user`、`password`）；rclone 配置用 0600。路径由执行用户独占。
4. 复用现有运维定时框架，每日协调快照窗口。应用、后台作业、数据库 HTTP 与存量 WSS 的写入均须被围栏覆盖，数据库读取继续可用。写围栏按 [切换手册](native-quota-release-cutover.md) 验证，确认后才传 `--confirm-fenced-source`。定时框架负责锁、聚合超时与恢复围栏，退出失败进入运维告警。未登记或未获生产维护窗口时，先在隔离环境执行。对有持续写入需求的部署，需另行认证在线一致快照能力。
5. 在窗口执行下列命令。把成功 JSON 放入独立受限回执存储。失败退出码非零，或者上一个核验成功的回执距现在超过 24 小时，均通过现有健康检查告警。脚本会回读异地对象并比较 SHA-256。禁止将 scratch、凭证或 SQL 日志加入上传清单。

```bash
python3 scripts/deploy/surrealdb-offsite-backup.py backup \
  --endpoint http://127.0.0.1:<port> --git-sha <fork-commit> \
  --credentials <root-json> --scratch <encrypted-private-scratch> \
  --certificate <recipient-cert> --rclone-config <private-rclone-config> \
  --remote offsite:<bucket>/surrealdb --confirm-fenced-source
```

导出复用受控逻辑搬迁器，对比导出前后的库目录、记录数和可信配额账本。计数对比不能证明写入已冻结，围栏验证仍是跨库一致性的前提。遇到无法恢复的 root 或 namespace 定义、不可重建的配额状态时停止，本次执行不记成功。定义中被导出机制隐藏的 access 签名密钥需要保管原密钥或制定重签会话计划。

## 恢复与演练

1. 启动与归档 fork SHA 完全一致的新 RocksDB 实例，绑定独立主机的 loopback，使用空目录和 `--no-defaults`，以同名的临时 root 引导。演练实例与生产连接、身份系统、后台任务和流量隔离。
2. 从独立备份回执取得对象名和 SHA-256。执行下列命令。脚本完整核对密文、解密认证标签和每库 SHA-256，再向空目标写入。若检测到被隐藏的 access 签名密钥，只有在接受轮换并完成重签准备后才传 `--allow-access-key-rotation`。
3. 复核 `_system` 工作区路由、代表 workspace 内容及索引、平台内容、公司库目录与记录数。抽查业务权限、OIDC/JWKS、RECORD 会话和原生配额行为。失败时丢弃演练目标，保留独立证据与原归档，用新的空目标重试。正式恢复的流量切换另走批准流程。
4. 每月做一次异机全链路演练，核对备份时点、实际 RPO/RTO、访问审计和清理回执。

```bash
python3 scripts/deploy/surrealdb-offsite-backup.py restore \
  --endpoint http://127.0.0.1:<isolated-port> --git-sha <fork-commit> \
  --credentials <isolated-root-json> --scratch <encrypted-private-scratch> \
  --certificate <recipient-cert> --key <private-key> \
  --rclone-config <read-only-rclone-config> --remote offsite:<bucket>/surrealdb \
  --object <object-from-receipt> --sha256 <digest-from-receipt> --confirm-isolated-target
```

## 隔离演练记录

2026-11-27 UTC 使用 `4.0.1-native-quota.1`（`eab8473e4d4e9f0bfecde6013862ff18a7a676a9`）运行两套临时 RocksDB，经 loopback S3 兼容存储完成上传回读和下载恢复。核对了两个命名空间中四个合成库的记录与唯一索引，密文中未出现样本标记，演练目录已清理。生产异地存储、定时调度、告警和生产数据规模 RTO 待投产验收。

归档 `surrealdb-20261127T082946337568Z.cms` 的 SHA-256 为 `81c62542902037c326c599441ea9f97a77cccdf1cc33a954bc283ac264615f29`。脚本备份耗时 0.66 秒，恢复耗时 0.43 秒。
