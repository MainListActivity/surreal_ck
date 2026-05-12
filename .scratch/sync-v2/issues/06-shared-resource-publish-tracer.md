Status: ready-for-agent
Label: ready-for-agent

# SYNCV2-006 — 共享资源发布 tracer：`research_session` → `resource_item`

## Parent

`docs/adr/sync.md`

## What to build

把 `saveResearchResource` 改造成新资源架构下的第一条完整竖切：检索过程仍保留在本地私有 `research_session`，但用户确认保存时，资源会 remote-first 发布到共享 `resource_item`，并在同一个 RPC 内同步更新本地资源投影。

这一刀还要把 shared/private 边界写死：shared `resource_item` 不再携带本地 `research_session` 引用，检索过程关联和发布伴随信息保留在本地私有区。

## Acceptance criteria

- [ ] `saveResearchResource` 成功后，shared `resource_item` 已在 remote 成立，且本机本地资源投影在同一 RPC 内立即可见。
- [ ] shared `resource_item` 载荷不再包含本地私有 `research_session` 引用。
- [ ] `research_session` 仍可在本地维护“我创建了哪些共享资源”的过程信息，而不要求把会话本身上云。
- [ ] 回归测试覆盖 remote-first 发布、自写后本地立即可见，以及 shared/private 载荷分离。

## Blocked by

- `.scratch/sync-v2/issues/01-fixed-shared-shadow-bootstrap.md`
