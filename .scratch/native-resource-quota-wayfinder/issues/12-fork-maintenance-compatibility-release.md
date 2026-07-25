Status: done
Label: done
Assignee: /root

# 确定定制 SurrealDB 的维护、兼容与发布策略

## Parent

[`SurrealDB 原生配额与 surreal_ck 订阅控制面决策地图`](../PRD.md)

## Question

这项能力作为长期私有 fork、可上游化扩展还是分阶段两者并行维护？需要锁定 upstream 同步节奏、feature/version 标识、数据格式与 downgrade 兼容、镜像发布、surrealdb-js/CLI 兼容边界、schema migration 所依赖的最低引擎版本，以及 surreal_ck 如何探测原生配额能力而不是误连 vanilla SurrealDB。

## Dependencies

- Blocked by: [`摸清 SurrealQL 资源定义与权限扩展面`](01-surrealql-resource-definition-extension.md)、[`摸清 SurrealDB 写路径与事务内计量扩展面`](02-surrealdb-transactional-enforcement-extension.md)、[`设计原生配额 SurrealQL、错误与可观测契约`](08-native-surrealql-errors-observability.md)
- Blocks: [`锁定迁移回填、双仓发布与端到端验收`](13-migration-rollout-acceptance.md)

## Comments

### 2026-07-25 — 已确认的私有生产 fork 与分层上游化双轨

- MainListActivity 私有 fork 是 surreal_ck 生产环境的引擎权威，产品发布不等待官方 upstream 接受 quota。
- fork 内核只包含商业概念中立的 policy、usage、transactional enforcement、INFO/REBUILD、error 与 capability contract，不出现 Plus/Pro/Max、价格、订阅或 surreal_ck 业务表。
- 可独立审查的 parser/catalog/IAM、结构化错误保真、事务 counter/fencing 等基础能力优先拆分上游，完整 quota resource 最后评估；upstream 拒绝或延迟不阻塞私有路线。
- 私有改动保持为集中、可重放、可测试的提交序列，不能把 surreal_ck 特例散布进无关执行路径。
- 只有 upstream stable 提供等价能力、内部格式迁移和双仓验收全部通过后，才可另行决定退役私有实现；PR 合并本身不是切换条件。

### 2026-07-25 — 已确认的 upstream 同步与 release line

- 配置只读官方 `upstream` remote，`origin` 保持 MainListActivity fork；共享分支禁止 force-push。
- fork main 是下一版本集成线：每周自动 fetch upstream 并生成包含冲突、变更范围和测试信号的同步 PR，只能人工审核合并，不自动追随 upstream main。
- 生产使用 `releases/sck-<upstream-major>.<minor>`，基于官方 stable tag 而非 nightly，仅接收 quota 补丁、必要修复和审核后的 upstream patch；当前 3.3.0-nightly 只作开发基线。
- 每个官方 stable patch 进入候选验证；新 minor 先在 main/canary 完成迁移和双仓测试再切 production release line；高危安全修复加急 backport。
- 正式支持当前生产 minor，上一条 release line 只保留有限回滚/紧急修复窗口，避免长期维护多条分叉。

### 2026-07-25 — 已确认的 semver 与 quota capability 分层身份

- upstream semver 只表达基础引擎/协议兼容，fork build 使用 SemVer build metadata（如 `3.3.0+sck.1`）供 CLI、日志和 SDK 识别；容器 tag 使用 registry-compatible `3.3.0-sck.1` 并以 digest 为部署权威。
- 另提供稳定机器可读 capability document，至少包含 fork id、upstream engine version、fork release、git SHA、quota contract、catalog/storage format、INFO format、structured-error contract，以及各 KV backend 的 hard-quota 认证状态。
- `/version` 与 SDK version 保持现有 semver 契约；surreal_ck、部署 readiness 和 WSS 入口只以 capability document 判定配额运行资格，不能解析版本字符串猜测。
- 生产 server 始终编译并启用 native quota，不提供 disable flag 或漏开 Cargo feature 后仍可服务的模式。
- capability 缺失、版本未知或当前 backend 未通过 hard-quota 认证都判定不兼容并 fail-closed。

### 2026-07-25 — 已确认的 fork-required datastore fence 与不可原地降级

