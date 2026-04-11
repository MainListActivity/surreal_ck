---
title: Tencent Compatibility Parity Matrix
date: 2026-04-10
status: completed
---

# Tencent Compatibility Parity Matrix

## Must Match In MVP

| Surface | Behavior | MVP decision |
|---|---|---|
| 首页 | 左侧导航 + 顶部搜索 + 最近文档列表 | 必须保留 |
| 首页 | 快速新建按钮直接创建文档/工作簿 | 必须保留 |
| 首页 | 空状态仍然沿用相同骨架 | 必须保留 |
| 编辑器 | 第一眼先看到表格 | 必须保留 |
| 编辑器 | 文档标题、分享、切换文档、账户动作在顶部 | 必须保留 |
| 编辑器 | 右侧面板是附属，不替代表格 | 必须保留 |
| 状态 | 重连、登录失效、无权限、资源缺失有清晰页面状态 | 必须保留 |

## May Approximate In MVP

| Surface | Behavior | MVP decision |
|---|---|---|
| 首页 | 最近文档的元数据密度和排序细节 | 可近似 |
| 编辑器 | 工具栏完整腾讯节奏 | 可近似，优先保留表格层级 |
| 编辑器 | 分享/协作菜单完整弹层 | 可近似，先用简单动作 |
| 公开表单 | 作为工作流一部分的文案与确认页 | 可近似，但必须叙事一致 |

## Explicitly Deferred

| Surface | Behavior | Deferred reason |
|---|---|---|
| 编辑器右侧 | 真实复核队列 | 本期仅占位，不做真实流转 |
| 编辑器右侧 | 历史浏览与回滚 | 本期仅保留未来结构位 |
| 编辑器右侧 | AI 副驾和智能分析 | 本期仅保留未来结构位 |
| 手机端 | 完整表格编辑 | 只保证首页和公开表单可用 |
| 品牌 | 腾讯品牌资产、图标、商标细节 | 明确避免直接复刻 |

## Guardrails

- 不做“新工具教育型首页”，必须是文档首页。
- 不做 panel-first 的 legal dashboard。
- 不让 mock 数据继续控制首页或编辑器主路径。
- 不把权限逻辑塞回前端查询条件里。
