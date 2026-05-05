Status: needs-triage
Label: needs-triage

# PRD: Agentic AI Product Layer

## Problem Statement

应用已经完成 API Key 和模型配置，也已经具备工作簿、表格、仪表盘、SurrealDB 本地数据服务和 Mastra 初始化能力，但 AI 还没有成为产品的一等入口。用户现在需要在不同页面之间手动查找功能和数据，统计分析依赖手工配置仪表盘，审批人员分析债权金额时也缺少能理解当前行、当前表和相关上下文的辅助能力。

从用户视角看，AI 不应该只是一个设置项或单页功能，而应该贯穿系统：能帮助用户到达目标页面，查找债权数据，生成统计视图，辅助审批人员分析单条债权记录，并把可执行结果交给现有产品能力确认和落库。

## Solution

构建一个完整的 agent 产品层。用户只从全局 AI 窗口进入 AI 能力；表格、仪表盘、文档等页面不再各自提供独立 AI 入口。AI 通过 Mastra agent 编排受控工具，不直接任意操作数据库或页面，而是输出结构化意图，由主进程服务执行。

第一阶段提供页面级 AI 入口，形成所有页面都能访问的 AI 抽屉。后续在这个入口之上接入 Mastra agent，优先完成导航与查找、AI 创建仪表盘、当前行债权分析三个闭环。

AI 入口不应以模态遮罩阻塞主应用。长期形态应是一个可独立操作的 sidecar 窗口：用户感知上像主窗口外拼接出的第二个窗口，能磁吸在主应用右侧，也能在需要时独立移动；主窗口和 AI 窗口的点击、滚动、输入互不阻塞。

全局 AI 窗口需要像 Codex 对话上下文一样展示当前上下文提示。用户选中某个 sheet 时，对话框展示 `工作簿名 / Sheet 名`；用户选中某一行时，对话框展示 `Sheet 名 / 主要字段组合`，例如 `债权申报表 / 张三 || ZQ-2026-001 || ent_claim:abc`。用户发起对话时，当前选中的 workbook、sheet、row 摘要和 record id 必须随消息一起发送给主进程 AI 服务。

## User Stories

