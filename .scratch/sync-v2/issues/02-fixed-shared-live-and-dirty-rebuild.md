Status: ready-for-agent
Label: ready-for-agent

# SYNCV2-002 — 固定共享表 LIVE 增量与 dirty rebuild

## Parent

`docs/adr/sync.md`

## What to build

在固定共享表的启动重建之上，补上在线稳态同步：应用重建完成并在线时，通过 `LIVE SELECT` 把 remote 的 create/update/delete 增量回放到本地结构影子库；当连接断开或本地 apply 失败时，不做 cursor 补偿，而是把本地标记为 dirty，并在恢复后重新重建。

这一刀完成后，固定共享元数据应具备“在线增量 + 异常回到全量重建”的闭环。

## Acceptance criteria

- [ ] 固定共享表在线时会建立 `LIVE SELECT`，remote 的 create/update/delete 能增量反映到本地影子。
- [ ] `LIVE` 断开、订阅失效或本地 apply 失败时，会把对应影子状态标记为 dirty，而不是继续假装同步正常。
- [ ] 连接恢复后，dirty 影子会触发一次重建并回到健康状态。
- [ ] 回归测试覆盖 remote 增量回放、dirty 标记和“恢复后重建”的收敛路径。

## Blocked by

- `.scratch/sync-v2/issues/01-fixed-shared-shadow-bootstrap.md`
