Status: blocked
Label: needs-triage
Assignee: unassigned
ID: SCK-LCM-02
Repository: surreal_ck

# 建立平台内容库与受限维护身份

Parent: [实施规格](../PRD.md)

## Dependencies

- [01-contract-fixtures](01-contract-fixtures.md)

## Scope

- 新增 shared/sql/platform-content/ 增量及 server/src/content/ 持久化适配层，复用 05 的通用目录、许可、版本与发布模型。
- 实现来源、版本、法条、引用/解析、批次/校验、发布事件与可服务投影；系统归属用字段，有业务属性引用用关系。
- root 仅建库/迁移/凭证初始化；日常维护使用受限 publisher，禁止任意改写历史版本。
- 明确受控写入入口与数据库权限如何共同保证不可变性；不把完整 publisher DML 当作足够权限隔离。

## Acceptance

- [ ] 实际配额 fork CLI 校验并在临时数据库执行迁移，重复应用安全。
- [ ] 客户会话不能读取 staging/审计、不能写平台内容；publisher 不能绕过入口改写历史版本。
- [ ] 唯一冲突、旧法引用、同案不同文书和字段日期 SDK 类型一致性测试通过。

## Handoff

- 实施前读取仓库 AGENTS.md 和相关技能；SurrealQL、Mastra 等按任务实际涉及加载。
- 完成后记录改动、验证命令与结果及剩余限制；依赖完成后将下游转为 open/ready-for-agent，不提前声明交付。
- 本票只授权自身实现范围，不隐含线上部署、真实来源商用发布或外部账号配置修改。

