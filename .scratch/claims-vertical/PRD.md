Status: ready-for-agent
Label: ready-for-agent

# PRD: 律师破产债权管理垂直簇（claims-vertical）

> 对应 ADR：
> - [`docs/adr/frontend-direct-connect.md`](../../docs/adr/frontend-direct-connect.md)（业务数据浏览器直连）
> - [`docs/adr/workspace-as-database.md`](../../docs/adr/workspace-as-database.md)（workspace ↔ database、三类身份）
>
> 对应领域词汇：[`CONTEXT.md`](../../CONTEXT.md) §工作簿 / §数据表 / §字段 / §记录 / §引用 / §模板 / §子 agent

## Problem Statement

第一个交付客户是管理破产重整企业债权的律师（管理人团队）。当前产品是一个通用的"数据表 = 数据库表"协作工具：平台底座（workspace 隔离、直连编辑器、Router workflow、行分析 agent）已经就位，但交付那天律师拿到的是一个空白工具——

1. 没有任何破产债权领域的**模板**：律师需要自己从零设计债权人表、债权申报表的字段结构，而这正是他们购买产品想跳过的工作。
2. 债权申报数据的现实来源是 Excel（法院/债权人邮寄或线上申报导出），但产品没有 Excel 导入能力，几百上千条申报记录无法迁入。
3. 行分析 agent 的 prompt 和 tool 描述里硬编码了"债权"措辞，但没有真正的领域知识（申报金额 vs 审定金额的审查语义、债权性质分类规则）；同时这份硬编码反过来阻碍了产品作为**通用 agent 工具**交付给非法律客户——届时需要改代码才能去掉法律内容。

核心矛盾：垂直内容要足够深才能让律师开箱即用，又必须以"可整体移除、数据库可配置"的形态存在，不能渗入平台代码。

## Solution

引入**模板包**机制：法律领域的全部垂直内容（数据表结构、表间引用、样例数据、Excel 列别名、agent 领域提示）收敛为 workspace database 内 `workbook_template` 表的数据行。平台代码只认识模板包的形状，不认识"债权"二字。

- **交付律师客户**：workspace 创建时按部署配置 seed 破产债权模板包。律师在新建工作簿时选择"破产债权管理"模板，一次得到债权人表 + 债权申报表（含引用、债权性质枚举、审查状态流转字段），可选带样例数据。
- **导入存量数据**：在任意数据表上可从 Excel 导入记录；当数据表来自模板时，模板携带的列别名让"债权人名称 / 申报金额"等常见表头自动对位，律师只需确认映射。
- **AI 审查辅助**：行分析 agent 运行时从当前工作簿关联的模板包读取领域提示注入指令——分析债权行时它知道"审定金额需要有审查依据""债权性质影响清偿顺序"；在没有领域提示的工作簿上它回退为通用行分析。
- **交付通用客户**：部署时不启用法律模板包（或在库里删除该行），产品即为纯通用工具，代码零改动。

## User Stories

1. As a 破产案件管理人律师（工作区管理员）, I want 从"破产债权管理"模板一键创建工作簿, so that 我不用从零设计债权人表和债权申报表的字段结构。
2. As a 工作区管理员, I want 模板创建出的数据表自带债权性质（普通/有财产担保/劳动/税款等）单选字段和审查状态字段, so that 团队录入口径从第一天就统一。
3. As a 工作区管理员, I want 模板创建出的债权申报表通过引用字段指向债权人表, so that 同一债权人的多笔申报不重复维护债权人信息。
4. As a 工作区管理员, I want 创建时选择是否带样例数据, so that 我可以先用样例演示给团队看，也可以直接建干净的表。
5. As a 工作区管理员, I want 把法院或线上申报系统导出的 Excel 导入债权申报表, so that 几百条存量申报记录不用手工录入。
6. As a 普通成员（律所协作律师）, I want 在导入前看到列映射预览和类型校验报告, so that 表头不规范或金额格式错误的行在落库前就被发现。
7. As a 普通成员, I want Excel 表头与模板列别名自动对位, so that "申报人/债权人名称"这类同义表头不需要逐列手动映射。
8. As a 普通成员, I want 导入失败的行带行号和原因反馈, so that 我可以修正原始 Excel 后重新导入失败部分。
9. As a 审查人员（普通成员）, I want 选中一条债权申报记录后让 AI 分析缺失和矛盾, so that 我能快速看出证据材料、利息计算等需要补充的点。
10. As a 审查人员, I want AI 在建议审定金额时给出依据说明, so that 我能判断是否采纳，而不是盲信一个数字。
11. As a 审查人员, I want AI 的字段补全以提案形式出现、由我确认后写入, so that 审查结论始终由人签字负责。
12. As a 工作区管理员, I want agent 的领域知识跟随工作簿的模板而变化, so that 同一个工作区里债权工作簿有债权语境、其他工作簿不被法律措辞污染。
13. As a 交付工程师, I want 通过部署配置决定 seed 哪些模板包, so that 交付通用客户时不启用法律包即可，零代码改动。
14. As a 交付工程师, I want 在数据库中直接增删改模板包行即可调整模板, so that 客户定制字段结构不需要发版。
15. As a 工作区管理员, I want 平台 UI 在没有任何模板包时仍然完整可用（仅创建空白工作簿）, so that 模板是增强而非依赖。
16. As a developer, I want 模板实例化复用与手工建簿同一条"DDL + workbook + sheet"原子事务路径, so that 模板建出的工作簿与手工建的在结构上无任何特殊性。
17. As a developer, I want Excel 解析与列映射是与 UI 无关的纯逻辑模块, so that 类型推断和别名匹配可以被独立测试。
18. As a developer, I want agent 领域提示的加载是一个独立模块、缺失时静默回退, so that 行分析 agent 的通用行为不依赖任何模板包存在。
19. As an administrator, I want 模板实例化与导入都以当前用户会话直连执行, so that DDL 权限由 access 类型硬隔离、行级权限由 PERMISSIONS 兜底，与手工操作同一边界。
20. As a 审查人员, I want 用自然语言让 AI 基于债权数据生成统计图表（按债权性质分布、申报与审定金额对比）, so that 债权人会议材料不用手工拼。（依赖 D3 dashboard 簇，本簇只保证模板字段结构对聚合友好）

