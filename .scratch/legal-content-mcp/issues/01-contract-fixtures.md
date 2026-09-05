Status: open
Label: ready-for-agent
Assignee: unassigned
ID: SCK-LCM-01
Repository: surreal_ck

# 冻结成品数据与五工具契约

Parent: [实施规格](../PRD.md)

## Dependencies

- 无前置实施票；依照已确认决策与真实样本冻结契约。

## Scope

- 将 v1 草案转为 shared/src/platform-content/ 的严格类型与运行时校验，五工具输入输出及 upsert/withdraw/restore 为明确类型分支。
- 固定不透明 ID、时间精度、版本/发布状态前提、错误码、分页与批次限制；50项/5MiB 为初始运行默认值，可配置并由契约返回。
- 从官方完整文书和法规获取允许使用的测试样本，记录证据与完整性；若原站无法稳定直取，保留可追溯人工获取方式，不以摘要冒充全文。
- 覆盖引用主体、采纳语境、逐引用版本与 UTF-8 定位；不依赖数据库表名。

## Acceptance

- [ ] 运行校验拒绝未知操作、伪造 actor、错误类型、非法定位、超限正文；业务未知与缺字段分开。
- [ ] 日期精度、重复引文、同号不同文书、撤回无需正文均有契约测试。
- [ ] 冻结 schema/协议版本及兼容策略；清楚标注合成与真实样本，未验证部分不伪报通过。

## Handoff

- 实施前读取仓库 AGENTS.md 和相关技能；SurrealQL、Mastra 等按任务实际涉及加载。
- 完成后记录改动、验证命令与结果及剩余限制；依赖完成后将下游转为 open/ready-for-agent，不提前声明交付。
- 本票只授权自身实现范围，不隐含线上部署、真实来源商用发布或外部账号配置修改。
