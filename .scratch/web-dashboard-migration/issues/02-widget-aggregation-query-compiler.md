Status: done
Label: done

# D3-02 — widget 聚合查询编译器

> 2026-06-12 自 PRD 路线图行细化立项并完成。D3-01 已提供 `dashboard_page.widgets[]`
> 内嵌数据层；本 issue 提供 D3-03/D3-05 复用的直连聚合查询 substrate。

## Parent

`.scratch/web-dashboard-migration/PRD.md`

## Agent Brief

**Category:** enhancement
**Summary:** `web/src/lib/dashboard-query.ts` 把 `DashboardBuilderSpec` / D3-01
`DashboardWidget` 编译成只读、参数化 SurrealQL 聚合查询，并用当前浏览器
SurrealDB 会话直连执行，返回 shared 的 `DashboardPreviewResponse` 结果形态。

**Desired behavior:**

- `runDashboardWidgetQuery(conn, specOrWidget)`：执行 widget 聚合预览；不经过后端代理。
- 支持 KPI `count` / `sum` / `count_distinct`，分类 `GROUP BY`，日期 bucket 时间序列。
- filter 值一律绑定到 `$fN`，表名通过 `type::table($tb)` 绑定；进入 SQL 文本的字段名先做安全标识符校验。
- 查询不包含任何 auth 过滤；跨 workspace 隔离由 db 边界保证，行级权限由表 PERMISSIONS 兜底。
- 结果归一化为 D3-03 widget 可消费的 shared dashboard result contract：
  `single_value`、`category_breakdown`、`time_series`。
- D3-01 的 `DashboardWidget` 包装可直接传入，保留外层 `viewType`，避免 AI / 手工 builder 出现第二套 widget 描述。

**Out of scope:**

- widget Svelte 组件搬迁（D3-03）。
- dashboard 屏幕 / builder（D3-04）。
- AI 草稿卡保存与 resume（D3-05）。
- 后端 dashboard 聚合代理 endpoint。

## Acceptance criteria

- [x] `web/src/lib/dashboard-query.ts` 提供编译 + 直连执行公共接口。
- [x] 编译器覆盖 GROUP BY / COUNT / SUM / 时间桶，并有 fake `SurrealConn` 单测。
- [x] 查询为只读 SELECT，filter 值参数化；非法表名 / 字段名在执行前拒绝。
- [x] 能直接接收 D3-01 `DashboardWidget` 包装，与 D3-05 草稿预览保持同口径。
- [x] 代表性 SurrealQL 通过 `surreal validate /dev/stdin`。
- [x] `pnpm --filter @surreal-ck/web test` 与 `typecheck` 通过。

## Comments

**2026-06-12（完成）**：新增 `web/src/lib/dashboard-query.ts` 与 9 个单测。
要点：

- 表名绑定：`FROM type::table($tb)`；filter 值绑定：`$f0` / `$f1` / ...
- 字段标识符仍需进入 SQL 文本，统一限制为 `/^[a-zA-Z_][a-zA-Z0-9_]*$/`。
- 日期 bucket 输出字符串 x 轴：day / week / month / year 分别映射到 `time::format` 格式。
- `count_distinct` 在 KPI 场景走子查询去重计数，避免无 GROUP 场景下使用 group 聚合表达式。
