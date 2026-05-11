Status: done
Label: done

# RR-004 — ResourceAgent 只读检索与引用回答

## Parent

`.scratch/resource-retrieval/PRD.md`

## What to build

把资源检索接入 Mastra router workflow：新增资源检索类别和 ResourceAgent。ResourceAgent 只拥有检索、资源读取、草稿生成意图等只读/草稿能力；普通对话中不能直接写资源库。

高置信资源命中时，ResourceAgent 基于资源主数据生成带 `[1]` 引用的回答，并返回结构化 citations。中置信命中时，ResourceAgent 产生资源候选 suspend payload，等待用户选择。

## Acceptance criteria

- [x] Router 能把资源检索类请求路由到 ResourceAgent。
- [x] ResourceAgent 注册只读资源检索/读取工具，不直接持有写入资源库的工具。
- [x] 高置信命中时 workflow 可直接完成回答，回答文本包含 `[1]` 引用。
- [x] 高置信回答同时返回结构化 citations，包含 index、resourceId、title、sourceUrl 和证据引用信息。
- [x] 中置信命中时 workflow suspend，payload 包含可展示资源候选和候选分数/摘要。
- [x] ResourceAgent 在普通对话中若要创建资源，只能生成 `resource-draft` 写确认意图，不能直接入库。
- [x] 资源检索状态为 index-disabled/pending/error 时，ResourceAgent 输出对应可理解说明，不误判为普通 miss。
- [x] 测试覆盖路由分类、ResourceAgent tool 输出、高置信 citation 回答、中置信候选 suspend、写入能力缺失和索引不可用说明。

## Blocked by

- `.scratch/resource-retrieval/issues/03-resource-search-service.md`
