Status: done
Label: done

# CV-06 — 模板到人工确认写回的端到端收口

## Parent

`.scratch/claims-vertical/PRD.md`

## What to build

编写并执行可重复的手工验收清单，贯穿「选择性 seed 模板 → 管理员创建有样例／无样例工作簿 → Excel 导入 → 选中行进行 AI 分析 → 审阅提案 → 确认写回」。同时验证无模板工作区仍可用、成员权限、未命中引用拒绝行，以及模板删除后通用分析回退。使用脱敏 fixture；逐项记录环境、账号角色、步骤、预期和实际结果。

先复核 OIP-14 的验收 fixture／清单、`web/src/lib/bankruptcy-claims-template-pack.integration.test.ts` 和 OIP-17 的确认卡记录，复用可重放样本。现有测试通过不等于本票的手工验收完成；真实模型结果与人工判断需如实区分。

## Acceptance criteria

- [ ] 清单覆盖从新 workspace 的配置选择到导入、AI 提案及人工确认写回，逐步标明页面入口、账号角色、操作、预期与观察结果。
- [ ] 实测样例开关、Excel 列别名、金额／日期／状态规整、引用解析、拒绝行及重试路径。
- [ ] 确认前无业务写入；确认后只写入用户采纳字段，并可在编辑器回读。
- [ ] 无模板、删除模板及非领域工作簿均保持通用功能；记录代码测试、数据库集成测试、手工环境验证各自证据和未验证项。
- [ ] 对照 PRD 用户故事与 Out of Scope 形成收口记录；图表生成不算本簇完成项。
- [ ] 最高约束：仓库代码、平台 schema、平台 prompt 不得出现法律领域词汇；法律内容必须能经不 seed／删除模板行整体移除。

## Scope handoff

本票交付手工验收清单与实际执行记录，不把清单冒充自动化或生产验收。发现缺口回到对应 CV-01～05 票修复，再复测并标明版本。

## Blocked by

- `.scratch/claims-vertical/issues/01-template-package-schema.md`
- `.scratch/claims-vertical/issues/02-claims-pack-and-seeding.md`
- `.scratch/claims-vertical/issues/03-multi-sheet-instantiation.md`
- `.scratch/claims-vertical/issues/04-excel-import.md`
- `.scratch/claims-vertical/issues/05-row-analysis-domain-hints.md`

## Comments

- 2026-10-02：端到端收口复测唯一阻断项「含样例数据建簿 datetime 强转失败」经任务 2ffbc97b 修复（web/src/lib/workbooks.ts 按列 field_type 还原退化值），生产部署腿复测为最终确认步骤；其余 AC 已由 CLAIMSE2E 验收链完成，状态收口为 done。
