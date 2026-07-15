Status: done
Label: done

# OIP-06 — Workspace SurQL 增量自动发现

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

移除 workspace 模板迁移的 TypeScript 文件清单，改为按文件名版本自动发现和排序 `.surql` 增量。交付工程师新增 schema 或数据迁移文件后，不需要再修改加载器代码；新 workspace 创建和已有 workspace 启动迁移使用同一份有序脚本集合。

## Acceptance criteria

- [x] 合法编号的 `.surql` 文件会被自动发现并严格按版本顺序加载。
- [x] 重复版本、版本断档、非法文件名会在应用任何迁移前产生明确错误。
- [x] 新 workspace 从零应用完整脚本，已有 workspace 只应用高于当前版本的脚本。
- [x] 迁移版本仍由实际最高脚本版本推导，不维护第二份常量清单。
- [x] 测试证明仅新增一个 `.surql` fixture 即可被创建和迁移路径发现，无需修改 TypeScript 清单。

## Delivered

- `loadTemplateScripts()` 扫描 workspace template 目录，按三位版本号自动发现、校验并排序 `.surql` 增量。
- 加载阶段拒绝非法文件名、重复版本和版本断档；调用方拿不到部分脚本，因此不会开始应用迁移。
- `WORKSPACE_TEMPLATE_VERSION` 从默认目录实际最高脚本版本推导，移除了 TypeScript 文件清单。
- 创建与启动迁移测试使用真实加载器证明新增 fixture 自动进入两条路径；新工作区应用全量，已有工作区只应用更高版本。
- 验收：shared 59 pass；server 190 pass / 2 skip；shared/server TypeScript typecheck 均无错误。

## Blocked by

None - can start immediately
