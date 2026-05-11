Status: ready-for-agent
Label: ready-for-agent

# RR-007 — 证据篮与资源草稿

## Parent

`.scratch/resource-retrieval/PRD.md`

## What to build

在检索窗口中实现证据篮和 ResourceAgent 草稿生成。用户在外部页面选择文本后点击加入证据；系统优先通过受控 JS 读取选区，失败时允许粘贴。证据篮支持多段证据、删除和顺序维护。

用户点击生成草稿时，ResourceAgent 基于证据篮生成资源草稿。AI 生成失败时，用户仍能手动填写标题和摘要并保存。

## Acceptance criteria

- [ ] “加入证据”优先从外部 WebView 读取当前选中文本。
- [ ] 选区读取失败或为空时，UI 提供手动粘贴证据入口。
- [ ] 证据篮支持多段证据、删除、顺序展示和来源信息展示。
- [ ] 每段证据保存 text、sourceUrl、sourceTitle、capturedAt 和 order。
- [ ] ResourceAgent 可根据证据篮生成 resource draft，不直接保存资源。
- [ ] 草稿包含 resourceType、title、summary、source、evidence 和 structuredPayload。
- [ ] 草稿生成失败时保留证据篮，并允许用户手动填写必填字段。
- [ ] 测试覆盖证据篮 add/delete/order、粘贴回退、草稿生成成功、草稿生成失败后的手填状态。

## Blocked by

- `.scratch/resource-retrieval/issues/06-research-session-window-shell.md`

