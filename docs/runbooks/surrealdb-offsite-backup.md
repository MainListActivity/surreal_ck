# SurrealDB 异地备份与隔离恢复

目标为每日一份可验证的异地归档，RPO ≤ 24 小时，数据库恢复与验证 RTO ≤ 4 小时。首次生产全量归档与异机演练的耗时已记录在下方回执。范围为同一实例的所有命名空间和数据库，包括 `_system`、各 workspace、`platform_content` 及同实例上的公司库。对象附件、会议存证文件、IdP、服务环境和签名材料需按各自的备份流程保护。

## 设置与每日执行

1. 在独立故障域创建私有对象存储，启用服务端版本/留存策略。按前缀设置 35 天保留，覆盖最近 7 天每日点及四周以上恢复点。备份使用仅允许该前缀写入和回读的凭证，恢复使用独立只读凭证。关闭公开访问。
2. 在独立恢复环境生成专用 RSA 3072 位或更强的密钥和 X.509 证书。保留证书指纹及轮换记录。生产只持有公钥证书，私钥存入独立密码库，恢复时才经批准暂时取出。证书轮换后，旧私钥至少留到关联归档全部过期。
3. 在已有受限运维执行环境准备 OpenSSL、rclone、Python 3.10+ 和同版公司 fork。scratch 使用 0700，放在加密磁盘上，预留可容纳数据库逻辑导出、转换副本与归档的空间。数据库凭证用 0600 JSON 文件（`user`、`password`）；rclone 配置用 0600。路径由执行用户独占。
4. 复用现有运维定时框架，每日协调快照窗口。应用、后台作业、数据库 HTTP 与存量 WSS 的写入均须被围栏覆盖，数据库读取继续可用。写围栏按 [切换手册](native-quota-release-cutover.md) 验证，确认后才传 `--confirm-fenced-source`。定时框架负责锁、聚合超时与恢复围栏，退出失败进入运维告警。未登记或未获生产维护窗口时，先在隔离环境执行。对有持续写入需求的部署，需另行认证在线一致快照能力。
5. 在窗口执行下列命令。把成功 JSON 放入独立受限回执存储。失败退出码非零，或者上一个核验成功的回执距现在超过 24 小时，均通过现有健康检查告警。脚本会回读异地对象并比较 SHA-256。禁止将 scratch、凭证或 SQL 日志加入上传清单。

生产 TiKV 实例使用 `--backend tikv`。脚本核对 `/capabilities` 报告的后端、认证状态和运行实例 Git SHA。回执中的 `backend` 与 `fork_sha` 记录本次操作连接的实例。省略 `--backend` 时按 RocksDB 校验。

```bash
python3 scripts/deploy/surrealdb-offsite-backup.py backup \
  --endpoint http://127.0.0.1:<port> --backend tikv --git-sha <source-fork-commit> \
  --credentials <root-json> --scratch <encrypted-private-scratch> \
  --certificate <recipient-cert> --rclone-config <private-rclone-config> \
  --remote offsite:<bucket>/surrealdb --confirm-fenced-source
```

导出复用受控逻辑搬迁器。导出前采集完整的库目录、记录数和可信配额账本，逐表检查按库批量请求。目录采集和逻辑导出各最多并发 4 个库。导出后重查命名空间、库及表目录和可信配额账本，记录数在恢复时与导出前清单核对。整个窗口需要有效的写围栏，目录和配额校验只覆盖可观察的变化。遇到无法恢复的 root 或 namespace 定义、不可重建的配额状态时停止，本次执行不记成功。定义中被导出机制隐藏的 access 签名密钥需要保管原密钥或制定重签会话计划。

新归档先用一级 gzip 压缩，再用 CMS AES-256-GCM 加密。恢复支持压缩归档及旧的未压缩归档，回执 SHA-256 仍校验密文对象。

## 恢复与演练

1. 启动同版且后端已认证的公司 fork，绑定独立主机的 loopback，使用空存储和 `--no-defaults`，以同名的临时 root 引导。归档使用逻辑 SurrealQL，可跨认证后端恢复。异机 RocksDB 演练使用 `--backend rocksdb`，`--git-sha` 填写恢复目标运行的 Git SHA。演练实例与生产连接、身份系统、后台任务和流量隔离。
2. 从独立备份回执取得对象名和 SHA-256。执行下列命令。脚本完整核对密文、解密认证标签和每库 SHA-256，再向空目标写入。若检测到被隐藏的 access 签名密钥，只有在接受轮换并完成重签准备后才传 `--allow-access-key-rotation`。
3. 复核 `_system` 工作区路由、代表 workspace 内容及索引、平台内容、公司库目录与记录数。抽查业务权限、OIDC/JWKS、RECORD 会话和原生配额行为。失败时丢弃演练目标，保留独立证据与原归档，用新的空目标重试。正式恢复的流量切换另走批准流程。
4. 每月做一次异机全链路演练，核对备份时点、实际 RPO/RTO、访问审计和清理回执。