1. As an authenticated user, I want to open AI from any page, so that I can ask for help without leaving my current workflow.
2. As an authenticated user, I want the AI window to know which page I am on, so that its suggestions match my current context.
3. As an authenticated user, I want the AI window to avoid blocking the main app, so that I can keep using tables, dashboards, and navigation while AI stays open.
4. As an authenticated user, I want the AI window to attach to the main window like a magnetic sidecar, so that it feels spatially connected without behaving like a modal.
5. As an authenticated user, I want the AI window to detach or move independently in a later desktop implementation, so that I can place it beside the work area on larger screens.
6. As an authenticated user, I want AI access to be centralized in the global AI window, so that I do not need to choose between multiple AI entry points.
7. As a workbook user, I want the AI window to show the current workbook and sheet when I select a sheet, so that I can see what context the assistant will use.
8. As a workbook user, I want the AI window to update its context hint when I switch sheets, so that stale sheet context does not leak into new questions.
9. As a workbook user, I want the AI window to show a compact selected-row hint when I select a row, so that I can verify the exact record being discussed.
10. As a workbook user, I want the selected-row hint to include stable identifying values such as name, code, and record id when available, so that ambiguous records are easier to distinguish.
11. As a workbook user, I want the AI request to include the current workbook, sheet, and selected row context, so that I do not have to restate them in every prompt.
12. As a workbook user, I want row context to be omitted when no row is selected, so that AI does not assume a record-specific task.
13. As a workbook user, I want the AI window to keep working while I change selection in the main app, so that I can refine context before sending a prompt.
14. As an authenticated user, I want to ask AI to open a target feature page, so that I do not need to remember where that feature lives.
15. As an authenticated user, I want to ask AI to find a workbook by name or business meaning, so that I can jump directly into the right work area.
16. As an authenticated user, I want to ask AI to find a dashboard, so that I can inspect statistics without browsing page lists manually.
17. As an authenticated user, I want to ask AI to find a creditor or claim record, so that I can reach the relevant row quickly.
18. As an authenticated user, I want AI search results to show enough context before navigation, so that I can choose the right item when there are similar records.
19. As an authenticated user, I want AI navigation to be explicit and reversible, so that accidental instructions do not silently move me into the wrong workflow.
20. As a business analyst, I want to describe a metric in natural language, so that AI can create an appropriate dashboard chart draft.
21. As a business analyst, I want AI to inspect available tables and fields, so that it can generate statistics based on the actual schema.
22. As a business analyst, I want AI-generated chart drafts to be previewed before saving, so that wrong queries do not become permanent dashboard views.
23. As a business analyst, I want AI-generated dashboard views to reuse the existing dashboard builder contract, so that manually created and AI-created charts behave consistently.
24. As a business analyst, I want AI to suggest chart type, metric, dimension, filter, sort, and limit, so that I can create useful visualizations quickly.
25. As a business analyst, I want AI to explain what a generated chart measures, so that the saved dashboard title and description are understandable to other users.
26. As a business analyst, I want AI to create charts from SurrealDB-backed data, so that statistics reflect real persisted records.
27. As a business analyst, I want AI to avoid unsafe mutations when generating statistics, so that chart creation cannot corrupt business data.
28. As an approval reviewer, I want AI to analyze the currently selected claim row, so that I can understand what information is missing or inconsistent.
29. As an approval reviewer, I want AI to suggest values for blank fields in a claim row, so that I can reduce repetitive review work.
30. As an approval reviewer, I want AI to explain the basis for a suggested confirmed claim amount, so that I can decide whether to accept it.
31. As an approval reviewer, I want AI suggestions to appear as proposals first, so that the system never writes review-critical fields without confirmation.
32. As an approval reviewer, I want to accept selected proposed field updates, so that I can keep human control over approval data.
33. As an approval reviewer, I want to reject AI proposals without changing the row, so that low-confidence suggestions do not affect data.
34. As an approval reviewer, I want AI to consider related reference records when available, so that analysis is not limited to visible cells.
35. As an administrator, I want AI actions to go through existing permissions and service APIs, so that security logic remains centralized.
36. As an administrator, I want AI requests and tool calls to be observable, so that generated results can be debugged and audited.
37. As an administrator, I want API keys to remain in secure settings storage, so that AI features do not expose secrets to the renderer.
38. As a developer, I want AI capabilities represented by typed RPC contracts, so that renderer and main process integration remains maintainable.
39. As a developer, I want Mastra tools to call deep service modules rather than duplicate business logic, so that manual and AI workflows share validation.
40. As a developer, I want AI output parsed into structured intents, so that UI behavior is predictable and testable.
41. As a developer, I want dashboard generation to use the existing dashboard preview and save services, so that SQL validation and result normalization stay in one place.
42. As a developer, I want record patch proposals to use the existing row persistence path after confirmation, so that field constraints and serialization remain consistent.
43. As a developer, I want AI features to degrade gracefully when no model or API key is configured, so that the product remains usable.
44. As a developer, I want the initial AI drawer to be usable before backend agent integration, so that the product has a visible entry point while the agent layer is built.

## Implementation Decisions

