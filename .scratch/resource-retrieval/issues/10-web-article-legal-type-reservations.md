Status: done
Label: done

# RR-010 — Web article 类型与未来 legal 预留

## Parent

`.scratch/resource-retrieval/PRD.md`

## What to build

完善 V1 内置 `web_article` 资源类型，并为后续 `legal_case` 和 `legal_article` 留出 registry、payload 和展示扩展点。`web_article` 的保存和草稿生成必须强制 title、summary、sourceUrl、sourceTitle 和 evidence；作者、发布日期、站点为可选字段。

本 slice 不实现相似案例检索、不实现法条标注 UI，也不要求法律专用 ranker，只确保通用底座不会阻碍这些后续能力。

## Acceptance criteria

- [x] resource type registry 支持 `web_article` schema。
- [x] `web_article` 必填 title、summary、sourceUrl、sourceTitle 和 evidence。
- [x] `web_article` 可选 author、publishedAt、siteName 等网页元数据。
- [x] ResourceAgent 草稿生成能把证据篮映射为 `web_article` 草稿字段。
- [x] 手动保存 `web_article` 时字段校验错误可被用户理解并修正。
- [x] registry 预留 `legal_case` 和 `legal_article` 的扩展接口，但不实现法律检索 UI。
- [x] citations 和 structuredPayload 结构能承载未来 legal resource 的来源和结构化信息。
- [x] 测试覆盖 `web_article` 有效/无效 payload、草稿字段映射、可选字段缺失和 legal 类型预留不影响 V1 类型。

## Blocked by

- `.scratch/resource-retrieval/issues/01-resource-main-data.md`
- `.scratch/resource-retrieval/issues/07-evidence-basket-resource-draft.md`
