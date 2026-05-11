Status: ready-for-agent
Label: ready-for-agent

# PRD: 通用资源检索底座

## Problem Statement

用户在处理工作簿、案件、材料和外部网页资料时，经常需要先查询已有知识，再在没有命中时手动检索外部来源，并把得到的结论沉淀下来。当前 AI 能查找应用内工作簿、记录、仪表盘，也能在当前行上做分析，但还没有一个通用的资源检索底座：无法优先查询已沉淀资源，无法在未命中时引导用户补充资源，也无法把人工检索得到的证据、结论、来源和向量索引纳入 workspace 共享知识资产。

最直接的上层需求是“基于当前在手案件查找相似案例，并在结果中标注每个案例引用的法律条款”。但这个需求不应把底座做死成法律检索。底座必须先支持通用资源检索、人工补库、typed payload 和引用回答；相似案例、法条标注、法律类型 ranker 后续作为 `legal_case` 和 `legal_article` 类型迭代。

## Solution

构建一个 workspace 级共享的通用资源检索底座。用户或 agent 发起资源检索时，系统先用资源库做关键词和向量混合检索；高置信命中可直接回答，中置信命中展示候选并允许多选，低置信或未命中时 workflow 暂停并打开独立检索窗口，让用户在应用内外部 WebView 中手动检索网页资料。

检索窗口使用可信壳包裹外部 WebView。第三方网页没有主进程 RPC 权限；可信壳负责导航、证据篮、AI 草稿生成、保存资源和完成检索。用户在网页中选中证据文本，点击加入证据；同一会话可保存多个资源，最后完成检索并恢复原 workflow。保存资源时先写入资源主数据，再异步生成 embedding。当前回答可直接使用新保存资源主数据，不等待 embedding 完成。

资源主数据采用通用基座加 typed payload：公共字段固定，`resourceType` 选择具体资源类型，`structuredPayload` 由 resource type registry 校验。第一版内置 `generic_note` 和 `web_article`，预留 `legal_case` 和 `legal_article`。回答使用文本 `[1]` 引用，同时返回结构化 citations，供 UI 渲染来源卡片和未来法律案例卡片。

## User Stories

