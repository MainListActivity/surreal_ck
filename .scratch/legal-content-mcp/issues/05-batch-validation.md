Status: blocked
Label: needs-triage
Assignee: unassigned
ID: SCK-LCM-05
Repository: surreal_ck

# 实现成品接收、去重与不可变校验

Parent: [实施规格](../PRD.md)

## Dependencies

- [01-contract-fixtures](01-contract-fixtures.md)
- [02-content-schema](02-content-schema.md)
- [03-operator-auth](03-operator-auth.md)

## Scope

- 实现同一维护服务供 HTTP/MCP 使用，整份接收并拆分法条和引用，批次/条目持久化。
- 幂等键按运营和动作隔离，同键异载荷冲突；同来源相同内容为重复，跨来源相似为候选。
- 确定性校验与解析优先；未知版本、引用歧义保留警告，不依赖模型生成 verified。
- 校验修订绑定内容哈希、规则和依据，分页固定修订；重启可恢复任务，来源未登记返回明确错误。

## Acceptance

- [ ] 真实/合成 fixture 均有明确边界；完整正文在处理链中不截断，定位可复核。
- [ ] 并发重复提交不重复创建，超限、重复引用、同号不同文书和错误哈希测试通过。
- [ ] 失败项独立返回；批次成功不意味着已发布，许可不足阻断发布。

## Handoff

- 实施前读取仓库 AGENTS.md 和相关技能；SurrealQL、Mastra 等按任务实际涉及加载。
- 完成后记录改动、验证命令与结果及剩余限制；依赖完成后将下游转为 open/ready-for-agent，不提前声明交付。
- 本票只授权自身实现范围，不隐含线上部署、真实来源商用发布或外部账号配置修改。

