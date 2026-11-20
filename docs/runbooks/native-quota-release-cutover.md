# Native quota 发布、切换与恢复 Runbook

## 适用范围与不可变前提

本 Runbook 适用于 `MainListActivity/surrealdb` 的
`4.0.1-native-quota.1` 发布线与 surreal_ck 的原生配额切换。它不授权使用
官方 SurrealDB、nightly、tag 或未认证 backend。

每次执行都必须先记录：

- candidate tag、40 位 source SHA、`sha256:` image digest；
- `native-quota-v2.0` compatibility manifest 与 surrealdb-js `2.2.2`；
- RocksDB `native-quota-contract-v1` 认证；
- `_system` 和全部 active workspace 的 snapshot id/checksum；
- 执行人、复核人、变更单和回退负责人。

运行引用只能是：

```text
ghcr.io/mainlistactivity/surrealdb-native-quota@sha256:<64-hex>
```

下游可按项目所有者的明确决定，把 candidate/image 的签名验证记为
`waived_no_certificate`。豁免只覆盖 surreal_ck 下游的两次 verify 操作；digest、
manifest、artifact hash、SBOM、provenance、漏洞、multi-arch、运行时 capability
和 RocksDB 认证仍是硬门禁。生产 acceptance statement 仍由 GitHub OIDC
keyless 签名，SurrealDB promotion workflow 仍会验证候选、镜像和 acceptance
签名；此过程不需要持有长期证书。

## 发布前验收

1. 在 surrealdb fork 的受保护 `releases/sck-4.0` 分支完成 CI 和 candidate workflow。
2. 手动运行 surreal_ck 的
   `.github/workflows/native-quota-release-acceptance.yml`，输入 candidate tag、
   exact SHA 和 exact digest。
3. 首次或无证书环境选择 `waived_no_certificate`，填写原因，并保持
   `dispatch_production=false`。
4. 验收 workflow 必须完成：
   - candidate manifest、CLI、SDK、capability 和全部 hash 交叉校验；
   - amd64/arm64 OCI index、SPDX SBOM、provenance 与 HIGH/CRITICAL 漏洞门；
   - exact digest RocksDB capability smoke；
   - 双仓 E2E、全量 typecheck/test、控制面 lifecycle 集成测试；
   - vanilla 3.2.3 负向启动门；
   - compose digest 解析与应用镜像构建。
5. 在 SurrealDB promotion workflow 中依次完成人工 `canary`、`staging`，确认两个
   signed receipt 已附加到同一 candidate release。
6. 再次运行下游验收，保持相同 tag/SHA/digest，并仅在最终批准后设置
   `dispatch_production=true`。

任何一次重跑出现不同 digest、SHA、release、manifest revision 或 CLI archive，
都视为新的候选，之前的验收与 receipt 不可复用。

## 三阶段切换

### 3.3 → 4.0 存储升级（独立维护窗）

**当前不可直接用于生产升级的制品：** `sck-4.0.1-native-quota.1-artifacts.1`
的 linux-amd64 CLI（tgz SHA256
`3da64bb89fb36daa9f0511e93a22346d9327090272ac791b4566d3126d59aedc`）
可用于 memory schema/SDK 测试，但没有编入 RocksDB；artifacts workflow 两个 Linux
架构都仅传入 `extra-features: jwks,cjk`。生产主机为 aarch64，维护 workflow 使用
ARM64 runner 与 linux-arm64 tgz，固定 SHA256 为
`504b7291084dae1d8bd71750f12965cf64517039423c42c1cfb899bf56bc7325`。

**当前生产阻塞：SurrealKV 可以打开并导入，但不是生产认证后端。** fork manifest
明确将它标为 `hard_quota_certified=false, production=false`，应用启动门禁也拒绝它。
marker 32772 本身不绑定某个引擎；`storage.backend` 与 backend certification 是另外的
硬门禁。不得把存储 marker 正确或导入成功当成生产就绪，不得放宽契约来绕过认证。
默认 `storage_engine=surrealkv` 可用于 check；upgrade 必须先通过生产认证，否则 runner
在任何生产 SSH/停写前拒绝。选择 `rocksdb` 而 binary 不支持时，连 check 也失败关闭。