## Implementation Decisions

### 模板包数据层（平台通用 schema）

- workspace database 内新增 `workbook_template` 表，进 `shared/sql/workspace-template/` 增量（平台 schema 通用，不含任何法律内容）。
- 一行 = 一个模板包，字段：唯一 `key`、展示名、描述、`sheets` 定义数组（每张数据表的 label、列定义、列别名数组、指向同模板内其它表的引用声明）、可选样例记录、可选 agent 领域提示对象。
- 列定义复用现有 storedDef（snake_case）形状，与 `sheet.column_defs` 同口径——模板不发明第二套字段描述语言。
- PERMISSIONS：同 workspace 登录用户可读；仅工作区管理员可写（增删改模板行 = 管理员在库里配置）。
- 法律模板包内容以**数据文件**（非代码）形式放在仓库 `shared/template-packs/` 下；workspace 创建 lifecycle（Workspace Scope Module，root 路径）按部署环境变量（如 `TEMPLATE_PACKS`）决定 seed 哪些包。不启用 = 该 workspace 无此模板。已存在的 workspace 可由管理员直接在库中插入/删除模板行。

### 模板实例化模块（前端纯逻辑 + 直连执行）

- 扩展现有"建实体表 DDL + workbook + sheet"单事务构造器为多数据表版本：预生成全部表名/RecordId → 逐表 DDL（含引用字段指向同事务内其它新表）→ workbook（写 `template_key`）→ 多条 sheet → 可选样例记录 INSERT，整体 `BEGIN/COMMIT` 原子。
- 引用字段的目标表名在事务构造期已知（同模板内 key 预生成），不存在两阶段创建。
- 样例数据按用户在创建对话框中的选择决定是否包含。
- 以工作区管理员会话直连执行（DDL 需要 admin access，与手工建簿一致）；普通成员看不到"从模板创建"以外的失败惊喜——权限错误沿用现有中文翻译。

### Excel 导入模块

- 解析层：SheetJS 读 .xlsx/.xls/.csv → 提取表头行与数据行，纯函数、不触网络。
- 映射层（纯逻辑）：表头 ↔ 目标数据表列的匹配，优先级：精确列名 → 模板列别名 → 大小写/空白宽松匹配；未匹配列留给用户手动指定或忽略。
- 类型规整（纯逻辑）：按目标字段类型做单元格强制转换（数字去千分位、日期多格式解析为 datetime、单选值必须命中 options），产出"可导入行 + 拒绝行（行号 + 原因）"报告。
- 落库：确认映射后分批 INSERT，以当前用户会话直连执行；引用字段值按显示值在目标表内查找匹配，找不到的记为拒绝行（不自动创建被引用记录）。
- 导入面向任意数据表（通用能力），模板列别名只是让模板建出的表自动对位——非模板表同样可手动映射导入。

### Agent 领域提示去硬编码

