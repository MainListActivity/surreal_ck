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
   unfence 只在全部验证和 origin 健康检查后开放。使用仓库
   [`maintenance-fence` hooks](../../scripts/deploy/maintenance-fence/README.md)，按其安装
   说明将 `fence`、`unfence` 和 helper 安装到 `/usr/local/sbin`；不要让 root 执行
   可被部署用户改写的仓库副本。env 的示例内容为：

   ```dotenv
   SURREAL_UPGRADE_FENCE=/usr/local/sbin/sck-surrealdb-fence
   SURREAL_UPGRADE_UNFENCE=/usr/local/sbin/sck-surrealdb-unfence
   SURREAL_UPGRADE_MEMORY_MAX_MIB=6144
   ```

   fence 停 origin 与 `sck-company-mcp`，备份 root 0600 Caddyfile，仅改
   `data.maplayer.top` 的最后兜底 handle 为 503，validate 后 reload；其他服务路由不改。
   IPv4/IPv6 iptables 丢弃非 lo 的 8000 新连接，最终核对远端 established 与 Caddy
   代理连接均消失，否则拒绝继续。unfence 恢复原配置、validate/reload、删除带专用
   comment 的规则并启动 MCP，**不启动 origin**，要求兼容 origin 已健康。
   备份/state 仅由 root 读取，不上传 artifact；真实 Caddy/网络规则/断连效果必须在批准
   的维护窗核对。未安装或未验证则不得执行 upgrade。
3. 以相同变更单运行 `mode=upgrade`，输入确认文本 `UPGRADE 3.3 TO 4.0`。
   runner 核验 `.txt`、固定 ARM64 tgz hash（或镜像的已签名 receipt）、所选引擎支持与
   native-quota 生产认证，再上传并核验二进制 hash。
   host 只允许 `3.3.0-native-quota.1`；已是目标且 capability 合格时无操作返回。
   root 凭证只从主机 `/etc/surrealdb/surrealdb.env` 读取，不进入参数或 CI 日志。
   导出直接 GET 源 loopback `/export`，导入直接 POST trial loopback `/import`；
   Basic auth 及 `surreal-ns`/`surreal-db` 仅发往本机，不走代理或重定向。
   两端超时 1800 秒，按 1 MiB 分块落盘/上传，不把完整 dump 读入内存。
   主机 CLI 和 `podman exec` 不参与数据传输；旧镜像 restore drill 仅从 snapshot
   启动并经 HTTP 清点，启动入口来自源容器 inspect 的 `[0].Path`。