- quota-enabled datastore 的全局 storage version 使用 fork-required 标记（预留高位与 upstream storage major 组合），使 vanilla/旧官方 binary 因版本不匹配拒绝启动，不能在忽略私有 quota keys 的情况下开放数据。
- 另持久化结构化 fork format marker，包含 fork id、upstream storage major、quota catalog/usage format、minimum compatible fork release 与 migration state；fork 启动必须严格检查。
- 新 datastore 创建即写 marker；既有 datastore 只在正式迁移完成后切换。兼容才开放，需要迁移返回明确 migration_required，未知或更新格式 fail-closed。
- 普通 server startup 不静默升级内部格式；迁移先预检和可恢复 snapshot，再取得 maintenance fence、执行可重入转换、校验 policy/usage，最后原子推进 marker。
- quota format 未变化且旧 binary 明确兼容时可回滚镜像；格式已推进时禁止原地 downgrade，只能 forward-fix 或恢复升级前 datastore snapshot。普通 SurrealQL export 不携带 quota，不能充当完整回滚备份。

### 2026-07-25 — 已确认的自有镜像与 digest 晋级

- 只向 MainListActivity 自有 registry（如 `ghcr.io/mainlistactivity/surrealdb`）发布，不推送或引用官方 `surrealdb/surrealdb` namespace。
- 每个 fork release 一次构建 amd64/arm64 multi-arch image，产出不可覆盖版本 tag、git SHA tag和 upstream/fork/quota contract/format OCI labels；部署以 image digest 为权威，canary/stable 仅作便利指针。
- 同一签名 digest 从 CI、canary、staging 逐级晋级到 production，不按环境重新构建；nightly 只进入独立 canary channel，production 不自动跟随。
- 发布门包含完整 upstream CI、quota 并发/迁移/格式测试、surreal_ck downstream contract、multi-arch 启动与 capability probe、SBOM、provenance、漏洞扫描和镜像签名。
- 同 commit 发布匹配 CLI；CLI 与 server capability/format 不兼容时拒绝破坏性管理操作。surreal_ck 部署同时 pin 允许的 digest 与 capability range。

### 2026-07-25 — 已确认的 SDK、CLI 与结构化错误边界

- 浏览器与 Bun server 的普通连接继续使用 upstream `surrealdb-js` 协议和公开 API；生产依赖必须精确 pin 到双仓契约测试通过的版本，不能使用 `^` 浮动范围。当前仓库的 `surrealdb@^2.0.8` 只是待迁移现状，不代表已认证兼容。
- 浏览器不获得 quota 管理权，也不需要理解私有 AST。Bun root 控制面把 quota DDL、`INFO FOR QUOTA ... STRUCTURE` 和 `REBUILD QUOTA` 封装在窄的 `NativeQuotaClient` adapter 中，避免私有语法扩散到业务代码。
- HTTP 与 WebSocket 两条协议都必须证明 quota 错误的 `code`、`retryable`、`details` 能经 `surrealdb-js` 原样保留；若 upstream SDK 把它压平成 message，正式发布必须先升级、补丁上游或发布同版本约束的私有 SDK build，绝不以解析英文错误字符串兜底。
- 每个 fork release 发布兼容矩阵，列出认证的 `surrealdb-js`、CLI 与协议路径。官方 CLI 只有在矩阵明确允许时可执行普通远程查询；quota 管理、数据格式迁移、backup/restore 和任何可能直接打开 datastore 的动作只允许同 release 的签名 CLI。
- CLI 在破坏性动作前必须读取 server capability 与 datastore marker，版本或格式不匹配即拒绝；仅命令行 semver 相同不足以判定兼容。

### 2026-07-25 — 已确认的能力握手与启动 fail-closed

- fork 新增稳定、无敏感数据的 `GET /capabilities`，返回带 `format_version` 的机器文档；它描述 build/fork/quota/format/backend 能力，不替代认证后的业务或 quota 状态查询。
- readiness 支持声明需要 `native-quota-v1`；只有 quota 已编译启用、datastore marker 兼容、迁移状态 clean 且当前 KV backend 在本 release 的 hard-quota allowlist 中时才返回 ready。WSS/HTTP 业务入口和编排平台使用同一判定。
- Bun server 在执行任何 `_system` 或 workspace schema migration 前先完成两阶段门禁：先读取 HTTP capability/readiness，再以 root 对 `_system` 执行无副作用的 `INFO FOR QUOTA ... STRUCTURE` 读回，校验 grammar、授权与 DTO `format_version`。任一步失败都不开放登录、workspace 创建、调和或业务连接。
- 启动握手不通过制造一次超限写来探测错误，因为会污染审计且存在提交未知；结构化错误跨协议保真由 release contract test 证明。
- surreal_ck 按 capability contract 的 major/range 匹配，未知 major、缺字段、fork id 不符或仅有普通 `/version` 都判定为 incompatible。诊断接口可以报告原因，但不得降级连接 vanilla SurrealDB。