- 行分析 agent（现 claim-analysis agent）的 instructions 与 tool 描述去掉"债权"硬编码，统一为通用"行分析 / 字段补全提案"措辞；CONTEXT.md 中该子 agent 本就叫"行分析"。
- 新增领域提示加载模块：按当前分析目标的 workbook `template_key` 查 `workbook_template` 行内 agent 领域提示对象（领域背景、字段语义说明、分析侧重点），在每次 run 装配 agent 时拼入 instructions；查不到或为空时注入零内容，agent 行为退化为通用行分析。
- 提示注入走 Mastra 的运行期 instructions 组装路径（实施时以 `mastra` skill 核对当前版本 API）；tool 侧继续用 `context.surrealSession` 以调用者会话读模板行。
- 法律领域提示内容（申报金额/审定金额审查语义、债权性质与清偿顺序、常见缺失项清单）全部存于法律模板包数据行，仓库代码与平台 prompt 中不出现。

### 破产债权模板包内容（数据，非代码）

- 数据表一：债权人（名称、证件类型/号码、联系人、联系方式、地址）。
- 数据表二：债权申报（债权人引用、申报金额、利息、债权性质单选、申报日期、证据材料说明、审查状态单选、审定金额、审查意见）。
- 列别名覆盖法院/常见申报系统导出表头的同义词。
- agent 领域提示覆盖审查场景：缺失项检查清单、审定金额依据要求、债权性质分类提示。
- 样例数据：一个可演示的小案件（数个债权人、十余笔申报，含已审/待审混合状态）。
- 字段结构对 GROUP BY 聚合友好（债权性质、审查状态可直接作分组维度），为 D3 dashboard 簇的图表场景预留。

## Testing Decisions

- 好测试只验外部可见行为：构造出的事务 SQL/bindings 形状、落库后的记录、映射报告内容、装配出的 instructions 是否含/不含领域提示——不断言内部实现与 prompt 全文措辞。
- 四个深模块全部走 TDD（先一个行为测试，再最小实现）：
  - **模板包数据层**：schema 增量幂等、模板行读写权限（管理员可写 / 成员只读），prior art：`shared/sql/workspace-template/index.test.ts`。
  - **模板实例化**：多表事务构造（表名预生成、引用字段指向正确、样例数据开关）、与现有空白建簿同形状，prior art：`web/src/lib/workbooks.test.ts`。
  - **Excel 解析映射**：表头识别、别名对位、类型规整、拒绝行报告，纯函数测试不依赖浏览器，prior art：`web/src/lib` 下各纯逻辑层测试（tool-drafts、reference-cache 等）。
  - **领域提示加载注入**：有模板提示 → instructions 含领域内容；无模板/无提示 → 通用措辞且不报错；会话边界用 fake surrealSession，prior art：`server/ai/mastra/tools/*-session.test.ts`、`agents/sub-agents.test.ts`。
- LLM 行为继续藏在确定性 adapter 后（沿用 fake llmCaller 模式），测试不打真模型。
- 端到端验收（种子模板 → 导入 Excel → AI 行分析 → 确认写回）作为簇收口的**手工验收清单**执行，不在本簇内自动化。

## Out of Scope

- 债权人会议、表决分组、清偿方案模拟等更深的破产业务流程——先把"申报-审查"一段做穿。
- 模板包的可视化管理 UI（建/编辑模板走数据库直接操作；管理 UI 待有第二个垂直包后再立项）。
- AI 图表生成与持久化的前端链路（属 D3 dashboard 簇与 agentic-ai-product 重 triage 后的 issue）。
- 导入时自动创建被引用记录（引用值未命中一律拒绝行，保守优先）。
- 文书/PDF 证据材料的上传与解析（资源检索簇的领域）。
- 法律法规检索、相似案例（resource-retrieval 簇的 `legal_case` / `legal_article` 类型迭代）。
- 多语言模板内容。

## Further Notes

- 平台与垂直内容的分界线是本簇的最高约束：**仓库代码、平台 schema、平台 prompt 中不得出现法律领域词汇**；所有法律内容必须能通过"不 seed 模板包 / 删除模板行"整体移除。Code review 时以此为第一检查项。
- CONTEXT.md 需要随本簇更新："模板"现定义为"创建工作簿的方式而非一等资源"，模板包落库后应升级为正式领域词（**模板包** = `workbook_template` 行），并为行分析 agent 的"领域提示"补术语条目。
- 现有 `claim-analysis-agent` 文件名与 agent id 含 claim 字样，去硬编码时一并更名为行分析（row-analysis）口径，避免新读者误以为平台耦合法律领域。
- 簇内 issue 拆分建议顺序：模板包 schema → 法律包数据文件 + seed 接线 → 模板实例化 + 创建入口 UI → Excel 导入（解析映射 → UI → 落库）→ 领域提示注入 → 收口手工验收。拆 issue 用 `/to-issues`。
