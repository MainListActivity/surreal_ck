Status: ready-for-agent
Label: ready-for-agent

# RR-009 — 主动补库与最小资源详情

## Parent

`.scratch/resource-retrieval/PRD.md`

## What to build

支持用户主动打开检索窗口进行资源沉淀，而不依赖 AI workflow 未命中。主动补库默认 resourceType 为 `generic_note`，允许用户切换资源类型。保存后资源进入 workspace 资源库并触发 embedding，但不 resume workflow。

同时提供最小资源详情弹层，用于查看资源摘要、证据、来源、structuredPayload、embedding 状态，并支持资源级重试索引。

## Acceptance criteria

- [ ] 用户可从明确入口主动打开检索窗口，且不需要 researchSessionId。
- [ ] 主动补库默认 `generic_note`，并允许切换到已注册 resourceType。
- [ ] 主动保存资源不触发 workflow resume。
- [ ] 主动保存仍走同一资源校验、hash、quality 和 embedding 状态逻辑。
- [ ] 最小资源详情弹层展示标题、摘要、来源、证据、structuredPayload JSON 和 embedding 状态。
- [ ] embedding failed/stale 时详情弹层提供资源级重试索引动作。
- [ ] 候选卡或保存结果能打开资源详情弹层。
- [ ] 测试覆盖无 session 保存、resourceType 切换、详情弹层状态和 retry indexing action。

## Blocked by

- `.scratch/resource-retrieval/issues/08-save-multiple-resources-finish-research.md`

