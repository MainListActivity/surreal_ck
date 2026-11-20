# 接下来要做

更新时间：2026-11-17（核对基线：`origin/main` `46ca1eb`，实现代码与工单核对同 `.scratch/EXECUTION_PATH.md` 2026-11-16 版，基线 `7263024b`）

本文是仓库级的下一步工作索引。详细需求、验收条件和讨论记录仍放在 `.scratch/<feature>/issues/*.md`；这里只维护当前优先级、开工顺序和容易忘掉的跨主题风险。

## 维护规则

- 新的可执行事项优先写成 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`。
- issue 状态使用 `docs/agents/triage-labels.md` 中的五个状态：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`；完成后直接标为 `done`。
- 本文只列"下一批要做"和"暂缓原因"，不要复制 issue 的完整验收清单。
- 每次完成一个 issue 后，同步更新本文的"当前主线"和"下一批候选"。
- 排期顺序以 [`.scratch/EXECUTION_PATH.md`](.scratch/EXECUTION_PATH.md) 为准，本文只做索引。
- 工单头 `Status: done` 只表示实现已记录完成，不等于验收勾齐全、更不等于生产验收；不得凭 `done` 推断生产结果，也不得据此重复派发实现。

## 已经落地的底座（不再是待办）

Web pivot 的五个需求簇（A 仓库重组、B Hono 骨架、C workspace-as-database、D1 Router workflow、D2 前端迁移）以及 D3 dashboard 迁移、运营迭代计划（OIP-01..18）、资源检索（RR-001..014）、工作区设置、个人中心、home 重设计全部 done。此外：

- **订阅配额控制面**（`.scratch/native-resource-quota/`）：SCK-NQ-01..10 全部 done，SurrealDB fork 已发布 `sck-3.3.0-native-quota.1`，compose 只接受 digest 固定的自有镜像。剩余的是生产 rollout 运维动作，见下方"长线风险和预发布事项"。
- **虚拟员工 runtime**（`.scratch/virtual-employee-runtime/`）：VER-01..06 全部 `Status: done`，实现与测试在 `main`（`server/ai/office/employee-runtime.ts`、`employee-trigger-runtime.ts`、`employee-supervisor.ts`、`server/src/routes/employees.ts` 及对应测试）。剩余为生产侧 QA 复验，见"下一批候选"。
- **虚拟办公室**（`.scratch/virtual-office/`）：VO-01..06 全部 `Status: done`，实现在 `main`（`server/ai/office/project-manager.ts`、`server/src/routes/office.ts`、`shared/sql/workspace-template/031/041/044/045/046`、`web/src/screens/OfficeScreen.svelte` 等），ADR 见 `docs/adr/virtual-office.md`。剩余为验收与生产证据，见"下一批候选"。
- **律师破产债权垂直簇**（`.scratch/claims-vertical/`）：01..06 工单头均 `Status: done`，实现已上 `main`（06 的修复可追溯至 PR #132）。生产部署复测无记录，见"下一批候选"。红线不变：法律词汇只留在 `workbook_template` 数据里，平台代码/schema/prompt 不得出现。
- **shadcn 迁移**（`.scratch/shadcn-migration/`）：01..04 均 done（04 验收勾已齐）。
- **server-skeleton**（`.scratch/server-skeleton/`）：WP-B-06 done（本地 podman 构建 + `/health` 有记录；Docker 运行时下的 `docker compose up` 复测仍缺，见"下一批候选"）。
- **法律内容持续采集**（`.scratch/legal-content-acquisition/`，wayfinder 12 的实现拆分）：01..04 工单头 done；真实来源授权与持续采集未验证，不作为生产就绪。
- **平台法律内容 MCP**（`.scratch/legal-content-mcp/`）：01..10 全部 done，包括 07-mcp-oauth；MCP 已部署在 `https://l.maplayer.top/api/ops/mcp`。10-codex-e2e 记录 2026-09-11 生产验收（DCR、PKCE、scope、refresh、重连与撤权，`--fixture --publish --full-lifecycle`，`ok=true`、0 failures）。剩余：运营侧 bootstrap 配置（OIDC subject 与内容 capability）当时未写入，现状未知，见"下一批候选"。
- **AI 产品层**（`.scratch/agentic-ai-product/`）：全部 done / wontfix，作为语义参考保留。
- **法律数据产品决策票**（`.scratch/legal-data-product-wayfinder/`）：01..12 工单头 done；均为决策/范围票，不代表已实现程序（12 自述采集程序未实现，正文仍 `in_progress`）。

## 当前主线：无待派发实现工单

VER、VO、legal-content-mcp、claims-vertical、shadcn-migration、server-skeleton、legal-content-acquisition 的实现均已上 `main`，没有可派的代码工单。当前工作是**证据收集、工单簿记与运维确认**，不是新实现。

工单簿记遗留（仅在有授权的工单卫生改动里修，不在派发层面处理）：

