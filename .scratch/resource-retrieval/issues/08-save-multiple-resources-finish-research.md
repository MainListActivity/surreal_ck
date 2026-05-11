Status: done
Label: done

# RR-008 — 检索窗口保存多个资源并完成检索

## Parent

`.scratch/resource-retrieval/PRD.md`

## What to build

完成人工补库闭环。检索窗口通过专用 RPC 保存资源，不走 AI action executor。一个 research session 可保存多个资源；用户点击完成检索后，session 标记 completed，workflow resume 只携带 resourceIds。当前回答直接读取资源主数据，不等待 embedding。

## Acceptance criteria

- [x] 检索窗口保存资源使用专用 saveResearchResource 类 RPC，不调用通用 executeAiAction。
- [x] 保存动作验证 session 状态、workspace 归属和 resourceType payload。
- [x] 一个 open research session 可保存多个资源，并维护 createdResourceIds。
- [x] 每次保存资源后触发或排队 embedding，但保存成功不等待 embedding 完成。
- [x] 用户点击完成检索后，session 状态变为 completed。
- [x] 完成检索 resume workflow，payload 只包含 resourceIds。
- [x] workflow 回查新资源主数据并生成带 citations 的回答。
- [x] 测试覆盖多资源保存、session 完成、embedding pending 不阻塞、resume resourceIds 和当前回答使用资源主数据。

## Blocked by

- `.scratch/resource-retrieval/issues/07-evidence-basket-resource-draft.md`
