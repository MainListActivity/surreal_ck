Status: ready-for-agent
Label: ready-for-agent

# SYNCV2-001 — 固定共享表启动重建 tracer

## Parent

`docs/adr/sync.md`

## What to build

打通新同步架构里的第一条竖切：应用在线启动时，从 remote 拉取固定共享表的权威状态，重建本地结构影子库，并让现有高层读路径继续只读本地。

这一刀只覆盖固定共享元数据，不碰动态 `ent_* / rel_*` 和资源库。目标是先证明“remote 权威写侧 + local 结构影子库”可以独立成立，并且本地影子可丢弃、可重建。

## Acceptance criteria

- [ ] 在线启动或手动触发重建时，固定共享表会从 remote 全量拉取并落到本地结构影子库。
- [ ] 清空本地结构影子库后再次重建，结果可恢复且重复执行不产生额外脏状态。
- [ ] 至少一条现有高层读路径在重建完成后仍从本地影子读取，不直接改成 remote 查询。
- [ ] 回归测试覆盖重建顺序、幂等性和远端不可达时的失败表述。

## Blocked by

None - can start immediately.