- 头 `Status: done` 但正文状态行仍 `ready-for-agent`：VER-01、VER-03、VO-01。
- 头 `Label: ready-for-agent`：claims-vertical 01/02/05；legal-content-acquisition 02..04。
- PRD 头仍 `ready-for-agent`：VER、VO、claims-vertical、legal-content-acquisition；legal-content-mcp PRD 头仍 `Status: open`。
- 头 `done` 但验收勾未齐：VER-01/02/03（5/7/7）、VO-01/02/04（7/8/8）、claims-vertical 01/05/06（5/6/6）、shadcn-migration 01/02/03（6/7/6）、legal-content-acquisition 01/03（4/5）、legal-content-mcp 01..04（各 3）。

## 下一批候选（证据 / QA / 运维确认，非实现）

- **VER-06 生产 QA 复验**（ready-for-human）：按 `docs/runbooks/employee-runtime-observation.md` 用 `scripts/verify-employee-runtime.ts` 复验续约、重连、容量与长期运行；runbook 明确"运行成功不等于生产验收"，仓库内无运行记录。
- **VO-04 验收证据**：8 个验收勾全空，需测试或浏览器运行证据后才能宣称花名册/活动页验收。
- **VO-06 生产 onboarding**：代码与验收勾齐（`POST /api/workspaces/:slug/office/bootstrap`），但无生产运行记录。
- **claims-vertical 01/05/06 验收证据**：06 的代码修复已在 `main`，但宣称的 `CLAIMSE2E` 收口运行与生产部署复测均无记录，生产状态未知。
- **WP-B-06 Docker 复测**：ticket 留有 2026-05-21 复测要求（`docker compose up` + `/health`，需 Docker 运行时），CI 只跑 `docker build`，未跑 compose up。
- **原生配额生产 rollout 状态确认**：见下方"长线风险"；未合并 PR #59 记录了 2026-09-29 冻结生产收口的决定（OPEN、不在 `main`），rollout 任何一步前须由负责人确认冻结是否生效。
- **legal-content-mcp 运营侧 bootstrap 配置确认**：OIDC subject 与内容 capability 自 2026-09-11 记录以来状态未知，宣称运营侧就绪前须确认。
- **wayfinder 真实来源授权与持续采集**：未验证；其范围票 12 明确采集程序未实现、定时任务未启用。

## 已 Cancelled / Superseded

- **同步 v2**：整体取消（Web pivot 后只有一个 SurrealDB 实例）。`.scratch/sync-v2/**` 已删除，`docs/adr/sync.md` 标 Superseded。
- **Electrobun sidecar 窗口**：`AI-009` wontfix，Web 浏览器无 sidecar 概念。
- 历史 issue 文本里的 pre-pivot 执行路径（`src/main/**`、renderer/main RPC、service JWT、NS-admin、后端业务 CRUD 代理、后端 LIVE 转发）一律不得复活。

## 长线风险和预发布事项

这些不是当前主线，但上线前需要回看。

### 原生配额生产 rollout

- 优先级：High
- 状态：代码与发布门就绪；生产执行状态**待确认**（未合并 PR #59 记录了冻结生产收口的决定，是否生效须由负责人确认；生产真实现状仓库内不可知）
- 范围：按 `docs/runbooks/native-quota-release-cutover.md` 执行引擎维护窗、账本回填、分 cohort 晋级（synthetic → 1% → 10% → 50% → 剩余）、24h/48h 观察窗、产品切换，稳定 30 日后跑 `docs/runbooks/native-quota-legacy-migration.md` 的 delayed cleanup，并保留真实运行记录。

### 中国法律数据合规

- 优先级：P1 / pre-launch
- 状态：Not started
- 范围：法律案件数据是否属重要数据 / 国内数据中心选址 / 法务合同条款。建议单独立项 ADR + 法务咨询。

### SurrealDB root 凭证管理

- 优先级：High
- 状态：Not started
- 原因：后端唯一长期凭证，仅用于 `_system`、workspace lifecycle、schema migration、`employee_credential` 写入等维护路径，但泄露等于全部 workspace 可破。
- 范围：环境变量管理 + 不写日志 + 文档化轮换流程；后续考虑短期 token 或密钥管理服务。

### 文件上传磁盘满错误处理

- 优先级：Medium
- 状态：Done
- 范围：上传前检查可用磁盘空间，空间不足时返回明确错误并记录日志。
- 实现：Content-Length 超限在解析请求体前 413 `attachment-too-large`；`assertUploadDiskHeadroom` 按 max(64MB, 2×字节数) 预检暂存盘，不足记脱敏 warn 并 507 `upload-insufficient-storage`；R2/S3 507/QuotaExceeded/413 映射为 507 `attachment-storage-full` / 413 `attachment-too-large`，不泄露路径与凭证。生产磁盘满场景复验未做。

### `GRAPH_TRAVERSE` 计算字段重算防抖

- 优先级：Medium
- 状态：Not started
- 范围：批量收集 dirty 计算字段，在 500ms 静默期后统一重算。

### 异地备份

- 优先级：P2 / pre-launch
- 状态：Not started
- 范围：生产 SurrealDB 数据导出到 S3 / 第二主机，并验证恢复流程。

### 表单防滥用

- 优先级：P2 / pre-launch
- 状态：Not started
- 范围：服务端 Turnstile 校验，以及 nginx 或 Cloudflare 层限流。

### 审计轨迹 UI

- 优先级：P3 / post-MVP
- 状态：Not started
- 范围：在表格 UI 中提供 History 面板，按选中单元格或记录查看 mutation 轨迹。
