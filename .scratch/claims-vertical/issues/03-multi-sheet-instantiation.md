Status: done
Label: done

# CV-03 — 模板多表原子实例化与创建入口

## Parent

`.scratch/claims-vertical/PRD.md`

## What to build

从模板创建工作簿时，复用现有手工建簿的原子事务构造路径：预生成全部实体表名和 RecordId，解析同模板内引用，再在一个事务中完成各表 DDL、workbook、sheet 及可选样例 INSERT。创建入口允许选模板和是否带样例；无模板时继续创建空白工作簿。当前管理员浏览器会话直连执行，沿用现有中文权限错误。

先复核 OIP-02/03/04、`web/src/lib/workbooks.ts` 与现有创建 UI；已有多表、跨表引用和样例开关不重做。现行 `workbook.template` 是模板记录引用，若它能可靠关联模板行，则沿用而不另增平行的 `template_key` 字段；在交接中记录该取舍。

## Acceptance criteria

- [x] 一次创建生成模板声明的全部实体表与 sheet，引用指向本次实例的新表；重复实例彼此隔离。
- [x] 有样例／无样例两种选择均正确；无效引用、字段类型错误或中途失败时整体回滚，无半成品。
- [x] workbook 保留稳定模板关联；空白建簿行为和旧单表模板兼容。
- [x] 管理员直连可创建，成员无法通过 UI 或直接请求越过数据库 DDL 权限；不新增后端业务 CRUD endpoint。
- [x] 先写外部可见行为测试，验证事务结果、回滚、权限和 UI 入口。
- [x] 最高约束：仓库代码、平台 schema、平台 prompt 不得出现法律领域词汇；法律内容必须能经不 seed／删除模板行整体移除。

## Scope handoff

本票只处理通用实例化和创建入口，不内置任何垂直字段。CV-04 使用生成后的数据表与别名；CV-06 验收整条链路。

## Blocked by

- `.scratch/claims-vertical/issues/01-template-package-schema.md`
- `.scratch/claims-vertical/issues/02-claims-pack-and-seeding.md`

## Delivered — 2026-09-30 CV-03

- 复用 OIP-02/03/04 的多表原子事务、模板内引用预解析、样例开关及 TemplatesScreen；不新建后端业务 CRUD。`workbook.template` 的 `record<workbook_template>` 关联及 `sheet.template_sheet_key` 已可靠落库，沿用现行契约，不增加 `template_key`。
- TDD 补两处边界：模板记录标识改为 SDK RecordId binding（先失败、后通过）；多语句事务保留实际语句错误，避免 SDK 第一个回滚占位提示掩盖成员 DDL 权限或样例字段类型错误（先失败、后通过）。UI 转换异常现展示中文创建失败提示，并解除创建中状态，可重试；浏览器验证修复前无 alert、修复后有 alert 且未调用写入 store。
- 新增默认运行的 `web/src/lib/template-creation.integration.test.ts`：独立内存 SurrealDB 3.2.3、完整 workspace schema、原样管理员 JWT access 与 participant RECORD JWT access（两者都带 RL=Owner）。6 项验证两实例表/样例/引用隔离与模板关联、关闭样例/空白/旧单表兼容、无效引用/字段类型拒绝、末段样例类型失败全回滚、第二表元数据冲突全回滚、成员绕过 UI 直接调用仍拒绝 DDL并返回中文权限错误。回滚比较 workbook/sheet/DB tables/usage/activity 原始快照，覆盖 DDL 与事件副作用。
- 为 shared workspace-template 补 types/default 条件导出，并删除 web tsconfig 映射到 `.d.ts` 的旧覆盖；TypeScript 读声明，Bun 读运行时实现，避免类型构建后加载声明文件；仍通过 `@surreal-ck/shared/workspace-template` 包导出引用。
- 浏览器夹具位于 `web/test-fixtures/template-creation/`（含复现 README），加载真实页面和 DTO 转换，以中性模板和权限/写入 store 替身验证 UI；不是生产或全站端到端验证。ego-browser 实测默认样例、切换空台账、成功打开、成员入口/样例禁用及程序触发 guard、空模板、转换异常提示。数据库效果另由上述真实集成测试验证。
- 最高约束：本次新增平台实现/测试只使用设备运维等中性词，不按模板包名或行业分支；未新增 schema、prompt 或内置模板内容。删除模板行后空白建簿已真实验证。历史 OIP 的领域 fixture/其他模块残留归对应票/簇收口，不在本票扩展改写。
- 验证：相关 3 文件 50 pass；web 全量 556 pass / 18 skip / 0 fail（新增 6 项真实事务默认运行）；`pnpm lint` 0 warnings/errors；`pnpm typecheck` 0 errors（规则弹窗 2 项既有 Svelte warning）；web production build 成功。
- 全仓 `pnpm test` 本机 server OIDC 4 项失败，共享 main 同样 1 pass/4 fail；固定端口 18081 被另一个进程占用。将同一 OIDC 测试临时副本改为独立空闲端口后 5 pass/0 fail，副本已删除，未停止其他进程或修改服务端测试。CI 结果见实现 PR，由独立复核者确认。
- 无数据库迁移、生产已有数据修改、新环境变量或主机准备。本测试使用上游 3.2.3 验证 SQL/会话契约，不作为生产 fork 原生配额验收；生产验证归后续批准的合入部署任务。
