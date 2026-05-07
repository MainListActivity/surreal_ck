Status: done
Label: done

# AI-002 — AI 上下文快照：工作簿 / Sheet / 行选中联动

## Parent

`.scratch/agentic-ai-product/PRD.md`

## What to build

在 AI 抽屉顶部展示当前选中状态的上下文提示，并在发送消息时把结构化上下文对象附带到 RPC 请求。

**上下文提示显示规则：**
- 未进入工作簿时：不显示上下文提示
- 选中 Sheet（未选中行）：显示 `工作簿名 / Sheet 名`
- 选中某行：显示 `Sheet 名 / 主要字段 ‖ 次要字段 ‖ recordId`
  - 主要字段优先取 display/name 类字段，次要字段取 code/number 类字段，fallback 到 id
- 切换 Sheet 或切换行后立即更新，不残留旧状态

**发送时附带的结构化上下文对象**（已有类型骨架在 `src/shared/ai-context.ts`）：
```ts
{
  route: string,
  workbook?: { id: string; name: string },
  sheet?: { id: string; label: string },
  selectedRow?: {
    id: string,
    label: string,           // 用于上下文提示的拼接字符串
    visibleValues: Record<string, unknown>
  }
}
```
上下文提示仅用于用户确认，发送给 AI 的是此结构化对象，两者独立。

## Acceptance criteria

- [x] 未选中工作簿时，AI 抽屉顶部不显示上下文提示区
- [x] 进入工作簿选中 Sheet 时，提示区显示 `工作簿名 / Sheet 名`
- [x] 在 GridView 中选中某行后，提示区更新为 `Sheet 名 / name‖code‖recordId` 格式
- [x] 切换 Sheet 后提示区立即更新，不残留前一个 Sheet 信息
- [x] 取消行选中后，提示区退回到 `工作簿名 / Sheet 名` 格式
- [x] 发送消息时，RPC payload 中包含完整结构化上下文对象
- [x] 无行选中时，payload 中 `selectedRow` 字段缺失（不为 null/空对象）
- [x] 单元测试覆盖：workbook-only、sheet-selected、row-selected、no-selection 四种快照状态

## Blocked by

- `.scratch/agentic-ai-product/issues/01-global-ai-drawer-skeleton.md`
