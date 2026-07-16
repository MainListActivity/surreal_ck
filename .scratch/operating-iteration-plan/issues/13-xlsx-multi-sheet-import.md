Status: done
Label: done

# OIP-13 — XLSX 多 Sheet 导入闭环

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

在 CSV 闭环上增加 `.xlsx` 解析和 Sheet 选择。用户可以把一个 Excel 文件中的多个 Sheet 导入为新工作簿的多个数据表，或逐个映射到已有模板工作簿的数据表；每个 Sheet 独立预览和校验，最终给出汇总及逐 Sheet 结果。

## Acceptance criteria

- [x] 支持 `.xlsx` 文件并列出所有可见 Sheet、表头和至少前 20 行预览。
- [x] 用户可选择忽略某些 Sheet，并为保留的 Sheet 选择“新建数据表”或“映射已有数据表”。
- [x] 新工作簿多数据表创建遵循模板实例化相同的原子结构创建边界。
- [x] 已有模板数据表复用字段别名、类型规整、引用解析和拒绝报告。
- [x] 完成页展示总成功/跳过数及每个 Sheet 的独立结果，失败信息不暴露底层堆栈。
- [x] 大文件解析不会冻结主界面，用户可取消尚未确认的导入。
- [x] 测试覆盖中文 Sheet 名、Excel 日期、空 Sheet、重复表头及部分 Sheet 失败。

## Blocked by

- `.scratch/operating-iteration-plan/issues/02-multi-sheet-template-instantiation.md`
- `.scratch/operating-iteration-plan/issues/12-template-sheet-import-mapping.md`

## Comments

- 2026-07-16：按 TDD 完成 XLSX 多 Sheet 导入闭环。首页支持 CSV/XLSX，XLSX 在独立 Web Worker 中用 SheetJS CE 0.20.3 解析，可取消解析；隐藏 Sheet 被排除，可见 Sheet 独立返回预览与校验状态。
- 新工作簿导入复用模板实例化事务构造器，一次事务创建工作簿、全部实体表、数据表元数据和合法记录；空 Sheet、重复表头和逐行类型失败以 Sheet 级结果汇总。
- 编辑器导入入口支持把 XLSX 中各 Sheet 分别映射到已有模板数据表，复用字段名/别名/宽松匹配、目标类型规整、引用解析和逐行中文拒绝报告；单个映射 Sheet 失败不阻断其他 Sheet。
- 验证：全仓测试通过（Web 441 pass / 15 skip / 0 fail）；全仓 TypeScript 0 errors；Web 生产构建成功。新增逻辑复用既有且已验证的多数据表 SurrealQL 事务构造器，未引入新的查询语法。
