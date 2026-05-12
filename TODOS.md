# 接下来要做

更新时间：2026-05-13

本文是仓库级的下一步工作索引。详细需求、验收条件和讨论记录仍放在 `.scratch/<feature>/issues/*.md`；这里只维护当前优先级、开工顺序和容易忘掉的跨主题风险。

## 维护规则

- 新的可执行事项优先写成 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`。
- issue 状态使用 `docs/agents/triage-labels.md` 中的五个状态：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`；完成后可直接标为 `done`。
- 本文只列“下一批要做”和“暂缓原因”，不要复制 issue 的完整验收清单。
- 每次完成一个 issue 后，同步更新本文的“当前主线”和“下一批候选”。

## 当前主线：同步 v2

依据：`docs/adr/sync.md`

新决策已经放弃旧的 remote `SHOW CHANGES` / cursor / tombstone 同步模型，改为 remote-first 共享写、本地结构影子库、本地投影数据区，以及 `LIVE SELECT` + 全量重建。除非先重新确认 ADR，否则不要继续从 `.scratch/sync/` 的旧 changefeed 队列开工。

### 立即开工

1. `.scratch/sync-v2/issues/01-fixed-shared-shadow-bootstrap.md`
   固定共享表启动重建 tracer。先证明 remote 权威状态可以全量拉取并落到本地结构影子库，且高层读路径仍读本地。

### 紧随其后

1. `.scratch/sync-v2/issues/02-fixed-shared-live-and-dirty-rebuild.md`
   在固定共享表重建之后补 `LIVE SELECT` 增量、dirty 标记和恢复后重建。
2. `.scratch/sync-v2/issues/03-ent-projection-tracer.md`
   用 `sheet.table_name + column_defs` 驱动一个 `ent_*` 投影 tracer，移除对 remote introspection 的依赖。
3. `.scratch/sync-v2/issues/06-shared-resource-publish-tracer.md`
   把 `saveResearchResource` 改为 remote-first 发布共享 `resource_item`，同时保留 `research_session` 本地私有边界。

### 需要人工确认

1. `.scratch/sync-v2/issues/04-remote-first-sheet-ddl-via-exec-template.md`
   确认远端模板、代理通道、权限和失败回滚语义后，再改 `sheet` / 字段 DDL 路径。
2. `.scratch/sync-v2/issues/07-workspace-embedding-profile-and-pending-protocol.md`
   确认 `workspace_embedding_profile` schema、权限和远端升级方式后，再引入共享 `pending` embedding 协议。

### 后续收口

1. `.scratch/sync-v2/issues/05-rel-projection-and-workspace-key.md`
   在 DDL 路径确认后，把 `edge_catalog` 驱动的 `rel_*` 投影和 `workspace` 归属键补齐。
2. `.scratch/sync-v2/issues/08-volunteer-indexer-and-keyword-fallback.md`
   在共享资源发布和 profile 协议成立后，实现志愿索引器与关键词 fallback。
3. `.scratch/sync-v2/issues/09-offline-capability-matrix-and-shared-write-gate.md`
   把离线语义从单一 `readOnly` 改为能力矩阵，明确 shared write 全部禁写，`research_session` 仍可本地写。
4. `.scratch/sync-v2/issues/10-sync-status-v2-and-rebuild-controls.md`
   用新架构的状态面板替换旧 cursor/dead-letter 导向的同步 UI。

## AI 产品层剩余项

依据：`.scratch/agentic-ai-product/PRD.md`

多数 AI 基础设施已完成，剩余工作先按“补测试、补业务闭环、再升级窗口形态”推进。

1. `.scratch/agentic-ai-product/issues/07-context-snapshot-tests.md`
   补 AI 上下文快照测试，覆盖 no-selection、workbook-only、sheet-selected、row-selected 和陈旧状态清理。
2. `.scratch/agentic-ai-product/issues/06-claim-row-analysis.md`
   注册债权行分析 tool，输出字段补全提案，用户确认后通过已有 row upsert 服务写入。
3. `.scratch/agentic-ai-product/issues/09-sidecar-window.md`
   Electrobun sidecar 已完成部分调研和行为验证；剩余重点是跨窗口接收 AI 上下文状态更新，以及记录最终降级或升级条件。

## 已完成但要记住

- `.scratch/resource-retrieval/` 当前整体为 `done`，不要再把资源检索底座当作未完成主线。
- `.scratch/agentic-ai-product/issues/` 中的 `01` 到 `05`、`08`、`10` 到 `12` 当前为 `done`，除非回归失败，不应重复拆同类基础设施任务。

## 长线风险和预发布事项

这些不是当前主线，但上线前需要回看。

### 文件上传磁盘满错误处理

- 优先级：Medium
- 状态：Not started
- 原因：磁盘满时静默失败会导致客户文件丢失，属于法律数据完整性风险。
- 范围：上传前检查可用磁盘空间，空间不足时返回明确错误并记录日志。

### `GRAPH_TRAVERSE` 计算字段重算防抖

- 优先级：Medium
- 状态：Not started
- 原因：`LIVE SELECT` 同时触发大量计算字段重算可能冻结 UI 或压垮 SurrealDB。
- 范围：批量收集 dirty 计算字段，在 500ms 静默期后统一重算。

### 中国法律数据合规调研

- 优先级：Low，pre-launch
- 状态：Not started
- 范围：确认法律案件数据是否属于重要数据、是否有跨境传输限制，以及是否需要中国境内 SurrealDB 部署选项。

### 异地备份

- 优先级：P2，pre-launch
- 状态：Not started
- 范围：在备份脚本中增加 S3 或第二主机同步，并验证异地恢复。

### 表单防滥用

- 优先级：P2，pre-launch
- 状态：Not started
- 范围：服务端 Turnstile 校验，以及 nginx 或 Cloudflare 层限流。

### 审计轨迹 UI

- 优先级：P3，post-MVP
- 状态：Not started
- 范围：在表格 UI 中提供 History 面板，按选中单元格或记录查看 mutation 轨迹。
