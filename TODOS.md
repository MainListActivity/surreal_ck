# 接下来要做

更新时间：2026-09-18

本文是仓库级的下一步工作索引。详细需求、验收条件和讨论记录仍放在 `.scratch/<feature>/issues/*.md`；这里只维护当前优先级、开工顺序和容易忘掉的跨主题风险。

## 维护规则

- 新的可执行事项优先写成 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`。
- issue 状态使用 `docs/agents/triage-labels.md` 中的五个状态：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`；完成后直接标为 `done`。
- 本文只列"下一批要做"和"暂缓原因"，不要复制 issue 的完整验收清单。
- 每次完成一个 issue 后，同步更新本文的"当前主线"和"下一批候选"。
- 排期顺序以 [`.scratch/EXECUTION_PATH.md`](.scratch/EXECUTION_PATH.md) 为准，本文只做索引。

## 已经落地的底座（不再是待办）

Web pivot 的五个需求簇（A 仓库重组、B Hono 骨架、C workspace-as-database、D1 Router workflow、D2 前端迁移）以及 D3 dashboard 迁移、运营迭代计划（OIP-01..18）、资源检索（RR-001..014）、工作区设置、个人中心、home 重设计全部 done。此外：

- **订阅配额控制面**（`.scratch/native-resource-quota/`）：SCK-NQ-01..10 全部 done，SurrealDB fork 已发布 `sck-3.3.0-native-quota.1`，compose 只接受 digest 固定的自有镜像。剩余的是生产 rollout 运维动作，见下方"长线风险和预发布事项"。
- **平台法律内容 MCP**（`.scratch/legal-content-mcp/`）：内容 schema、运营身份、独立 ops 应用、批次校验、部分发布/纠错/撤回、来源审计 UI、本地采集 runner、Codex 端到端验收均 done；MCP 已部署在 `https://l.maplayer.top/api/ops/mcp`。
- **AI 产品层**（`.scratch/agentic-ai-product/`）：全部 done / wontfix，作为语义参考保留。

## 当前主线：虚拟员工 runtime → 虚拟办公室

```
virtual-employee-runtime (VER-01..06)
        ↓
virtual-office (VO-01..06)
```

### 簇 1 — 虚拟员工执行基础设施（`ready-for-agent`）

依据：`.scratch/virtual-employee-runtime/PRD.md`

6 张票，按 01 → 06 顺序：共享执行上下文 seam（Router 零回归）、幂等员工生命周期与会话注册、通用持久化触发接管每日债权风险员工、可恢复执行窗口与幂等副作用、预算/循环/重试/背压、连接监督与容量验收。

这是虚拟办公室的运行时前置；先做 VER-01 可以在不改 Router 行为的前提下打开员工 session 注入口。

### 簇 2 — 虚拟办公室（`ready-for-agent`，依赖簇 1）

依据：`.scratch/virtual-office/PRD.md`

6 张票：办公室领域表与通知通道兼容、项目经理派单到报告 tracer、人类请求一次性解决闭环、实时花名册与活动页、数据分析师提出 + 浏览器管理员确认 DDL、从建 workspace 到首份报告的幂等 onboarding。

## 下一批候选（可与主线并行）

- `.scratch/claims-vertical/PRD.md`（`ready-for-agent`）：律师破产债权垂直簇，需先用 `/to-issues` 拆票；所有法律词汇留在 `workbook_template` 数据里，平台代码/schema/prompt 不得出现法律词汇。
- `.scratch/shadcn-migration/issues/04-visual-alignment.md`（`ready-for-agent`）：视觉对齐收尾，小任务。
- `.scratch/server-skeleton/issues/06-dockerfile-and-env.md`（`ready-for-human`）：Dockerfile / `.env.example` / 启动文档的人工确认项。
- `.scratch/legal-content-mcp/issues/07-mcp-oauth.md`（`open`）：只剩与 IdP 的真人 DCR / PKCE / refresh 联测；被生产 `ck` tenant 的登录方式配置阻塞，需要先做运营侧配置。
- `.scratch/legal-data-product-wayfinder/` 中 09 / 10 / 11 / 12 四张票仍是 `in_progress` / `open` 的决策票（运营控制面、价格验证、实施规格汇总、法律内容持续采集），属于产品决策而非实现。

## 已 Cancelled / Superseded

- **同步 v2**：整体取消（Web pivot 后只有一个 SurrealDB 实例）。`.scratch/sync-v2/**` 已删除，`docs/adr/sync.md` 标 Superseded。
- **Electrobun sidecar 窗口**：`AI-009` wontfix，Web 浏览器无 sidecar 概念。
- 历史 issue 文本里的 pre-pivot 执行路径（`src/main/**`、renderer/main RPC、service JWT、NS-admin、后端业务 CRUD 代理、后端 LIVE 转发）一律不得复活。

## 长线风险和预发布事项

这些不是当前主线，但上线前需要回看。

### 原生配额生产 rollout

- 优先级：High
- 状态：代码与发布门就绪，生产执行未开始
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
- 状态：Not started
- 范围：上传前检查可用磁盘空间，空间不足时返回明确错误并记录日志。

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