1. As a workspace user, I want to search shared resources before doing manual research, so that existing knowledge is reused.
2. As a workspace user, I want AI to tell me when no strong resource match exists, so that I do not trust weak results accidentally.
3. As a workspace user, I want medium-confidence resource matches to appear as selectable candidates, so that I can decide what is relevant.
4. As a workspace user, I want to select multiple resource candidates, so that an answer can synthesize several sources.
5. As a workspace user, I want to continue manual research from a weak candidate list, so that incomplete matches do not block me.
6. As a workspace user, I want AI to open a research window when resources are missing, so that I can fill the knowledge gap without leaving the app.
7. As a workspace user, I want to open the research window proactively, so that I can add resources even when no AI workflow is running.
8. As a workspace user, I want proactive research to default to a generic resource type, so that I can save ordinary notes quickly.
9. As a workspace user, I want to change the resource type before saving, so that structured payloads match the source.
10. As a researcher, I want the research window to show an external webpage and a trusted recording panel, so that I can gather evidence and save results in one place.
11. As a researcher, I want external pages to have no database or AI RPC permissions, so that untrusted sites cannot access local data.
12. As a researcher, I want the research window to allow only http and https URLs in the first version, so that app-internal and local-file schemes are not exposed.
13. As a researcher, I want to select text on a page and add it to an evidence basket, so that the saved resource is grounded in explicit evidence.
14. As a researcher, I want selection capture to fall back to manual paste when automatic selection reading fails, so that I can still record evidence on difficult pages.
15. As a researcher, I want to collect multiple evidence snippets from the same page, so that one resource can be supported by several passages.
16. As a researcher, I want each evidence snippet to keep source URL, source title, capture time, and order, so that later review can audit where it came from.
17. As a researcher, I want AI to generate a resource draft from the evidence basket, so that I do not have to write summaries from scratch.
18. As a researcher, I want to edit AI-generated drafts before saving, so that the final resource reflects my confirmed conclusion.
19. As a researcher, I want to manually fill title and summary if AI draft generation fails, so that model errors do not block saving.
20. As a researcher, I want to save multiple resources in one research session, so that one manual research pass can support several future answers.
21. As a researcher, I want to finish a research session explicitly, so that the suspended AI workflow resumes only when I am done collecting resources.
22. As an AI user, I want saved resources from a manual session to be used immediately in the current answer, so that I get closure without waiting for indexing.
23. As an AI user, I want answers to include `[1]` style citations, so that I can see which statements rely on which resources.
24. As an AI user, I want the UI to receive structured citations, so that source cards and future resource detail views can be rendered reliably.
25. As a workspace user, I want resources to be shared at workspace scope in V1, so that teammates do not repeat the same manual research.
26. As a workspace user, I want duplicate-like resources to be detected by hashes without blocking save, so that repeated evidence can be reviewed later without losing context.
27. As a workspace user, I want resource quality to distinguish user-confirmed, AI-draft, imported, and deprecated resources, so that ranking and review can prefer trusted content.
28. As a workspace user, I want resource details to show title, summary, evidence, source, payload, and embedding status, so that I can audit saved resources.
29. As a workspace user, I want to retry embedding for a failed resource, so that indexing problems can be fixed without recreating resources.
30. As a workspace user, I want resources to remain saveable when embedding is not configured, so that knowledge capture is not blocked by model setup.
31. As a workspace user, I want search results to distinguish semantic miss from disabled, pending, or failed indexes, so that AI chooses the correct next action.
32. As an administrator, I want embedding settings to be separate from chat model settings, so that chat provider limitations do not break semantic search.
33. As an administrator, I want embedding profile changes to avoid mixing incompatible vectors, so that similarity ranking remains valid.
34. As an administrator, I want old embeddings to be marked for reindexing after profile changes, so that resources can be refreshed safely.
35. As a developer, I want resource types registered with schemas, so that typed payloads do not become uncontrolled JSON.
36. As a developer, I want unknown resource types to fall back to generic public fields or explicit custom handling, so that the base API stays stable.
37. As a developer, I want search to accept query, context, resource type, filters, and limit, so that upper-level features can reuse one retrieval interface.
38. As a developer, I want search context to support selected row, document, and manual text inputs, so that future legal-case search can build richer retrieval profiles.
39. As a developer, I want search ranking to combine vector score, keyword score, quality, and recency, so that results are not ordered by vector similarity alone.
40. As a developer, I want rankers to be extensible by resource type, so that `legal_case` can later use cause of action, issue overlap, and legal article overlap.
41. As a developer, I want resource embeddings stored separately from resource items, so that multiple profiles and reindexing can be modeled cleanly.
42. As a developer, I want the first vector index implementation to compute cosine similarity in the service layer, so that the end-to-end flow can ship before database vector indexing is finalized.
43. As a developer, I want a replaceable vector index interface, so that SurrealDB vector indexing can be adopted later without changing agent and UI contracts.
44. As a developer, I want resource creation in ordinary AI chat to require a `resource-draft` confirmation intent, so that agents cannot silently pollute the resource library.
45. As a developer, I want research-window saves to use a dedicated save RPC, so that explicit user saves do not get tangled with AI action confirmation state.
46. As a developer, I want manual research tied to a durable research session id, so that workflow run ids are not exposed as the main business handle.
47. As a developer, I want research sessions persisted, so that suspended workflows and open research tasks survive app restart.
48. As a developer, I want workflow resume payloads to carry resource ids only, so that the workflow can re-read canonical resource records from the database.
49. As a developer, I want ResourceAgent to own retrieval and draft generation, so that resource behavior stays in one domain-specific agent.
50. As a future legal-case user, I want the base resource API to reserve typed payloads and citations, so that similar-case retrieval and legal-article display can be added without rewriting the base.

## Implementation Decisions