生产迁移采用**导出到全新目录后导入**，不让 4.0 打开旧 RocksDB 目录。
普通启动不会自动完成 3.3 原地升级；fork 提供的显式 `datastore migrate` 还需要
匹配引擎/构建认证，不能用于这个缺 RocksDB 的 CLI。旧目录保持 32771，新目录由
4.0 初始化 32772。优先提供已晋升的 `target_image=@sha256:...`（必须为完整公司镜像引用），
并将 `target_release` 设为 `sck-4.0.1-native-quota.1`；workflow 验证对应
`promotion-production.json` 的 keyless 签名、digest、release 和下游 acceptance。
没有镜像时，留空 `target_image`，将验证后的 ARM64 binary 只读挂载进原 digest 的
容器作为 entrypoint。此方式不声称旧镜像的 3.3 label 变为 4.0，实际版本/hash/capability
从运行 binary 读取。现有 OCI digest 不自动改变，prerelease CLI 不是镜像晋升证明。
若没有能通过配额生产认证的目标构建，则停止在 check，不进入升级。

双版本正向集成测试仅在显式设置 `SURREAL_PREVIOUS_BINARY`（3.3）与
`SURREAL_4_CERTIFIED_BINARY`（受认证的 4.0 binary）时运行；目标引擎由
`SURREAL_4_CERTIFIED_ENGINE=rocksdb` 指定（默认 rocksdb）。未提供构建时输出明确跳过原因，
不是以迁移拒绝作为成功。提供构建后必须通过生产 capability、全部库导出/导入、表行数和
旧目录重开验证。默认 `SURREAL_BINARY` 仍用于当前 artifact 的 schema/SDK 检查，
不能冒充认证构建；单独的 workflow 沙箱测试断言未认证 backend 在 SSH 前拒绝升级。

1. 在 `main` 手动运行 `SurrealDB maintenance` 的 `mode=check`，填写变更单
   `approval_ref`，经 `production` environment 审批后下载 JSON 报告。核对实际
   ExecStart 路径、脱敏 Podman 参数、容器内 binary hash/version、数据路径/空间与 capability。
   runner 先以所选 `storage_engine` 启动隔离目标容器；打不开则 check 失败关闭。
   check 不上传脚本到主机，不写主机报告，不执行生产 SQL 或停服。
2. 经审批在维护窗准备兼容 4.0 的 origin 发布目录与现有 `server.env`；旧 origin
   不能通过新的启动门禁。**先关闭公网写入并断开已有 WSS、停止 origin，再将
   `current` 指向已通过 Quality gate 的兼容发布目录，不要提前启动它**。
   默认维护模式会检查 `current/shared/src/native-quota/compatibility.ts` 中的
   `forkRelease: "4.0.1-native-quota.1"`，不负责更换 origin 发布目录或 secrets。
   若计划先升级数据库、再用发布 workflow 部署新 origin，则在 upgrade 时明确设置
   `defer_origin_start=true`：允许 `current` 仍为旧版本，脚本不启动它，也不解除写围栏。
   配置 root 所有、不可被组/其他用户写入的
   `/etc/surreal-ck/surrealdb-upgrade.env`，其中
   `SURREAL_UPGRADE_FENCE` / `SURREAL_UPGRADE_UNFENCE` 指向同样受保护的绝对可执行路径。
   fence 必须幂等地阻断公网 HTTP/WSS、新建连接及已有长连接，停止其他写入者，
   只允许主机 loopback 维护连接；执行成功代表围栏已实际生效。仅停 Hono 不够。
   unfence 只在全部验证和 origin 健康检查后开放。围栏的站点具体实现由运营审计，
   未配置或未验证则不得执行 upgrade。
3. 以相同变更单运行 `mode=upgrade`，输入确认文本 `UPGRADE 3.3 TO 4.0`。
   runner 核验 `.txt`、固定 ARM64 tgz hash（或镜像的已签名 receipt）、所选引擎支持与
   native-quota 生产认证，再上传并核验二进制 hash。
   host 只允许 `3.3.0-native-quota.1`；已是目标且 capability 合格时无操作返回。
   root 凭证只从主机 `/etc/surrealdb/surrealdb.env` 读取，不进入参数或 CI 日志。
   主机自带的 3.2.3 CLI 不用于任何导出、导入或核验；源端固定使用
   `podman exec surrealdb surreal export`，目标端使用其实际 entrypoint binary。
4. host 开启围栏、停 `surreal-ck-hono`，以 `INFO FOR ROOT/NS/DB` 枚举所有库，
   包括 `_system`、每个 workspace 和 `platform_content`；导出各库及 SHA256，
   记录各基础表行数（物化视图不作为独立计数基线）。停数据库后保留 ownership
   复制完整 RocksDB snapshot，在另一个路径用旧 digest 的容器做 restore drill 并比对行数。
   备份目录为 `/home/ubuntu/surreal_ck/backups/surrealdb-<UTC>`，权限 0700；另保存原
   `surrealdb.service` 与已有 drop-in。至少留出
   数据大小四倍加 1 GiB 的空闲空间，按数据规模另审实际容量与维护时限。
