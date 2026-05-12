Status: ready-for-agent
Label: ready-for-agent

# SYNCV2-008 — 志愿索引器 sweep：`pending → indexed/failed` 与关键词 fallback

## Parent

`docs/adr/sync.md`

## What to build

实现第一版志愿索引器模型：任何持有私有 credential 且与工作区 canonical profile 兼容的在线成员客户端，都可以周期性扫 remote `pending`，把共享 `resource_embedding` 推进到 `indexed` 或 `failed`。没有私有 credential 的成员不再伪装成“可向量检索”，而是明确退化为关键词检索。

这一刀完成后，资源库的 embedding 生命周期、关键词回退和共享检索状态应能独立演示。

## Acceptance criteria

- [ ] 在线成员客户端会在启动、重连、资源发布后和定期 sweep 时处理 remote `pending` 共享 embedding。
- [ ] 生成成功时共享状态推进到 `indexed`，失败时推进到 `failed` 并只保留安全摘要。
- [ ] 没有私有 credential 的成员仍可浏览和关键词检索共享资源，但不会尝试生成 query embedding。
- [ ] 回归测试覆盖 `pending → indexed/failed`、重复 sweep 的幂等收敛和关键词 fallback。

## Blocked by

- `.scratch/sync-v2/issues/06-shared-resource-publish-tracer.md`
- `.scratch/sync-v2/issues/07-workspace-embedding-profile-and-pending-protocol.md`