- Add a global AI launcher available after authentication, independent from individual screens.
- Make the first AI panel non-modal. It must not render a full-screen blocking backdrop and must not intercept pointer events outside the AI panel itself.
- Treat the long-term desktop target as an Electrobun sidecar window, visually magnetized to the main window rather than embedded as a modal drawer.
- Persist sidecar placement state in the future so users can keep it attached, detached, or closed according to working style.
- Remove the editor right-panel AI tab from the product plan. The table/editor experience contributes context to the global AI window but does not expose its own AI entry.
- Treat the global AI drawer as the only product AI entry for navigation, search, row analysis, dashboard generation, and high-level tasks.
- Add a visible context hint area in the global AI window, modeled after Codex conversation context.
- When the active editor selection is a sheet, show workbook and sheet context as `workbook.name / sheet.label`.
- When the active editor selection includes a row, show selected-row context as `sheet.label / primary || secondary || recordId`.
- Derive selected-row primary and secondary labels from stable business fields when available, preferring display/name fields, then code/number fields, then id.
- Include a structured context object with every AI chat message. The object should carry route, workspace, workbook, sheet, selected row id, selected row label, and selected row visible values when available.
- Do not rely on the visible context hint as the source of truth. The visible hint is for user confirmation; the submitted context object is the canonical AI input.
- Build a Mastra workspace agent as the central orchestrator for user instructions.
- Register domain-specific tools for navigation, resource search, schema inspection, dashboard generation, and record analysis.
- Keep AI tools behind main-process services. The renderer sends user messages and receives structured responses; it does not receive secrets or execute database queries directly.
- Represent executable AI results as structured intents: navigation intent, search result selection, dashboard draft, record analysis, and row patch proposal.
- Use existing dashboard view draft, preview, save, cache, and widget rendering contracts for AI-generated charts.
- Prefer builder-style dashboard specs where possible. Only allow raw SQL through the same risk controls and validation as manual dashboard SQL.
- Use existing table schema and reference target introspection so AI understands available business tables and system tables.
- Add an AI chat/session RPC contract that supports sending a message with route context, workbook context, sheet context, selected row context, and optional dashboard context.
- Add an AI action execution RPC contract for confirmed actions such as navigation, saving a dashboard view, or applying a row patch.
- Keep row analysis read-only until the user explicitly accepts proposed field updates.
- Ensure row patch application uses the normal row upsert service so field constraints, RecordId serialization, and DateTime conversion remain centralized.
- Store AI conversation and tool observability through Mastra storage and the existing observability setup where practical.
- Avoid putting permission filters into generated frontend queries. Data access must continue to be enforced by schema permissions and main-process service boundaries.
- Keep the first UI iteration intentionally lightweight: launcher, drawer, quick actions, prompt composer, and explicit placeholders for upcoming backend integration.

## Testing Decisions

- Good tests should verify externally visible behavior: typed service responses, validation outcomes, persisted records, generated dashboard preview behavior, and renderer state transitions. They should not assert internal prompt wording or private implementation details.
- Add service tests for dashboard generation adapters, using the same style as existing dashboard builder and query tests.
- Add tests for AI navigation intent resolution, verifying that ambiguous and missing resources return choices rather than unsafe navigation.
- Add tests for record analysis proposal shape, verifying that generated patches only include editable fields and do not write until confirmed.
- Add tests for row patch application through the existing row persistence service, reusing prior editor/data-table runtime test patterns.
- Add tests for AI context snapshot construction, verifying workbook-only, sheet-selected, row-selected, and no-selection states.
- Add tests that context snapshots use stable record identifiers and do not include stale row context after selection changes.
- Add renderer tests or focused component checks for the global AI launcher once the project has an established renderer test harness.
- Keep LLM-dependent behavior behind deterministic adapters in tests, so tests can run without live model calls or API keys.
- Prior art exists in dashboard builder, dashboard query, data table runtime, editor, context, identity, and RPC serialization tests.

## Out of Scope

- Building a full autonomous approval workflow that confirms debts without human review.
- Letting AI execute unrestricted SurrealQL mutations.
- Cross-device AI session sync.
- Fine-tuned model training.
- External document ingestion beyond records already available to the application.
- Voice input, real-time co-browsing, or multi-agent collaboration UI.
- Replacing the manual dashboard builder.
- Adding separate page-specific AI entry points, including an editor right-panel AI tab.
- Full production prompt evaluation infrastructure.

## Further Notes

The core architectural rule is that AI should compose existing product capabilities rather than bypass them. Mastra should decide which tool to call, but the tools themselves should be narrow, typed, permission-aware, and backed by the same services used by manual workflows.

The highest-value rollout order is:

1. Global AI sidecar and context plumbing.
2. Navigation and resource search.
3. AI dashboard draft generation using preview-before-save.
4. Current-row claim analysis and patch proposals.
5. Auditing, observability, and richer confirmation UX.