5. 在全新的 `/home/ubuntu/surreal_ck/data-native-4.0-<UTC>` 路径创建所选引擎。
   目标先只绑定 loopback 隔离端口，核验 capability，再逐 namespace/database 导入
   SQL export 并核对全部表行数。只在导入和验证成功后写入独立 systemd drop-in，
   保留 `surrealdb.service`、Podman 名称、host network、root 与 env-file 约定，
   不覆盖旧 unit 或原 `/home/ubuntu/surreal_ck/data-native`。
   binary fallback 存在版本化 `/opt/surrealdb/releases/<release>/surreal`，只读挂载
   为 `/surreal-upgrade`；不调用主机 PATH 中的 surreal。
   重启正式服务后核验 binary/version/hash、`/health`、manifest、backend 生产认证、
   32772 clean marker 与全部表行数。默认模式再启动兼容 origin，要求
   `http://127.0.0.1:8080/health` 返回 `status=ok,surrealdb=up` 才解除围栏。
   `defer_origin_start=true` 则返回 `database_ready_origin_stopped`，只表示数据库阶段
   完成；origin 保持停止、写围栏保留，不读取旧 `current` 的契约。随后用手动发布流程
   部署已通过 main CI 的兼容 origin 和前端，核验版本与健康，再由运营执行已审计的
   `SURREAL_UPGRADE_UNFENCE` hook。保留的围栏必须允许发布所需的健康检查和维护访问，
   仍阻断公众写入和原有长连接。不能以重跑 upgrade 代替最终解除围栏：已是目标版本
   时仍只读 no-op。新应用启动后可能产生后台写入，不得再自动切回旧数据库；应用或前端
   发布失败应保持围栏并人工向前修复。
6. 失败时保持围栏与 origin 停止。尚未开放新格式业务写入时，恢复原 unit/drop-in，
   用旧镜像重启**从未交给 4.0 的原 RocksDB 目录**，这不是格式降级。
   若必须从 snapshot 恢复，则只恢复到另一个新路径，禁止覆盖旧/新现场；
   绝不让旧 binary 打开新格式目录。运营核验后手动恢复匹配的
   origin 版本并决定开放。开始解除围栏后即视为可能接受新写入，禁止自动回退。
   升级运行在独立 `sck-surrealdb-<run>-<attempt>` systemd 单元；SSH/runner
   中断不是成功。先查主机 `/var/lib/surreal-ck/db-upgrades/<unit>/` 的报告、错误与
   systemd 状态，确认进程/围栏/数据路径后再处理，禁止盲目再次派发。

旧库保持数据库 compatibility level 3；不要为存储升级顺便切换到 level 4。
新建 4.0 库为 level 4，全链从空库应用；有旧行的后续 DDL 如需收紧字段类型，
必须单独设计 `MIGRATE EXISTING ROWS` 与数据处理，不重写已应用的历史 migration。
workspace 063 单独放宽 workbook 模板嵌套列对象，保持自定义字段。

### 阶段一：migration-conductor

1. 冻结旧 manual plan 修改和旧 installer 发布。
2. 生成 inventory 与批准后的 assignment manifest。旧 plan/counter/event 仅是
   discrepancy 证据，不能成为 entitlement 或 native ledger 权威。
3. 停止公网 WSS 和写入，生成 snapshot，并在隔离目录完成一次 restore drill。
4. 用 exact digest fork 启动 RocksDB，执行 format migration。
5. 运行：

```bash
pnpm quota:migration inventory --run <run> --draft <draft.json> --out <inventory.json>
pnpm quota:migration import --run <run> --manifest <approved.json>
pnpm quota:migration prepare --run <run> --evidence <maintenance-evidence.json>
pnpm quota:migration assert-reopen --run <run>
```

`prepare` 必须对 `_system` 和所有 active workspace 完成 REBUILD、独立
table/field/record 物理扫描、native usage 核对、policy materialization 与 fresh
INFO readback。只有 `assert-reopen` 成功才允许恢复公网；此时旧 event 仍保留。

### 阶段二：cohort 与产品切换

顺序固定为：

```text
synthetic_internal → one_percent → ten_percent → fifty_percent → remainder
```

- `synthetic_internal`、`one_percent`：至少观察 24 小时；
- `ten_percent`、`fifty_percent`：至少观察 48 小时；
- `remainder`：通过实时门禁后完成，但仍进入全局 30 日稳定窗。

每个 cohort：

