# shadcn-svelte 组件迁移

## 动机

减少手搓交互逻辑的维护负担与 bug。当前前端约 33 个 svelte 组件几乎全是手搓，其中一批"行为型"组件自己处理焦点 / 浮层定位 / 键盘导航 / 外点关闭 / aria，是 bug 高发区。把这些迁到 shadcn-svelte（底层 bits-ui），由原语接管交互行为。

## 范围原则

- **只迁"行为型"组件**（自管焦点/定位/键盘/外点/aria）。纯展示型与纯表单容器**不迁**：`Avatar` / `Logo` / `EmptyState` / `Icon` / `ReferenceCard` / `SideNav` / `FilterPanel` / `SortPanel` / `GroupPanel` / `DetailPanel`（行为指标全 0，迁移收益低、徒增 diff）。
- **路线**：全部走 shadcn-svelte 封装路线——`pnpm dlx shadcn-svelte@latest add <name>` 把封装层拉进 `$lib/components/ui/`，业务组件改引用。与已有 `button` 一致。
- **基线分两步**：先 CLI add 官方默认 + 替换逻辑跑通**行为**；视觉对齐 button 已建立的定制规范留作**收尾独立步骤**，不与行为迁移混 diff。

## 基础设施现状（已就位）

- `web/components.json`（baseColor: zinc，registry 官方）
- `$lib/utils.ts` 的 `cn()`
- `$lib/components/ui/button/`（已迁，封装路线先例，`buttonVariants` 已定制：紧凑 size `xs`/`icon-xs`/`icon-sm`、`active:translate-y-px`、`aria-expanded:bg-muted` 等）
- bits-ui@2.18.1（select / dialog / alert-dialog / dropdown-menu / popover / command / combobox 原语齐全）
- `web/src/app.css` 完整 light/dark 变量 + `@theme inline` + `@layer base`

> CLI `add` 只新建 `$lib/components/ui/<name>/` 文件，不动 app.css，副作用面小。

## 切片与依赖

```
01 Select ──┬── 02 Dialog 群 + WorkspaceSwitcher ──┐
            └── 03 RecordPicker 外壳 ──────────────┴── 04 视觉对齐收尾
```

- 01 是封装路线在本项目的试金石，跑通后 02 / 03 套路复制。
- 02 与 03 互不依赖，可并行。
- 04 必须等三批官方默认样式都进来后统一对齐。

每个 issue 形态：CLI add → 业务组件改引用 → 行为正确 → svelte-check / test 通过，单独可验证可合。