4. host 开启围栏、停 `surreal-ck-hono`，以 `INFO FOR ROOT/NS/DB` 枚举所有库，
   包括 `_system`、每个 workspace 和 `platform_content`；导出各库及 SHA256，
   记录各基础表行数（物化视图不作为独立计数基线）。停数据库后保留 ownership
   复制完整 RocksDB snapshot，在另一个路径用旧 digest 的容器做 restore drill 并比对行数。
   主机 target version/backend smoke 也在源服务停止并确认退出后才运行；顺序为
   version → backend smoke → restore drill → trial → 正式服务，每个临时容器必须
   确认 `State.Running=false` 且 `State.Pid=0` 后才能删除并启动下一个。
   启动前另查 `/proc`，存在 `surreal` / `surreal-upgrade` 进程（包括手动演练遗留）则拒绝重叠。
   不要在同一主机并行手动启动其他数据库进程；脚本锁不约束外部操作。
   每次临时容器启动前重新读取主机 `MemAvailable`：低于 2 GiB 直接失败；
   `--memory` 与 `--memory-swap` 同为 `min(MemAvailable × 70%, 最大值)`，禁用额外 swap。
   最大值默认 6144 MiB，由上述 root env 的 `SURREAL_UPGRADE_MEMORY_MAX_MIB` 配置。
   临时容器不使用自动删除，先读 `State.OOMKilled`；OOM 会明确报错，确认退出并清理后
   才允许恢复旧服务。停止/inspect/退出确认失败则保持围栏，不启动下一个容器或恢复旧服务。
   workflow 的 preflight 在独立 GitHub runner（不是生产主机）运行，使用相同内存算法；
   上限可用同名 repository/environment variable 配置，退出/OOM 检查必须先于 SSH。
   备份目录为 `/home/ubuntu/surreal_ck/backups/surrealdb-<UTC>`，权限 0700；另保存原
   `surrealdb.service` 与已有 drop-in。每库导出及 `<namespace>--<database>.surql.stderr.log`
   均为 root-owned 0600；导入日志为 `<namespace>--<database>.import.surql.import.stderr.log`。
   HTTP 非 200、空/非 dump 导出、非空导入响应体及可检测的传输截断均拒绝继续；
   导入前仍设置 compatibility 3，导入后须比对基础表计数。
   失败时在主机受控查看日志，正文可能含敏感信息，
   不上传 artifact、不复制到 CI 日志或工单。至少留出
   数据大小四倍加 1 GiB 的空闲空间，按数据规模另审实际容量与维护时限。
   原始导出保持不变；逐库流式生成 `<namespace>--<database>.import.surql`（root-owned
   0600），只移除 `DEFINE ACCESS` 顶层 HS256/384/512 JWT 与 issuer 的 `[REDACTED]`
   key 子句，保留 SIGNIN、DURATION 与 JWKS URL，让目标重新生成签名 key。
   其他位置的占位符或非预期定义格式一律拒绝。`access-transforms.json` 记录每库
   删除子句数及 RECORD access 名称，`SHA256SUMS` 同时覆盖原始与变换文件。
   已签发的 RECORD token 将失效（最长有效期 1h），用户及服务须重新 SIGNIN；
   不承诺保留旧 token。变换文件及其导入日志同样不得上传 artifact。
5. 在全新的 `/home/ubuntu/surreal_ck/data-native-4.0-<UTC>` 路径创建所选引擎。
   目标先只绑定 loopback 隔离端口，核验 capability，再逐 namespace/database 导入
   变换后的 SQL export 并核对全部表行数，用 INFO 确认每个源 RECORD access 定义
   存在且仍为 RECORD。只在导入和验证成功后写入独立 systemd drop-in，
   保留 `surrealdb.service`、Podman 名称、host network、root 与 env-file 约定，
   不覆盖旧 unit 或原 `/home/ubuntu/surreal_ck/data-native`。
   binary fallback 存在版本化 `/opt/surrealdb/releases/<release>/surreal`，只读挂载
   为 `/surreal-upgrade`；不调用主机 PATH 中的 surreal。
   重启正式服务后核验 binary/version/hash、`/health`、manifest、backend 生产认证、
   32772 clean marker 与全部表行数。**本维护窗必须设置 `defer_origin_start=true`**，
   让下述延迟探针在解除围栏前执行。默认 false 会自行启动兼容 origin 并在
   `http://127.0.0.1:8080/health` 返回 `status=ok,surrealdb=up` 后直接解除围栏，
   不适用于此人工延迟比较流程。
   `defer_origin_start=true` 返回 `database_ready_origin_stopped`，只表示数据库阶段
   完成；origin 保持停止、写围栏保留，不读取旧 `current` 的契约。
   先完成下述 4.0 延迟采样与 3.3 基线比较，再用手动发布流程部署已通过 main CI 的兼容 origin
   和前端，核验版本与健康，最后由运营执行已审计的
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

### 维护窗只读延迟探针（3.3 基线 → 4.0，解除围栏前比较）

从已审代码的仓库根目录安装；以下为**生产主机人工执行命令**，不是 CI 自动步骤：

```bash
sudo install -o root -g root -m 0700 scripts/deploy/surrealdb-latency-probe.py /usr/local/sbin/sck-surrealdb-latency-probe
sudo install -d -o root -g root -m 0700 /var/lib/surreal-ck/latency
```