### 2026-07-25 — 已确认的跨仓兼容清单与 migration 前置条件

- 在 surreal_ck 中维护版本化、代码审查的兼容清单，并把等价内容固化进镜像 label 与 capability document。每个应用 release 映射到 fork id、upstream semver、fork release range、quota/INFO/error contract、storage/catalog/usage format、认证 backend、精确 SDK 版本、CLI range 和最低 migration capability。
- schema migration 依赖 capability 名称与 contract 版本，不靠比较普通 engine semver。首个签名 stable fork release 才成为 `native-quota-v1` 的最低引擎版本；当前 `3.3.0-nightly` 只是开发基线，不写成生产下限。
- 应用级 capability gate 必须早于 `_system` migration runner 和所有 workspace migration；未来任何依赖 quota 的 migration 都在 migration manifest 中声明 `requires_engine_capability`。不满足时保持 migration version 不变并进入诊断但不服务状态，不能执行一半后才发现不兼容。
- 当前 `docker-compose.yml` 使用官方 `surrealdb/surrealdb:v3.2.3` 且 `memory` backend，是明确的迁移待办；新版本必须改成兼容清单允许的自有 digest，生产部署不得把 `memory` 当持久 backend。
- 发布时生成一份可机器校验的双仓 compatibility manifest；应用制品、镜像 digest、CLI 和迁移包只有全部引用同一 manifest revision 才能晋级。

### 2026-07-25 — 已确认的 cluster 升级与 backend 认证

- 只有 release manifest 明确声明 storage/quota format 不变、事务语义不变且相邻版本 mixed-version compatible 时，才允许有界滚动升级；滚动期间所有节点仍须满足同一个 capability major 与 backend 认证。
- storage/catalog/usage format、counter generation/fencing 或事务强制语义发生变化时禁止混部：先停止新会话和写入、排空 WSS、取得可恢复 datastore snapshot 与 maintenance fence，关闭全部旧节点，由匹配 CLI 迁移一次，再以同一新 digest 启动全体节点；全量 quota audit 通过后才重新开放。
- 任何时刻都不允许 quota format 或 counter 语义不同的节点共同写一个 datastore；发现不一致立即 readiness fail-closed，而不是让负载均衡继续摘一留一运行。
- hard-quota backend 支持采用 release allowlist，不从“SurrealDB 能启动该 backend”推断“配额并发安全”。每个 backend 必须通过事务竞争、冲突重试、故障注入、重启恢复和 rebuild 一致性套件后才能列为 production-certified。
- 首期发布前必须至少认证一个持久 backend；具体 backend 由真实测试结果写入首发 manifest，而不是在规格阶段无证据承诺。`memory` 只允许本地开发/CI；未列入 allowlist 的 RocksDB、SurrealKV、TiKV 或其它 backend 均不得进入生产 readiness。
- 新 production release line 晋级后，上一条 line 保留 90 个自然日的紧急修复支持；该期限不覆盖已推进格式后的原地 binary downgrade，恢复仍必须遵守 snapshot/forward-fix 规则。

### Resolution

采用“私有生产 fork + 分层上游化”的双轨维护模式：每周人工审核 upstream 同步，生产基于 stable release line，并通过自有签名 multi-arch 镜像、digest 晋级和 90 日上一版本支持窗发布。upstream semver、fork release 与机器可读的 quota capability/format contract 分层，应用以两阶段 capability 握手、精确 SDK/CLI 兼容矩阵和 migration capability manifest 判定资格；vanilla、未知格式、未认证 backend 或结构化错误不保真的组合全部 fail-closed。

quota datastore 使用 fork-required version/marker，格式迁移必须 snapshot + maintenance fence，格式推进后不可原地降级。集群只有在 manifest 明确兼容时才可滚动升级，否则执行全停写、单次迁移、同 digest 重启与全量审计。具体首发持久 backend 由端到端验收测试选入 allowlist，不能由可启动性替代一致性认证。
