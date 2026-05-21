Status: done
Label: done

# RR-003 — 资源检索服务

## 2026-05-21 post-pivot note

本 issue 中的 `index-pending` / `index-error` 返回状态来自旧的异步 embedding 队列设计。Web-only V1 不维护 embedding queue / retry 状态；检索服务只需要区分可用向量检索、embedding disabled / unavailable，以及真实 miss。历史 acceptance 保留为已完成记录，不作为 V1 新实现要求。

## Parent

`.scratch/resource-retrieval/PRD.md`

## What to build

实现通用资源检索服务。检索 API 接收自然语言 query、业务上下文、resourceType、filters 和 limit，统一构造检索文本，执行关键词 contains 检索与服务层 cosine 向量检索，再按向量分、关键词分、质量分、时效分做混合排序。

检索结果必须区分高置信可回答、中置信候选、低置信未命中，以及 index-disabled/index-pending/index-error 等索引不可用状态。

## Acceptance criteria

- [x] `searchResources` 支持 query、context、resourceType、tags/sourceDomain/date filters 和 limit。
- [x] context 支持 selected-row、document、manual text 这类输入，并由服务层统一转换为检索文本。
- [x] V1 关键词检索使用 contains，覆盖标题、摘要、标签和证据文本，并返回 keywordScore。
- [x] V1 向量检索通过可替换的 vector index 接口在服务层计算 cosine similarity。
- [x] 混合排序结合 vectorScore、keywordScore、qualityScore 和 recencyScore。
- [x] 返回结果区分 hit/candidates/miss，以及 index-disabled/index-pending/index-error。
- [x] 使用 answerThreshold 和 candidateThreshold 做两级阈值分段。
- [x] filters 不泄露权限逻辑，只表达用户驱动的资源筛选。
- [x] 测试覆盖关键词命中、向量排序、混合排序、阈值分段、过滤条件、空索引和不同索引状态。

## Blocked by

- `.scratch/resource-retrieval/issues/01-resource-main-data.md`
- `.scratch/resource-retrieval/issues/02-embedding-profile-index-state.md`
