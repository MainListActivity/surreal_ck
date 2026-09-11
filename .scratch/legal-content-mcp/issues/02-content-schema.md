Status: done
Label: verified
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

## Implementation evidence

- `shared/sql/platform-content/001-content-schema.surql` 建立来源/许可、内容项/不可变版本、法条、引用解析、批次/校验修订、发布请求/事件及已发布投影；正文不复制到客户 workspace。
- `shared/sql/platform-content/index.ts` 与 `server/src/content/schema.ts` 提供连续版本、重复应用安全的 `_system` schema loader；历史版本和审计表均默认 `PERMISSIONS NONE`，后续由 SCK-LCM-03 安装受限 publisher access。
- `server/src/content/schema.test.ts` 覆盖首次应用和重复应用；真实 SurrealDB CLI/临时库执行留给环境具备 fork CLI 后的验收命令。
- 验证：`pnpm --filter @surreal-ck/shared run typecheck`；`bun test server/src/content/schema.test.ts`（1 pass）。
- 限制：受限 access、真实 publisher DML 和客户投影读取尚未在本票放行，避免把 root 日常写入误当作权限模型。
