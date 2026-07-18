Status: done

## Parent

`.scratch/home-redesign/issues/07-activity-panel.md`

## What to build

把「数据概览」tab 的迷你 bar chart 从 mock 周趋势（`MOCK_CHART_BARS`）换成真实查询。

趋势 = 最近 7 天每天的 `activity_event` 事件数（单表、`created_at` 有索引，比跨所有动态实体表聚合轻得多）。按天分桶 `GROUP BY`，前端补齐缺失日期为 0，渲染进现有 SVG bar chart。工作簿总数（`countWorkbooks`）已是真实查询，保持不变。

- 新增纯逻辑：按天聚合 `activity_event` 的查询封装 + 7 天补零 / 排序，TDD 覆盖。
- 删除 `activity-panel.ts` 里的 `MOCK_CHART_BARS`。
- 横轴标签按实际日期生成（如"周一…周日"或日期），不再写死。
- tab 切到「数据概览」时才触发趋势查询（沿用现有 lazy load 模式）。

> 写 SurrealQL 前先调用 `surrealql` skill。

## Acceptance criteria

- [x] 数据概览趋势图数据来自真实 `activity_event` 按天聚合（最近 7 天）
- [x] 缺失日期补零，7 个桶顺序正确，横轴标签按实际日期生成
- [x] `MOCK_CHART_BARS` 删除
- [x] 工作簿总数仍为真实查询，不回归
- [x] 聚合 / 补零纯逻辑单测覆盖，web 测试全绿
- [x] svelte-check 无类型错误

## Blocked by

- HR-14 `activity_event` schema + 静态表 event

（可与 HR-15 / HR-16 并行）
