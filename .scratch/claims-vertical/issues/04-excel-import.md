Status: ready-for-agent
Label: ready-for-agent

# CV-04 — Excel 解析、列映射、预览与批量导入

## Parent

`.scratch/claims-vertical/PRD.md`

## What to build

在任意数据表导入 `.xlsx`、`.xls`、`.csv`：SheetJS 解析及映射／类型规整为与 UI 无关的纯逻辑；自动匹配按精确列名 → 模板列别名 → 大小写／空白宽松匹配；用户可覆盖或忽略。预览展示映射、可导入行及拒绝行（原始行号、字段、原因）。数字去千分位、日期转目标 datetime、单选必须命中选项。确认后用当前用户会话分批 INSERT；引用按目标表显示值匹配，未命中拒绝该行且不自动建目标记录。

先复核 OIP-12/13/14 与 `web/src/lib/xlsx-*`、`import-batch*` 和导入对话框：已有 CSV/XLSX 映射、拒绝报告及批量落库应复用，重点确认 `.xls` 支持、模板别名优先级、引用未命中行为和 PRD 的跨表导入场景，不另建导入管道。

## Acceptance criteria

- [ ] 三种文件格式可解析；中文表头、空表、重复表头、Excel 日期和多 Sheet 情况有明确处理与可重复测试。
- [ ] 映射优先级、手动覆盖／忽略、类型规整及拒绝报告符合上文，预览前零写入。
- [ ] 引用按显示值查找并写入正确 RecordId，未命中只拒绝对应行，不创建被引用记录。
- [ ] 确认后当前用户直连分批写入；部分失败有成功数、拒绝原因与仅重试失败行路径，非模板表同样可导入。
- [ ] 解析／映射纯函数先有行为测试，数据库和 UI 测试覆盖权限、预览与落库。
- [ ] 最高约束：仓库代码、平台 schema、平台 prompt 不得出现法律领域词汇；法律内容必须能经不 seed／删除模板行整体移除。

## Scope handoff

本票是通用导入能力；领域列别名只从 CV-02 的模板行读取。CV-06 用脱敏历史文件验证导入至分析的实际链路。

## Blocked by

- `.scratch/claims-vertical/issues/02-claims-pack-and-seeding.md`
- `.scratch/claims-vertical/issues/03-multi-sheet-instantiation.md`
