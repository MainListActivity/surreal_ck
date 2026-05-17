Status: needs-triage
Label: needs-triage

# WP-D1-02 — WorkflowsStorage 落 _system.workflow_run

## Parent

`.scratch/mastra-router-migration/PRD.md`

## What to build

### 新 schema 增量

`shared/sql/system/002-workflow-run.surql`：

```surql
DEFINE TABLE workflow_run SCHEMAFULL;
DEFINE FIELD workspace   ON workflow_run TYPE record<workspace>;   -- 归属 ws；reconciler / 清理用
DEFINE FIELD owner_subject ON workflow_run TYPE string;
DEFINE FIELD kind        ON workflow_run TYPE string;              -- 'router' | 'office-employee' 等
DEFINE FIELD state       ON workflow_run TYPE object;              -- Mastra 序列化的 step state
DEFINE FIELD status      ON workflow_run TYPE string
  ASSERT $value INSIDE ['running', 'suspended', 'done', 'failed', 'cancelled'];
DEFINE FIELD created_at  ON workflow_run TYPE datetime VALUE time::now();
DEFINE FIELD updated_at  ON workflow_run TYPE datetime VALUE time::now();
DEFINE INDEX wfr_workspace ON workflow_run COLUMNS workspace;
DEFINE INDEX wfr_owner_status ON workflow_run COLUMNS owner_subject, status;
```

`_system` 的 ensureSystemSchema (簇 C-01) 自动识别这个新文件。

### Mastra storage adapter

```
server/ai/mastra/storage/surreal-workflows-storage.ts
```

实现 Mastra 的 `WorkflowsStorage` 接口（具体方法名以当前安装的 mastra 版本为准——issue 阶段读 mastra skill 文档）。所有操作走 root 连接到 _system；按 runId 主键读写。

`server/ai/mastra/index.ts` 注入这个 storage：`new Mastra({ workflows: ..., storage: new SurrealWorkflowsStorage(getRootConnection()) })`.

## Acceptance criteria

- [ ] workflow_run 表在所有 _system 已 seed 的环境上自动出现（_system_schema_version 升到 2）。
- [ ] Mastra workflow run 启动后能在 workflow_run 表里看到一行，status='running'。
- [ ] suspend 后 status='suspended'，state 字段包含可读 JSON。
- [ ] resume 后从 state 恢复，status 回到 'running'。
- [ ] server 重启后 suspended 的 run 仍能 resume；done 的 run 不会被重启。

## Notes

- 用 root 连接写 workflow_run 是因为这表跨 workspace 共享；前端永远不直接访问。
- 表里冗余 `workspace` 字段方便未来"清理某 workspace 下所有 run" + reconciler 校对。
