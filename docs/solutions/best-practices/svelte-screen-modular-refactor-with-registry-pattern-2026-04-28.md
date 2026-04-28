---
title: Svelte 大屏组件按职责拆分 + 注册表模式承载未实现功能
date: "2026-04-28"
category: best-practices
module: renderer/features/editor
problem_type: best_practice
component: tooling
severity: medium
related_components:
  - tooling
applies_when:
  - 单个 Svelte screen/page 文件超过 ~600 行，混合多个独立功能模块
  - 设计稿先于功能落地，UI 已布好但部分按钮/菜单/面板尚是占位
  - 同一容器内有多种平行可选项（视图切换、面板 tab、工具按钮、菜单项）
  - 需要支持新增同类项时不修改容器（开闭原则）
tags:
  - svelte5
  - refactor
  - registry-pattern
  - open-closed
  - component-architecture
  - ui-store
---

# Svelte 大屏组件按职责拆分 + 注册表模式承载未实现功能

## Context

`src/renderer/screens/EditorScreen.svelte` 在 redesign 阶段长到 1310 行，把"顶栏标题/保存状态/分享/菜单 + 工具栏视图切换/筛选排序/字段/新增 + 三种视图渲染（grid/kanban/gallery）+ 右侧面板三个 tab + 三个 modal + 底部 sheets + RevoGrid 事件绑定"全部塞在一个文件里。其中绝大多数按钮在设计稿中就已存在，但功能尚未实现：筛选/排序/隐藏字段/分组只是 toggle 一个 `activeTool`、菜单 5 项点击只关闭菜单、右侧 ChangesPanel 与 AiPanel 都是 `EmptyState` 占位。

如果只是按"DOM 块"机械拆分，未来实现某个占位功能时还是要回到容器组件改 if/else 分支或加新的 `{#if}` 块——拆完仍然违反开闭原则。

## Guidance

按"**职责模块 + 注册表（Registry）**"双层拆分：

1. **第一层 — 按职责拆容器**：每个独立 UI 区域成为一个 Svelte 组件（Topbar / Toolbar / 视图区 / RightPanel / Sheets / Modals）。
2. **第二层 — 用注册表承载平行可选项**：在容器内部，凡是"一组同构的可选项"（视图、面板 tab、工具按钮、菜单项）一律走纯数据的注册表 + `<svelte:component>` 动态渲染。新增/实现一项 = 新增/替换一行注册项，**容器组件不动**。

目录结构：

```
features/editor/
├── EditorTopbar.svelte           # 容器
├── EditorToolbar.svelte          # 容器
├── EditorSheets.svelte           # 容器
├── RightPanel.svelte             # 容器（动态渲染面板组件）
├── lib/
│   ├── cell-style.ts             # 纯函数：statusTone / cardAccent / cardPillStyle
│   ├── derived-columns.ts        # 纯函数：从 columns 推断 title/status/amount/date
│   └── editor-ui.svelte.ts       # 局部 UI store（panelOpen/activeTool/selectedRowId/...）
├── registries/
│   ├── views.ts                  # ViewRegistration[]
│   ├── panels.ts                 # PanelRegistration[]
│   ├── tools.ts                  # ToolRegistration[]（带 panel?/command? 扩展点）
│   └── menu.ts                   # MenuItem[]（action: () => void）
├── views/
│   ├── GridView.svelte
│   ├── KanbanView.svelte
│   └── GalleryView.svelte
├── panels/
│   ├── DetailPanel.svelte
│   ├── ChangesPanel.svelte       # 占位 EmptyState，将来直接替换文件内容
│   └── AiPanel.svelte            # 占位 EmptyState，将来直接替换文件内容
└── modals/
    ├── AddRecordModal.svelte
    ├── FieldsModal.svelte
    └── ShareModal.svelte
```

数据/UI 状态分离：
- `editorStore`（已有）— 业务数据：rows / columns / sheets / saving 状态
- `editorUi`（新增）— UI 状态：当前视图、面板 tab、激活工具、modal 开关、选中行
  子组件直接读这两个 store，**避免 prop drilling**。

`EditorScreen.svelte` 缩到 ~91 行，只做加载 workbook + 组合子组件。

## Why This Matters

**未实现功能的扩展点是显式的**。设计稿先行的 UI 里，"按钮存在 ≠ 功能存在"。如果把占位逻辑写在容器组件的 `{#if activeTool === 'filter'}` 分支里，未来实现筛选时必须打开容器组件、找到那个分支、塞代码。注册表把"扩展点"显式化为类型字段：

