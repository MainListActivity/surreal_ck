Status: ready-for-human
Label: ready-for-human

# SYNCV2-007 — `workspace_embedding_profile` 与 `pending` 行协议

## Parent

`docs/adr/sync.md`

## What to build

为共享资源库引入工作区级 canonical embedding profile，并把“待索引”变成显式共享事实。owner 写入工作区级 profile，成员可读；当工作区已配置 profile 时，发布共享资源会在同一次 remote 写中显式创建或更新 `resource_embedding(status="pending")`。

这一刀需要人工确认 shared schema、权限和远端升级方式，因为它会改变 embedding 配置的作用域和 shared 状态模型。

## Acceptance criteria

- [ ] 工作区存在独立的 canonical embedding profile，成员可读，写权限先收紧为 owner only。
- [ ] shared profile 不包含 secret，仅包含向量空间定义所需的共享字段。
- [ ] 发布共享资源且工作区已配置 profile 时，会在同一次 remote 写中显式创建或更新 `pending` 的共享 embedding 行。
- [ ] profile 变更后，旧共享 embedding 会转为 `stale`，并为当前工作区资源显式创建新的 `pending` 行。

## Blocked by

- `.scratch/sync-v2/issues/04-remote-first-sheet-ddl-via-exec-template.md`
- `.scratch/sync-v2/issues/06-shared-resource-publish-tracer.md`
