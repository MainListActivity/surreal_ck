Status: ready-for-agent
Label: ready-for-agent

# CV-03 — 模板多表原子实例化与创建入口

## Parent

`.scratch/claims-vertical/PRD.md`

## What to build

从模板创建工作簿时，复用现有手工建簿的原子事务构造路径：预生成全部实体表名和 RecordId，解析同模板内引用，再在一个事务中完成各表 DDL、workbook、sheet 及可选样例 INSERT。创建入口允许选模板和是否带样例；无模板时继续创建空白工作簿。当前管理员浏览器会话直连执行，沿用现有中文权限错误。

先复核 OIP-02/03/04、`web/src/lib/workbooks.ts` 与现有创建 UI；已有多表、跨表引用和样例开关不重做。现行 `workbook.template` 是模板记录引用，若它能可靠关联模板行，则沿用而不另增平行的 `template_key` 字段；在交接中记录该取舍。

## Acceptance criteria

- [ ] 一次创建生成模板声明的全部实体表与 sheet，引用指向本次实例的新表；重复实例彼此隔离。
- [ ] 有样例／无样例两种选择均正确；无效引用、字段类型错误或中途失败时整体回滚，无半成品。
- [ ] workbook 保留稳定模板关联；空白建簿行为和旧单表模板兼容。
- [ ] 管理员直连可创建，成员无法通过 UI 或直接请求越过数据库 DDL 权限；不新增后端业务 CRUD endpoint。
- [ ] 先写外部可见行为测试，验证事务结果、回滚、权限和 UI 入口。
- [ ] 最高约束：仓库代码、平台 schema、平台 prompt 不得出现法律领域词汇；法律内容必须能经不 seed／删除模板行整体移除。

## Scope handoff

本票只处理通用实例化和创建入口，不内置任何垂直字段。CV-04 使用生成后的数据表与别名；CV-06 验收整条链路。

## Blocked by

- `.scratch/claims-vertical/issues/01-template-package-schema.md`
- `.scratch/claims-vertical/issues/02-claims-pack-and-seeding.md`
