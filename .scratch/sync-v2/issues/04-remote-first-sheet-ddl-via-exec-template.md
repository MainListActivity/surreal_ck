Status: ready-for-human
Label: ready-for-human

# SYNCV2-004 — remote-first `sheet` / 字段 DDL via `execTemplate`

## Parent

`docs/adr/sync.md`

## What to build

把 `sheet` 和字段结构变更切到新的 remote-first 路径：结构修改先在 remote 通过 `execTemplate` 成立，再在同一个 RPC 内同步更新本地结构影子库和本地派生 DDL。

这是一条需要人工确认的竖切，因为它会触及远端模板部署、权限和失败回滚语义。完成后，在线结构编辑不再依赖本地先写、后补 remote 的旧模型。

## Acceptance criteria

- [ ] 在线创建 `sheet` 或调整字段结构时，remote 会先成为权威真相，本地影子和本地派生 DDL 在同一 RPC 内随之更新。
- [ ] remote 模板执行失败时，本地不会残留“看起来成功”的结构变更。
- [ ] 动态表的后续重建和订阅仍然只以 metadata 为真相，而不是以本地 DDL 为真相。
- [ ] 人工确认远端模板、代理通道和权限模型满足新 ADR 约束。

## Blocked by

- `.scratch/sync-v2/issues/01-fixed-shared-shadow-bootstrap.md`
- `.scratch/sync-v2/issues/03-ent-projection-tracer.md`
