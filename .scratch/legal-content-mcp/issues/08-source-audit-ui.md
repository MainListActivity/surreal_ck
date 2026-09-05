Status: blocked
Label: needs-triage
Assignee: unassigned
ID: SCK-LCM-08
Repository: surreal_ck

# 补来源登记、批次状态与审计入口

Parent: [实施规格](../PRD.md)

## Dependencies

- [04-ops-app](04-ops-app.md)
- [05-batch-validation](05-batch-validation.md)
- [06-publication](06-publication.md)

## Scope

- ops 增加最小来源登记及许可修订、批次列表/详情和审计查询，复用数据维护服务。
- 来源配置版本化，不允许采集数据包自行改变许可；来源待核验不等于获准发布。
- 展示新增/重复/失败/警告、发布进度和 actor，支持定位失败批次，不建设可视化爬虫与清洗编辑器。

## Acceptance

- [ ] 有相应能力运营能登记来源，使 get_data_contract 可分页发现；客户拒绝。
- [ ] 许可修订审计完整，历史批次仍能解释当时校验依据。
- [ ] 大批次分页、失败提示及与 MCP 结果一致性验证。

## Handoff

- 实施前读取仓库 AGENTS.md 和相关技能；SurrealQL、Mastra 等按任务实际涉及加载。
- 完成后记录改动、验证命令与结果及剩余限制；依赖完成后将下游转为 open/ready-for-agent，不提前声明交付。
- 本票只授权自身实现范围，不隐含线上部署、真实来源商用发布或外部账号配置修改。