探针选择 HTTP `/sql` 方案：只连接 `127.0.0.1:8000`，不经 Caddy，不跟随重定向、
不使用代理或主机的 3.2.3 CLI。`sample` 必须以 root 运行，凭证只读取
`/etc/surrealdb/surrealdb.env`，要求 root-owned、组至多只读、other 无权限且不是符号链接
（支持生产的 root:ubuntu 0640）。
支持 `SURREAL_USER` / `SURREAL_PASS` 或 `SURREAL_ROOT_USER` / `SURREAL_ROOT_PASS`；
不接受命令行或进程环境凭证，不输出响应正文、查询文本、样本行或凭证。

1. **在 3.3 仍运行、正式停库之前**，按第 2 步安装并执行维护围栏，停止 origin/MCP、
   断开公众 HTTP/WSS 与直接 8000 连接。围栏成功后采集静止数据基线；随后 upgrade
   再次调用 fence 是幂等的。报告目录须保持 root-only，不上传 CI artifacts。

   ```bash
   sudo /usr/local/sbin/sck-surrealdb-fence
   sudo /usr/local/sbin/sck-surrealdb-latency-probe sample \
     --workspaces 5 --repeat 5 \
     --out /var/lib/surreal-ck/latency/3.3-baseline.json
   ```

2. 使用认证镜像运行 upgrade，**`storage_engine=rocksdb`、`defer_origin_start=true`**。
   确认返回 `database_ready_origin_stopped`、容器已在正式端口运行 4.0，且围栏仍在。
   在新 origin 启动前采样相同查询，避免后台写入和不同负载污染比较：

   ```bash
   sudo /usr/local/sbin/sck-surrealdb-latency-probe sample \
     --workspaces 5 --repeat 5 \
     --out /var/lib/surreal-ck/latency/4.0-current.json
   sudo /usr/local/sbin/sck-surrealdb-latency-probe compare \
     /var/lib/surreal-ck/latency/3.3-baseline.json \
     /var/lib/surreal-ck/latency/4.0-current.json --max-ratio 2.0
   ```

3. 比较任一 p50/p95/max 超过基线两倍时退出 1，JSON `worst` 列出最差 20 个指标。
   采样错误、缺少必要库、空 inventory 不视为成功；覆盖范围、索引、样本查询指纹、
   跳过原因或采样设置改变也拒绝通过。保持围栏，人工检查退化/不一致原因并在相同
   数据、负载和设置下复测；不得删去失败条目或用空报告放行。只有通过或明确记录人工
   审核决定后，才继续部署兼容 origin/前端、健康与业务验收，最后执行 unfence。

`INFO FOR ROOT/NS/DB` 枚举所有 namespace/database；采样每个匹配的 `_system`、
`platform_content` 及全局按 database 名称（同名按 namespace）排序的前 N 个 `ws_`
库（workspace 命名约定见 `server/src/workspaces/create-workspace.ts`）。默认 N=5；
`--workspaces 0` 仅采系统/内容库。基础表排除 `AS SELECT` 视图。每表运行
`SELECT count() FROM <t> GROUP ALL`、`SELECT * FROM <t> LIMIT 50`，并从
`INFO FOR TABLE` 推断普通索引首列，用样本中一个值及 `WITH INDEX` 做等值查找。
只推断简单 string/bool/int/float/number（含 option）字段；嵌套、向量、全文、datetime、
record 等不安全推断或空样本的索引项明确标为 skipped，不伪造零耗时。

每条默认 R=5 次串行请求，`--repeat` 调整；`--timeout` 默认 30 秒，写入 SELECT 的
服务端 TIMEOUT 并约束客户端连接。耗时为主机端 HTTP 往返和 JSON 解码的墙钟毫秒，
p50 为中位数，p95 为 nearest-rank（5 次时等于 max），不代表数据库内部执行时间。
完整 count 会扫描数据或索引、读样本会预热缓存；只在批准维护窗运行，保持两侧参数、
停写状态与负载一致。5 次的小样本不是正式压测或 SLA 证明。

