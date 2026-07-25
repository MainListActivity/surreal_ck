Status: done
Label: done
Assignee: /root/research_surrealdb_tx

# 摸清 SurrealDB 写路径与事务内计量扩展面

## Parent

[`SurrealDB 原生配额与 surreal_ck 订阅控制面决策地图`](../PRD.md)

## Question

在当前 `/Users/y/IdeaProjects/surrealdb` 源码版本中，表定义与删除、记录创建与删除分别会从哪些语句和内部路径进入事务？研究必须覆盖至少 CREATE、INSERT、UPSERT、RELATE、批量/导入、DELETE、DEFINE/REMOVE TABLE 及事务回滚，并说明各 KV backend 的冲突检测或锁语义能否支持“配额计数与资源变更同事务、并发下不超卖”。最小且不会遗漏旁路的强制 seam 在哪里？

研究只陈述源码事实、旁路清单与候选 seam，不在本票选择最终账本算法。

## Expected asset

`.scratch/native-resource-quota-wayfinder/research/surrealdb-transactional-enforcement-extension.md`

## Dependencies

- Blocked by: none
- Blocks: [`锁定首期可计费资源与口径`](04-billable-resource-taxonomy.md)、[`选择原生策略与用量账本的数据模型`](06-native-policy-usage-model.md)、[`定义事务内配额消费、释放与批量写语义`](07-transactional-consumption-semantics.md)

## Comments

- Resolution (2026-07-24): [研究报告：SurrealDB 写路径与事务内配额强制扩展面](../research/surrealdb-transactional-enforcement-extension.md) — 当前没有天然单点 hook；无旁路的候选扩展面必须同时覆盖 table catalog 转换、统一后的 typed record mutation 与整表前缀删除，并以各 KV backend 可验证的事务竞争语义保证并发不超卖。
