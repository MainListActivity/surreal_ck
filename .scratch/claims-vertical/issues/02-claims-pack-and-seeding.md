Status: ready-for-agent
Label: ready-for-agent

# CV-02 — 破产债权模板包数据与选择性播种

## Parent

`.scratch/claims-vertical/PRD.md`

## What to build

以独立数据文件交付破产债权模板包。至少包含债权人表（名称、证件类型/号码、联系人、联系方式、地址）与债权申报表（债权人引用、申报金额、利息、债权性质单选、申报日期、证据材料说明、审查状态单选、审定金额、审查意见），并提供常见 Excel 列别名、领域提示和一个数个债权人／十余笔申报的小样例。性质和状态字段可直接用于分组聚合。

先复核 OIP-07/08 及现有 `shared/sql/template-packs/bankruptcy-claims.surql`、`WORKSPACE_TEMPLATE_PACKS`：已有数据和播种链路应复用。PRD 中的 `shared/template-packs/`、`TEMPLATE_PACKS` 是建议名称；现行独立数据目录和配置名若满足能力则沿用，不平行新建第二套。现有包的数据表形状与本 PRD 不完全相同，须按本票验收标准补齐或明确数据迁移与兼容路径；任何改写／删除生产既有数据的方案先按项目红线上报。

## Acceptance criteria

- [ ] 模板数据具备上述两张表的字段、债权申报到债权人的引用、性质与状态选项、别名、领域提示和类型合法的关联样例；检查字段可用于聚合。
- [ ] 新 workspace 只在配置选中该包时播种；配置为空时不含法律模板，空白工作簿可用。
- [ ] 播种幂等；未知包或执行失败遵循现有 workspace 创建补偿，已有 workspace 可由管理员安装而不重复 key。
- [ ] 数据文件和脱敏 fixture 可单独删除；平台实现无需按包名或行业词分支。
- [ ] 用真实数据库验证播种、引用、管理员增删模板行及不播种路径。
- [ ] 最高约束：仓库代码、平台 schema、平台 prompt 不得出现法律领域词汇；法律内容必须能经不 seed／删除模板行整体移除。

## Scope handoff

本票只交付领域数据和通用播种接线；不写针对法律的 TypeScript 业务分支。CV-03 消费模板定义，CV-04 消费列别名，CV-05 消费领域提示。现有 OIP-08 的三表演示和本 PRD 的两表清单须在实施记录中逐字段对照。

## Blocked by

- `.scratch/claims-vertical/issues/01-template-package-schema.md`
