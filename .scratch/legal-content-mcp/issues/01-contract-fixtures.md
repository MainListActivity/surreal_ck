Status: done
Label: verified
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

## Implementation evidence

- `shared/src/platform-content/contracts.ts` 冻结 v1 数据与五工具 JSON 契约、错误码、分页字段和默认限制。
- `shared/src/platform-content/validation.ts` 提供请求大小、正文/证据字节数、重复目标、字段未知说明和 UTF-8 locator/bodyDigest 校验；actor 只能由 OAuth 注入。
- `shared/src/platform-content/fixtures.ts` 提供明确标记的合成完整文书及官方公开样本元数据；未把未保存的网页正文冒充可销售快照。
- 验证：`pnpm --filter @surreal-ck/shared run typecheck`；`pnpm --filter @surreal-ck/shared run test -- src/platform-content/contracts.test.ts`（6 pass）。
- 限制：真实官方全文快照、来源许可和数据库往返留给 SCK-LCM-02/05/10，不在本票中宣称已完成。
