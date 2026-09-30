Status: done
Label: ready-for-agent

# CV-02 — 破产债权模板包数据与选择性播种

## Parent

`.scratch/claims-vertical/PRD.md`

## What to build

以独立数据文件交付破产债权模板包。至少包含债权人表（名称、证件类型/号码、联系人、联系方式、地址）与债权申报表（债权人引用、申报金额、利息、债权性质单选、申报日期、证据材料说明、审查状态单选、审定金额、审查意见），并提供常见 Excel 列别名、领域提示和一个数个债权人／十余笔申报的小样例。性质和状态字段可直接用于分组聚合。

先复核 OIP-07/08 及现有 `shared/sql/template-packs/bankruptcy-claims.surql`、`WORKSPACE_TEMPLATE_PACKS`：已有数据和播种链路应复用。PRD 中的 `shared/template-packs/`、`TEMPLATE_PACKS` 是建议名称；现行独立数据目录和配置名若满足能力则沿用，不平行新建第二套。现有包的数据表形状与本 PRD 不完全相同，须按本票验收标准补齐或明确数据迁移与兼容路径；任何改写／删除生产既有数据的方案先按项目红线上报。

## Acceptance criteria

- [x] 模板数据具备上述两张表的字段、债权申报到债权人的引用、性质与状态选项、别名、领域提示和类型合法的关联样例；检查字段可用于聚合。
- [x] 新 workspace 只在配置选中该包时播种；配置为空时不含法律模板，空白工作簿可用。
- [x] 播种幂等；未知包或执行失败遵循现有 workspace 创建补偿，已有 workspace 可由管理员安装而不重复 key。
- [x] 数据文件和脱敏 fixture 可单独删除；平台实现无需按包名或行业词分支。
- [x] 用真实数据库验证播种、引用、管理员增删模板行及不播种路径。
- [x] 最高约束：仓库代码、平台 schema、平台 prompt 不得出现法律领域词汇；法律内容必须能经不 seed／删除模板行整体移除。

## Scope handoff

本票只交付领域数据和通用播种接线；不写针对法律的 TypeScript 业务分支。CV-03 消费模板定义，CV-04 消费列别名，CV-05 消费领域提示。现有 OIP-08 的三表演示和本 PRD 的两表清单须在实施记录中逐字段对照。

## Blocked by

- `.scratch/claims-vertical/issues/01-template-package-schema.md`

## Comments