- Create a standalone resource retrieval feature area rather than extending the existing agentic AI PRD or naming the base feature after legal search.
- Treat resource retrieval as a reusable bottom layer. Similar-case search and legal article annotation are later features built on top of the base.
- Add a new router category for resource retrieval and a ResourceAgent. ResourceAgent owns resource search, resource draft generation, citation answer generation, and read-only resource lookup.
- ResourceAgent must not directly write resources during ordinary chat. In chat it returns a `resource-draft` structured intent that reuses the existing write-confirmation path.
- The research window save flow is a separate explicit user action. It uses a dedicated save RPC and does not call the generic AI action executor.
- The first version delivers an end-to-end loop: search resources, select candidates or open manual research, collect evidence, generate draft, save resources, finish research, resume workflow, answer with citations.
- Resource storage uses a main resource item record plus a separate embedding record. Evidence snippets are embedded in the resource item in V1; they can be split later if resource-level editing or per-evidence indexing requires it.
- Resource item public fields include workspace, resource type, title, summary, source URL, source title, evidence snippets, tags, structured payload, quality, optional confidence, optional source trust, duplicate hashes, created by, created at, and updated at.
- Resource embedding records are keyed by resource and embedding profile. They store workspace, profile key, embedding text hash, vector, status, error details, indexed timestamp, and updated timestamp.
- A research session is a persisted business entity. It records workspace, originating run id, query, context, resource type, status, created resources, created by, created at, and completed/cancelled timestamps.
- Research sessions use statuses `open`, `completed`, and `cancelled`.
- One research session may save multiple resources. The user explicitly finishes the session, and workflow resume receives resource ids.
- Workflow resume payloads carry resource ids only. The workflow re-reads canonical resources from storage before answering.
- The current answer can use newly saved resources even when their embeddings are still pending.
- Resource library visibility is workspace-only in V1. Private resources are intentionally out of scope.
- Resource types use a registry with schemas. V1 includes `generic_note` and `web_article`; `legal_case` and `legal_article` are reserved for later iteration.
- The `web_article` type requires title, summary, source URL, source title, and evidence. Author, published date, and site name are optional.
- Unknown resource types must not bypass validation. They either use public generic fields or an explicit custom path.
- Structured payloads are stored as typed JSON validated by the resource type registry.
- Search accepts query, context, resource type, filters, and limit. Context supports selected row, document, and manual text so upper-level features do not each invent their own retrieval text builder.
- Search text is built centrally from query, context, resource type, title, summary, evidence summary, source title, and tags.
- Embedding text for a resource is generated from question or query, conclusion or summary, evidence summary, source title, and tags.
- Embedding settings are separate from chat model settings. Chat providers and embedding providers may have different models, dimensions, APIs, and availability.
- Embedding profiles isolate provider, model, dimensions, and version. Vectors from different profiles must not be mixed in the same similarity search.
- When embedding profile changes, old resource embeddings become stale and enter a reindex path rather than being used with the new profile.
- Resource save is allowed when embedding is not configured. Such resources are marked with disabled embedding state and can still be found by keyword search.
- Embedding generation is asynchronous. Resource save writes the resource first, then enqueues or starts embedding generation.
- Embedding failure marks the resource/index state as failed and supports resource-level retry.
- V1 shows resource-level embedding status and retry. A global embedding queue page is out of scope.
- Search distinguishes true miss from disabled, pending, and failed index states. These states drive different workflow behavior.
- V1 keyword search uses simple contains over title, summary, tags, and evidence text. The API still exposes keyword score so a better keyword engine can replace it later.
- V1 vector search computes cosine similarity in application service code behind a replaceable vector index interface. The interface may later be backed by SurrealDB vector indexing.
- Ranking combines vector score, keyword score, quality score, and recency score. Resource-type-specific rankers are reserved through a registry hook.
- Retrieval uses two thresholds: an answer threshold and a candidate threshold. High confidence can answer directly, middle confidence suspends for candidate selection, and low confidence starts manual research.
- Candidate selection supports multiple resources. Candidate cards support using selected resources or continuing manual research.
- Answers use inline `[1]` style citations and a structured citations array.
- Structured citations include citation index, resource id, title, source URL, and evidence snippet references when available.
- The research window is an independent Electrobun window containing a trusted local shell and an external WebView.
- External pages do not receive main-process RPC access. Recording, AI draft generation, saving, and finishing research live in the trusted shell.
- V1 only allows `http` and `https` navigation in the research window. Workspace allowlist and denylist are reserved for later.
- Evidence capture first attempts controlled selection extraction from the external WebView. If this fails, the user can paste evidence manually.
- Evidence snippets store text, source URL, source title, captured time, and order in V1. Locator fields are reserved for later.
- AI draft generation in the research window is handled by ResourceAgent from the evidence basket. If generation fails, the user can manually fill required fields and save.
- Proactive research is supported without a workflow session. In that case resources are saved and indexed, but no workflow is resumed.
- AI-triggered manual research uses a persisted research session id. The research window should not use workflow run id as the primary business identifier.
- The minimum resource detail UI is in scope: title, summary, evidence, source, structured payload JSON, embedding status, and retry.
- Full resource library management, private resources, cross-page evidence baskets, legal-case extraction, and legal-article annotation are outside the V1 base.