```bash
python3 scripts/deploy/surrealdb-offsite-backup.py restore \
  --endpoint http://127.0.0.1:<isolated-port> --backend rocksdb --git-sha <target-fork-commit> \
  --credentials <isolated-root-json> --scratch <encrypted-private-scratch> \
  --certificate <recipient-cert> --key <private-key> \
  --rclone-config <read-only-rclone-config> --remote offsite:<bucket>/surrealdb \
  --object <object-from-receipt> --sha256 <digest-from-receipt> --confirm-isolated-target
```

## 首次生产备份与异机恢复

2026-11-27 UTC，生产 TiKV 在写围栏内完成首次全量加密异地备份。使用包含 [PR #332](https://github.com/MainListActivity/surreal_ck/pull/332) 的版本（`c92bea36`），以 R2 只读权限拉取同一密文，在 Mac 的空白隔离 RocksDB 实例完成恢复。两个命令均以退出码 `0` 结束。

| 项目 | 回执 |
| --- | --- |
| 密文对象 | `surrealdb-20261127T121836061943Z.cms`，202,381,029 字节（约 193 MiB） |
| 异地目的地与留存 | Cloudflare R2 `surreal-ck-offsite-backup/surrealdb/`，`expire-35d` 保留 35 天 |
| 加密与密钥 | gzip 后以 CMS AES-256-GCM 加密。RSA-3072 公钥证书指纹 `BB:A9:6F:57:59:DC:81:24:F8:EA:90:C2:47:04:1C:61:87:10:F4:E8:81:A0:13:D2:EB:14:16:FA:BF:99:E4:5E`。私钥以 `0600` 权限离线保管 |
| 密文 SHA-256 | R2 回读及恢复校验一致，`b7ca58316ae2edbe7d659dac38143d96dddeb0059e58ce16ade20f940be041e2` |
| 生产备份 | `status: ok`，`mode: backup`，`backend: tikv`，`fork_sha: 4a338150330d89f62c6a98d20ace7f8c6c2b48b4`，耗时 342.26 秒（约 5.7 分钟） |
| 隔离恢复 | `status: ok`，`mode: restore`，`backend: rocksdb`，`fork_sha: eab8473e4d4e9f0bfecde6013862ff18a7a676a9`，耗时 227.52 秒（约 3.8 分钟） |
| 全量对账 | 15 个 namespace / 72 个 database 全部通过。记录数、表结构、索引、事件及配额账本核对零差异 |
| 生产恢复与清理 | 解除围栏后，`l.maplayer.top/health`、`company.maplayer.top`、`www.maplayer.top` 均返回 200。演练临时库与目录已清理，`DRILL_CLEANED=true` |

### RPO、RTO 与每日调度

- 本次验证的恢复点对应归档标识 `2026-11-27T12:18:36.061943Z`，恢复后与该围栏快照的记录数及关键定义对账零差异。日常 RPO 目标为 ≤ 24 小时，待每日连续归档后按相邻成功回执的恢复点间隔实测。
- 实测全库恢复 RTO 为 227.52 秒，涵盖从 R2 拉取、校验、解密、导入及全库对账，达到 ≤ 4 小时目标。本次为隔离恢复计时，业务流量切换另行计时。
- 手工生产备份和跨机恢复均已通过。每日调度待挂接既有运维定时框架，复用写围栏、互斥锁、失败告警及超出 24 小时未产生可核验回执的告警。挂接后以首次定时触发的真实回执验收。

## 隔离演练记录（合成数据）

2026-11-27 UTC 使用 `4.0.1-native-quota.1`（`eab8473e4d4e9f0bfecde6013862ff18a7a676a9`）运行两套临时 RocksDB，经 loopback S3 兼容存储完成上传回读和下载恢复。核对了两个命名空间中四个合成库的记录与唯一索引，密文中未出现样本标记，演练目录已清理。

归档 `surrealdb-20261127T082946337568Z.cms` 的 SHA-256 为 `81c62542902037c326c599441ea9f97a77cccdf1cc33a954bc283ac264615f29`。脚本备份耗时 0.66 秒，恢复耗时 0.43 秒。