- 2026-09-30 CV-02 实施记录：
  - 复用结论：沿用现行 `shared/sql/template-packs/` 数据目录、`loadTemplatePackScripts` 加载器与 `WORKSPACE_TEMPLATE_PACKS` 配置（OIP-07 链路完整满足本票能力：空配置不读包文件、未知包明确报错、顺序执行、失败走 workspace 创建补偿），未平行新建第二套。PRD 建议名仅是命名建议。
  - 包形状按 PRD 两表清单重写（包 key 不变 `bankruptcy-claims`，幂等升级）。
  - OIP-08 三表演示 → 两表清单逐字段对照：
    - creditors 表保留并对齐 PRD：`creditor_name`/`contact_name`/`contact_phone` 保留；`identity_number` 保留（label 改「证件号码」）并新增 `identity_type`（PRD「证件类型/号码」拆分）；新增 `address`。别名扩充（申报人/债权人/企业名称/名称 等）。
    - creditors 表上的债权语义字段迁往新 `claims` 表：`claim_type`→`claim_nature`（label 债权性质，选项 普通/有财产担保/劳动/税款/劣后）；`declared_amount`、`declared_date` 平移；`reviewed_amount`（label 改「审定金额」，改 optional，未审定记录为空）；`review_status`（label 改「审查状态」，选项改审查口径 待审查/审查中/已审定/部分审定/不予审定）；`evidence_status`（单选）→ `evidence_note`（证据材料说明，文本，承接 PRD 字段语义）；`notes` → `review_opinion`（审查意见）。新增 `interest_amount`（利息，optional）。
    - `claims.creditor` 引用 `creditors`（`reference_sheet_key`/`reference_display_key: creditor_name`），即 PRD 的「债权申报→债权人引用」。
    - `materials`（证据材料）演示表不保留：材料级登记超出 PRD 两表清单，其语义由 `claims.evidence_note` 承载。`tasks`（待办事项）演示表不保留：审查待办语义由 `review_status` 流转 + `row_analysis.review_points`（缺失项清单、待办建议）+ `quick_tasks` 承接。
    - `default_dashboard` 六组件全部改 claims/creditors 维度（总申报金额、总审定金额、待审查申报、债权性质分布、审查状态分布、最近申报）；`quick_tasks` 六项（含 1 个 write 提案任务）同口径改写。
    - 样例：6 债权人（企业/个人/机关混合）+ 12 笔申报（性质 4 类、状态 5 类、已审定/部分审定带审定金额与意见，其余为空），引用全部指向本次样例债权人 key。
  - 播种与兼容路径（无生产数据改写）：播种只发生在新 workspace 创建（配置选中时）或管理员在已有 workspace 显式重跑数据文件；`ON DUPLICATE KEY UPDATE` 只更新声明字段，顶层 `column_defs` 不进更新列表（管理员旧兼容输入保留）、`check_rules` 等管理员自定义不覆盖、自定义模板行不受包重跑影响。已实例化工作簿与实体数据不受数据文件变更影响（模板行 ≠ 实例数据）。
  - OIP-18 每日债权风险 MVP 现状（两端按包名 + 旧 sheet key 绑定：`server/ai/office/surreal-claims-risk-store.ts`、`web/src/lib/risk-notifications.ts`）：存量工作簿行为不变；新形状工作簿开启提醒后确定性规则匹配不到旧字段、产生零提醒（静默降级，不报错）。其通用化不在本票范围（本票不写针对法律的 TS 业务分支），建议 VER-03 之后的办公室簇收口。
  - OIP-14 xlsx 用例随三表演示移除（其 fixture 映射的 materials/tasks 目标表不存在；fixture 文件本身未动），Excel 导入验收归 CV-04。
  - 测试：新增 `server/src/workspaces/template-pack-seeding.integration.test.ts`（spawn 内存 SurrealDB 3.2.3，4 例：播种后包行全字段落库且引用/样例/聚合维度合法；空配置不播种且库内无模板行；幂等重跑不重复 key、不覆盖未声明字段、管理员增删模板行与成员只读；非法包执行不留半行 + 未知包明确报错）。更新 `shared/sql/template-packs/index.test.ts`（纯数据文件断言、两表形状、幂等更新字段清单）与 `web/src/lib/bankruptcy-claims-template-pack.integration.test.ts`（新形状实例化：两表、6+12 样例、引用回读、仪表盘真实聚合）。该 web 测试 harness 补齐 legacy 配额 schema（按文件原样应用 020 并放宽占位计划数值）——修复其样例路径在当前引擎下的既有破损；同文件内既有的 OIP-02/03/04/05 与 3.2.3 事务契约 gated 测试在本地 3.2.3 引擎下的失败为 main 既有状况（本票未触碰，CI 不跑）。
  - 发现的既有残留（非本票引入，供 CV-05/收口参考）：`shared/src/ai-context.ts` display-name 正则含「债权人」。
  - 最高约束核对：平台 schema 零新增（CV-01 契约已覆盖，无新增量）；平台实现零改动（server/web 平台代码本 PR 只动测试与 020 文件应用方式）；法律词汇仅存在于数据文件与其测试 fixture（随文件可整体删除，沿用 OIP-08 既有先例）。
  - 验证：`surreal validate` 语法 OK；shared 包 loader 测试 6/6；server 播种集成测试 4/4（真实 SurrealDB，322 断言）；web 包集成测试 3/3（真实 SurrealDB，实例化/引用/仪表盘聚合数字断言）；web 全量套件 548 pass 0 fail；shared 全量 0 fail；`pnpm typecheck` 0 errors；`pnpm lint` 0 warnings。