JSON 包含 server version、ns/db/表/类别、样本耗时、p50/p95/max 和查询 SHA-256
指纹，不含查询或数据值；指纹不同（包括 LIMIT 样本值变化）时拒绝直接比较。
默认写 stdout，`--out` 新建 0600 文件并拒绝覆盖/符号链接，复测请换新的文件名。

#### 隔离写延迟探针

同一安装脚本提供 `write-sample`。它只在固定 namespace `sck_latency_probe` 下创建
`w_<随机 32 位十六进制>` 临时 database，不接受业务 namespace/database 参数，也不
枚举或写入业务库。namespace 会保留供后续探针复用。每次定义一张 SCHEMAFULL 表
及唯一索引，用固定语句文本与独立 HTTP `/rpc` 绑定参数（兼容 3.3 的 JSON 值类型），
只读查询仍走 `/sql`。测量 CREATE、单条 INSERT、
100 条批量 INSERT、唯一键冲突 `ON DUPLICATE KEY UPDATE`、UPDATE、DELETE。
更新、冲突和删除均使用预置行；准备数据、建库建表、清理不计入耗时。批量耗时是
整批 100 条的往返时间，不是单条耗时；每类默认重复 5 次，可用 `--repeat` 调整。

在 3.3 围栏生效后、升级前采样；在 4.0 升级成功后、启动 origin 和 unfence 前采样：

```bash
sudo /usr/local/sbin/sck-surrealdb-latency-probe write-sample \
  --repeat 5 --out /var/lib/surreal-ck/latency/3.3-write-baseline.json

# 升级后，保持围栏和 origin 停止；不要覆盖基线。
sudo /usr/local/sbin/sck-surrealdb-latency-probe write-sample \
  --repeat 5 --out /var/lib/surreal-ck/latency/4.0-write-current.json

sudo /usr/local/sbin/sck-surrealdb-latency-probe compare \
  /var/lib/surreal-ck/latency/3.3-write-baseline.json \
  /var/lib/surreal-ck/latency/4.0-write-current.json --max-ratio 2.0
```

凭证、loopback 限制、文件权限、脱敏和退出码沿用只读探针规则；此子命令**会写入
临时数据**。无论测量成功与否都会尝试 `REMOVE DATABASE`；清理失败时 `cleanup=failed`、
`complete=false`，退出 1，禁止放行。JSON 保留实际随机 database，比较时仅将已清理
成功的专用临时库规范化为 `w_*`，不将不同业务库当作同一库。不能将写报告与读报告
混比。遇到进程被强杀/主机掉电等无法执行 finally 的情况，保持围栏，由运营核对
报告中的临时库名后清理该库；不得通过删除失败条目规避比较门禁。
compare 可离线执行，不访问数据库或凭证。退出码：0 成功；1 采样不完整、不可比或
超阈值；2 权限/文件/协议/报告格式错误。stdout 和报告仍含库表名称，须按内部运维
元数据保护，不公开传播。探针没有 DDL/DML 写入、重建索引或解除围栏操作。

旧库保持数据库 compatibility level 3；不要为存储升级顺便切换到 level 4。
新建 4.0 库为 level 4，全链从空库应用；有旧行的后续 DDL 如需收紧字段类型，
必须单独设计 `MIGRATE EXISTING ROWS` 与数据处理，不重写已应用的历史 migration。
workspace 068 在 063 元素字段修正之后放宽 workbook 模板嵌套列数组，保持自定义字段。

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

## SurrealDB 4.0 升级验证

开发分支的 server、shared、web 统一固定 SDK 2.2.2。实测 SDK 2.0.8 在连接时拒绝服务端 4.0.1；2.2.2 已在本地临时 fork 实例上通过 HTTP、WebSocket、配额拒绝和 LIVE 通知检查。

这次依赖调整不代表数据库已可切换：发行身份、存储格式和签名候选包校验仍要求现有认证发行线。候选包必须明确认证 SDK 2.2.2 后才允许验收；固定 2.0.8 的旧清单必须拒绝通过。验证期间没有修改生产镜像或生产数据库。
