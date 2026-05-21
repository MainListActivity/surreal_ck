Status: needs-triage
Label: needs-triage

# WP-D1-02 — WorkflowsStorage 落 workspace db workflow_run

## Parent

`.scratch/mastra-router-migration/PRD.md`

## What to build

### 新 workspace-template schema 增量

新增 `shared/sql/workspace-template/00x-workflow-run.surql`，随每个 workspace database 的模板和迁移一起应用。`workflow_run` 属于运行它的 workspace database，不落 `_system`，避免跨 workspace 混存和浏览器无法读取自己 run history 的问题。

字段要求：

- `owner_user`: `record<user>`，真人 Router workflow 用当前 `$auth`，虚拟员工 workflow 用员工 `$auth`。
- `kind`: `'router' | 'office-employee'` 等运行类型。
- `state`: Mastra 序列化的 step state。
- `status`: `'running' | 'suspended' | 'done' | 'failed' | 'cancelled'`。
- `created_at` / `updated_at`: datetime。
- 索引至少覆盖 `owner_user + status`，方便恢复当前用户或员工的未完成 run。

不要添加 `workspace` 字段；归属由 workspace database 边界天然表达。

### Mastra storage adapter

```
server/ai/mastra/storage/surreal-workflows-storage.ts
```

实现 Mastra 的 `WorkflowsStorage` 接口（具体方法名以当前安装的 mastra 版本为准——issue 阶段读 mastra skill 文档）。所有操作走当前 workflow 的 `surrealSession`，也就是已 SIGNIN 到当前 workspace database 的真人 / 虚拟员工会话；按 runId 主键读写。

`server/ai/mastra/index.ts` 注入这个 storage 时不要绑定 root 连接。storage 需要能从 workflow runtime context 取得 `surrealSession`，确保 snapshot 写入与业务 tool 一样按 `$auth` 归因。

## Acceptance criteria

- [ ] `workflow_run` 表通过 workspace-template migration 出现在每个 workspace database 中。
- [ ] Mastra workflow run 启动后能在当前 workspace database 的 `workflow_run` 表里看到一行，status='running'。
- [ ] suspend 后 status='suspended'，state 字段包含可读 JSON。
- [ ] resume 后从 state 恢复，status 回到 'running'。
- [ ] server 重启后 suspended 的 run 仍能 resume；done 的 run 不会被重启。
- [ ] 普通成员只能看见自己的 Router workflow run；工作区管理员可审计本 workspace 内 run；虚拟员工 run 归因到员工记录。

## Notes

- 旧方案把 `workflow_run` 放进 `_system`，但这会混合多个 workspace 的 workflow snapshot，并且浏览器无法用自己的 workspace access 读取 run history。最新 ADR 已改为每个 workspace database 内一张 `workflow_run`。
- root 不应参与 workflow snapshot 写入；root 只用于 `_system`、workspace lifecycle、schema migration、`employee_credential` 等维护路径。
