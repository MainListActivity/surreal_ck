Status: done
Label: done

# CV-04 — Excel 解析、列映射、预览与批量导入

## Parent

`.scratch/claims-vertical/PRD.md`

## What to build

在任意数据表导入 `.xlsx`、`.xls`、`.csv`：SheetJS 解析及映射／类型规整为与 UI 无关的纯逻辑；自动匹配按精确列名 → 模板列别名 → 大小写／空白宽松匹配；用户可覆盖或忽略。预览展示映射、可导入行及拒绝行（原始行号、字段、原因）。数字去千分位、日期转目标 datetime、单选必须命中选项。确认后用当前用户会话分批 INSERT；引用按目标表显示值匹配，未命中拒绝该行且不自动建目标记录。

先复核 OIP-12/13/14 与 `web/src/lib/xlsx-*`、`import-batch*` 和导入对话框：已有 CSV/XLSX 映射、拒绝报告及批量落库应复用，重点确认 `.xls` 支持、模板别名优先级、引用未命中行为和 PRD 的跨表导入场景，不另建导入管道。

## Acceptance criteria

- [x] 三种文件格式可解析；中文表头、空表、重复表头、Excel 日期和多 Sheet 情况有明确处理与可重复测试。
- [x] 映射优先级、手动覆盖／忽略、类型规整及拒绝报告符合上文，预览前零写入。
- [x] 引用按显示值查找并写入正确 RecordId，未命中只拒绝对应行，不创建被引用记录。
- [x] 确认后当前用户直连分批写入；部分失败有成功数、拒绝原因与仅重试失败行路径，非模板表同样可导入。
- [x] 解析／映射纯函数先有行为测试，数据库和 UI 测试覆盖权限、预览与落库。
- [x] 最高约束：仓库代码、平台 schema、平台 prompt 不得出现法律领域词汇；法律内容必须能经不 seed／删除模板行整体移除。

## Scope handoff

本票是通用导入能力；领域列别名只从 CV-02 的模板行读取。CV-06 用脱敏历史文件验证导入至分析的实际链路。

## Comments

- 2026-10-01：复核 OIP-12/13/14 后确认 CSV/XLSX 解析、映射优先级（精确字段名→模板别名→宽松）、类型规整、引用显示值匹配/拒绝报告、批次回执与撤销、UI 与集成测试均已存在并复用，不另建导入管道。缺口为 `.xls`（BIFF8）：两处文件入口（首页与编辑器导入对话框）此前仅接受 `.csv/.xlsx`。本次补齐 accept 类型、文件名校验与解析路由，SheetJS `XLSX.read(type:"array")` 原生解析 BIFF8，`.xls` 与 `.xlsx` 共用同一 Worker 解析、映射、预览与落库路径；工作簿名推导同时去 `.xls` 扩展名；入口与对话框标题改为覆盖三种格式的措辞。新增 BIFF8 `.xls` 解析行为测试（中文表头、Excel 日期、多 Sheet、隐藏 Sheet、重复表头、工作簿名去扩展名），并更新入口 UI 测试断言。验证：web 588 pass / 18 skip / 8 fail（8 fail 为干净 main 上同样存在的模板创建集成测试环境问题，与本票改动无关）；tsc 0 error；svelte-check 0 error（2 条存量警告在未触碰文件）；oxlint 0 warnings 0 errors。

## Blocked by

- `.scratch/claims-vertical/issues/02-claims-pack-and-seeding.md`
- `.scratch/claims-vertical/issues/03-multi-sheet-instantiation.md`