## Testing Decisions

- Tests should verify external behavior and stable contracts: schema validation, service responses, persisted records, ranking bands, workflow suspend/resume payloads, and UI state transitions.
- Tests should avoid asserting private prompt wording or LLM prose.
- ResourceStore tests cover creating resources, reading resources by id, saving multiple resources in one research session, completing/cancelling sessions, duplicate hash persistence, and workspace scoping.
- ResourceTypeRegistry tests cover valid and invalid `generic_note` and `web_article` payloads and unknown type behavior.
- ResourceSearchService tests cover keyword contains search, vector score combination, quality and recency scoring, threshold banding, filters, disabled/pending/failed index statuses, and multi-resource candidate output.
- ResourceVectorIndex tests cover cosine similarity ordering, profile isolation, empty index behavior, and replaceable interface behavior with deterministic vectors.
- EmbeddingProfileService tests cover separate embedding settings, profile key generation, disabled state, stale profile handling, pending/indexed/failed status transitions, and retry requests.
- ResourceAgent tool tests cover search output shape, resource candidate suspend intent shape, manual research suspend intent shape, resource draft intent shape, and citation answer output shape.
- Workflow tests cover high-confidence direct answer, middle-confidence multi-select candidates, continuing manual research from candidates, low-confidence manual research session creation, resume with resource ids, and cancellation.
- Renderer/state tests cover evidence basket add/delete/order, paste fallback path, candidate multi-select state, finish-research button readiness, resource detail modal state, and embedding retry action state.
- Real external WebView automation is not required for V1 AFK completion. A manual smoke checklist should cover navigation, selection capture, paste fallback, draft generation, save, finish, and resumed answer.
- Existing prior art includes AI context tests, router workflow tests, workflow suspend/resume tests, RPC serialization tests, settings tests, dashboard builder tests, and data-table runtime tests.

## Out of Scope

- Full legal-case similar-case retrieval implementation.
- Legal article extraction and legal-article cards.
- Cross-page evidence baskets for one resource.
- Private or user-only resource libraries.
- Workspace domain allowlist/denylist UI.
- Full resource library management page.
- Global embedding queue administration page.
- Production-grade BM25, Chinese segmentation, or advanced full-text indexing.
- SurrealDB-native vector index implementation, unless it can be swapped in behind the interface without changing the feature scope.
- External browser automation outside the app-contained WebView.
- Injecting recording buttons or privileged scripts into third-party webpages.
- Autonomous resource creation by agents without user confirmation.
- Importing bulk document corpora.
- Cross-device resource synchronization beyond the existing workspace data model.

## Further Notes

The base feature should be designed so that `legal_case` can become a typed resource later without changing the search and workflow contracts. A legal-case iteration can add a payload schema with court, docket number, judgment date, cause of action, facts, holding, cited legal articles, and type-specific ranking based on issue and article overlap.

The most important architectural rule is that resource capture and resource search are separate. Search tools do not open windows or block waiting for users; workflow orchestration decides when to suspend and when to open a manual research session. Resource save persists canonical data first; embedding is a derived index and should never be the reason a confirmed user save is lost.
