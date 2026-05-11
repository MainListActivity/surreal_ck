Status: ready-for-agent
Label: ready-for-agent

# RR-001 — 资源主数据闭环

## Parent

`.scratch/resource-retrieval/PRD.md`

## What to build

建立通用资源检索底座的主数据闭环：workspace 级共享资源、resource type registry、证据数组、资源质量字段、重复 hash 标记、research session 基础持久化，以及最小资源详情读取能力。

本 slice 不要求 embedding、不要求检索排序、不要求独立检索窗口。完成后，系统应能保存和读取一个 `generic_note` 资源，并能创建、查询、完成或取消一个 research session，为后续检索、人工补库和 workflow resume 提供稳定数据基础。

## Acceptance criteria

- [ ] 可创建 workspace 级资源主记录，包含资源类型、标题、摘要、来源、证据、标签、结构化 payload、质量、hash、创建人和时间字段。
- [ ] `generic_note` 资源类型通过 registry 校验，未知类型不能绕过校验直接写入任意 payload。
- [ ] 证据段以数组形式保存，包含文本、来源 URL、来源标题、捕获时间和顺序。
- [ ] 资源质量支持 `user-confirmed`、`ai-draft`、`imported`、`deprecated`，并预留 confidence/sourceTrust。
- [ ] 保存资源时记录 content/evidence/source hash，但不阻止重复保存。
- [ ] 可创建、读取、完成、取消 research session，并记录 workspace、query/context、resourceType、状态、创建人和关联资源 id。
- [ ] 最小资源详情读取返回资源公共字段、证据、structuredPayload 和 session 关联信息。
- [ ] 测试覆盖资源创建/读取、payload 校验失败、research session 状态流转、重复 hash 持久化和 workspace 隔离。

## Blocked by

None - can start immediately