```ts
// registries/tools.ts
export type ToolRegistration = {
  id: string;
  label: string;
  icon: string;
  panel?: Component;           // 待实现时填充：点击展开的面板组件
  command?: () => void | Promise<void>;  // 待实现时填充：直接执行的命令
};
```

未来实现"筛选"功能时只需：
1. 写 `FilterPanel.svelte`
2. 在 `tools.ts` 给 `filter` 项加 `panel: FilterPanel`

**容器组件 `EditorToolbar.svelte` 一字不改**。这就是开闭原则在前端组件层的具体实现：对扩展开放（注册项的 `panel`/`command` 是可选字段），对修改封闭（容器永远不变）。

同样的，菜单项实现"导出 Excel"只是把 `menu.ts` 中 `action: noop` 替换成真实函数；面板"AI 助手"实现就是把 `AiPanel.svelte` 的内容从 `EmptyState` 替换成真实 UI——`RightPanel.svelte` 永远不变。

## When to Apply

- Svelte/React/Vue 单文件超过 ~600 行，且包含 2+ 个语义独立的 UI 区域
- UI 设计先行，存在"按钮已有/功能未做"的占位
- 容器内有 ≥3 个同构平行选项（按 tab / 按视图 / 按工具按钮）
- 预期未来会在同一位置增加同类项（新视图、新菜单项、新工具）

不适合的场景：
- 文件 < 300 行，所有功能已实现
- 选项数量恒定为 1-2 个，不会增加（直接 if/else 更简单）
- 选项之间逻辑高度耦合，无法独立成组件

## Examples

### 注册表定义（数据驱动 UI）

```ts
// registries/views.ts
import type { Component } from "svelte";
import GridView from "../views/GridView.svelte";
import KanbanView from "../views/KanbanView.svelte";
import GalleryView from "../views/GalleryView.svelte";

export type ViewRegistration = {
  id: ViewId;
  label: string;
  icon: string;
  component: Component;
};

export const viewRegistry: ViewRegistration[] = [
  { id: "grid", label: "表格视图", icon: "grid", component: GridView },
  { id: "kanban", label: "看板视图", icon: "list", component: KanbanView },
  { id: "gallery", label: "画廊视图", icon: "eye", component: GalleryView },
];
```

### 容器组件用 `<svelte:component>` 动态渲染

```svelte
<!-- EditorScreen.svelte -->
<script lang="ts">
  import { editorUi } from "../features/editor/lib/editor-ui.svelte";
  import { getView } from "../features/editor/registries/views";

  const currentView = $derived(getView(editorUi.view));
</script>

{#if currentView}
  {@const ViewComponent = currentView.component}
  <ViewComponent />
{/if}
```

新增"甘特图视图"时：写 `GanttView.svelte`，在 `views.ts` 添加一行
`{ id: "gantt", label: "甘特图", icon: "timeline", component: GanttView }`，
更新 `ViewId` 类型 union——`EditorScreen.svelte` **零改动**。

### UI store 替代 prop drilling

```ts
// lib/editor-ui.svelte.ts
function createEditorUi() {
  let state = $state({
    view: "grid",
    panelOpen: false,
    panelTab: "detail",
    activeTool: null,
    selectedRowId: null,
    /* ... */
  });
  return {
    get view() { return state.view; },
    set view(v) { state.view = v; },
    /* ... */
    openPanel(tab: PanelId) { state.panelTab = tab; state.panelOpen = true; },
    toggleTool(toolId: string) {
      state.activeTool = state.activeTool === toolId ? null : toolId;
    },
  };
}
export const editorUi = createEditorUi();
```

`KanbanView.svelte` 选中卡片时直接 `editorUi.selectRow(id); editorUi.openPanel("detail")`，不需要 props 回调链路。

### 占位面板：未来替换文件，不动容器

```svelte
<!-- panels/AiPanel.svelte（当前） -->
<script lang="ts">
  import EmptyState from "../../../components/EmptyState.svelte";
</script>
<EmptyState icon="ai" title="AI 助手" desc="该功能正在建设中，敬请期待" />
```

将来实现 AI 面板：把这个文件内容整体替换为真实 UI。`RightPanel.svelte` 通过 `panelRegistry` 拿到 `component` 字段并 `<svelte:component>` 渲染——**永不修改**。

## Related

- 项目使用 Svelte 5 Runes（`$state` / `$derived` / `$effect`）—— UI store 必须是 `.svelte.ts` 后缀才能用 `$state`
- 注册表中的 `Component` 类型来自 `import type { Component } from "svelte"`（Svelte 5 类型）
- 验证手段：`pnpm exec tsc -p tsconfig.renderer.json --noEmit` + `pnpm exec vite build` 同时跑一遍即可（svelte-check 未配置时的替代方案）