```bash
pnpm quota:migration cutover --run <run> --cohort <cohort>
pnpm quota:migration status --run <run>
# 观察窗完成且无 blocking signal
pnpm quota:migration complete-cohort --run <run> --cohort <cohort>
```

cutover 在单个 database transaction 中 generation-guard reassert 完整 native
policy 并删除旧 event。commit unknown 必须通过 INFO、event 缺失状态和独立扫描
三方读回；无法确定时自动暂停，不得假定已提交。

只有全部 active workspace `native_verified` 后，才可以：

- 开放新计划/订阅/override 运营面板；
- 停止旧 manual scripts；
- 发布只连接 native-quota fork 的 surreal_ck 版本；
- 将 compose/生产配置替换为 receipt 中的 exact digest。

### 阶段三：30 日延迟清理

全部 workspace `native_verified` 后记录：

```bash
pnpm quota:migration cleanup-evidence \
  --run <run> \
  --full-audit-clean-at <ISO> \
  --product-stable-since <ISO> \
  --pre-native-blocked-at <ISO>
```

以 `max(all_native_verified_at, product_stable_since) + 30d` 为最早清理时间。到期后：

```bash
pnpm quota:migration cleanup-ready --run <run>
pnpm quota:migration status --run <run>
```

随后才运行 capability-aware v21 cleanup migration，删除旧 events/tables、
installer、常量和字符串错误。snapshot、candidate evidence、production receipt
及上一生产线恢复材料至少保留 90 日。

## 指标与 abort gate

以下任一信号为零容忍，自动 `pause` 当前 cohort：

- `false_negative`
- `counter_mismatch`
- `ledger_corrupt`
- `structured_error_lost`
- `unknown_drift`
- `cross_workspace_leak`
- `recovery_failed`

还必须持续观察：

| 指标 | 晋级门 | 动作 |
| --- | --- | --- |
| capability/startup/uncertified backend 拒绝 | 0 个误放行 | 立即暂停 |
| unresolved commit outcome | 0 | 立即暂停 |
| rebuild 后物理扫描差异 | 0 | 立即暂停 |
| unexpected denial | synthetic 为 0；其余 15 分钟窗口不高于写入的 0.1% | 超阈值暂停 |
| quota conflict | 5 分钟窗口不高于受保护写入的 1%，且 retry exhaustion 为 0 | 超阈值暂停 |
| 写入 p95 | 相对已批准 RocksDB baseline 回归不超过 20% | 超阈值暂停 |
| HTTP/WSS unknown quota mapping | 0 | 立即暂停 |
| 5xx/连接错误 | 不高于切换前基线 + 0.5 个百分点 | 超阈值暂停 |

非 blocking 的 `unexpected_denial` 或 `performance_regression` 也必须写入 signal：

```bash
pnpm quota:migration signal --run <run> --cohort <cohort> --signal <signal.json>
```

## 暂停、恢复、forward-fix 与回退

暂停：

```bash
pnpm quota:migration pause --run <run> --reason "<reason>"
```

恢复前必须：

1. 固化现场与指标窗口；
2. 对受影响 workspace fresh INFO + 独立扫描；
3. 确认没有 false-negative、半切或未知 drift；
4. 通过同一 digest 的修复验证，或发布一个全新候选并重做验收；
5. 写审计原因后执行：

```bash
pnpm quota:migration resume --run <run>
```

不可安全恢复时：

```bash
pnpm quota:migration abort --run <run> --reason "<reason>"
```

默认恢复策略是 forward-fix。允许的进程回退仅限 manifest 明确声明格式兼容的
native-quota release；禁止回退到 vanilla/旧 fork，禁止原地 data-format
downgrade。

数据回退只能：

1. 保持当前 datastore 隔离且只读；
2. 把维护窗前 snapshot 恢复到新的 datastore 路径；
3. 用相同 native candidate 验证 capability、marker、INFO、独立扫描和 E2E；
4. 在变更批准后切换连接地址；
5. 保留故障 datastore 供审计。

不得把 snapshot 覆盖回正在运行的 RocksDB 目录。

## 最终签字

生产 dispatch 前，变更记录必须包含：

- release owner：tag/SHA/digest/receipt 一致；
- database operator：snapshot restore drill、RocksDB marker、REBUILD/scan 一致；
- application owner：双仓 E2E、lifecycle、错误保真和 compose gate 通过；
- billing/operations owner：Plus/Pro/Max、grace、retention、override 预览正确；
- on-call：指标、pause/abort、forward-fix 与联系人已确认；
- signature policy reviewer：`verify_keyless` 或具名的
  `waived_no_certificate` evidence 已归档。

缺任一项不得设置 `dispatch_production=true`。
