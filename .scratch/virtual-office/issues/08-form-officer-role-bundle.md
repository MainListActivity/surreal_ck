Status: needs-info
Label: needs-info

# VO-08 — 表单专员 岗位与 tool bundle

## Parent

`.scratch/virtual-office/PRD.md`

## What to build

新增 **岗位** `form-officer`：

1. 收到派单"基于 X 数据表的字段缺口创建并发布表单"
2. 调用既有 forms 模块创建表单 + 发布 + 拿到 share link
3. 把 share link 写回 **派单** `result`
4. 周期性（每次自己的心跳）拉取自家发布的表单填写率：
   - 计算缺口（已填 / 总人数）
   - 异常（同一受访者多次填写、空提交、字段冲突）
   - 必要时写 **用户通知请求**："客户 X 三次未回填，建议电话联系"

### Bundle `form-officer-basics`

- `createFormFromSheetTool` — input: `{ sheetId, missingFields[] }`，输出 `formId`
- `publishFormTool` — input: `{ formId }`，输出 `shareUrl`
- `getFormFillStatsTool` — input: `{ formId, sinceDays }`，输出填写率、异常清单
- 复用 manager-basics 的 `postOfficeReportTool` + `postUserNotificationTool`

## Acceptance criteria

- [ ] 在 data-analyst 已建数据表 + 项目经理派单后，form-officer 能产出可访问的 share URL
- [ ] 表单发布后再次心跳，能从 `getFormFillStatsTool` 拿到至少 0 的填写数
- [ ] mock"3 天 0 提交"场景下，form-officer 写出至少 1 条 `user_notification`
- [ ] 端到端串联：项目经理 → 数据分析师 → 表单专员 → 用户通知请求 全链路出现在 office_* 表与 user_notification 表中

## Blocked by

- `.scratch/virtual-office/issues/06-project-manager-role-bundle.md`
- `.scratch/virtual-office/issues/07-data-analyst-role-bundle.md`
- **需要人工确认**：本仓库的 forms 模块当前 tool 暴露面是否够（`createFormFromSheet` / `publishForm` / `getFormFillStats`）。若不够，先发一个 forms-side 的前置 issue。

## Notes

- 状态先标 `needs-info`：上面 forms 模块衔接点要先和你一起确认。
