Status: done
Label: done
Assignee: /root/research_surrealdb_ddl

# 摸清 SurrealQL 资源定义与权限扩展面

## Parent

[`SurrealDB 原生配额与 surreal_ck 订阅控制面决策地图`](../PRD.md)

## Question

在当前 `/Users/y/IdeaProjects/surrealdb` 源码版本中，要新增一种可被定义、修改、移除和查询的原生配额资源，真实需要经过哪些 parser、AST、revisioned serialization、catalog/KV key、cache、executor、IAM capability、INFO/export/import 和测试扩展点？现有哪一种资源定义最适合作为结构参照，哪些表面相似但会导致错误的作用域或授权语义？

研究只陈述源码事实和候选 seam，不在本票决定最终语法。

## Expected asset

`.scratch/native-resource-quota-wayfinder/research/surrealdb-resource-definition-extension.md`

## Dependencies

- Blocked by: none
- Blocks: [`锁定首期可计费资源与口径`](04-billable-resource-taxonomy.md)、[`确定配额策略的作用域、继承与管理权限`](05-policy-scope-inheritance-authority.md)、[`设计原生配额 SurrealQL、错误与可观测契约`](08-native-surrealql-errors-observability.md)

## Comments

- Resolution: [研究报告](../research/surrealdb-resource-definition-extension.md) 已完成；结论是以 Sequence 复用完整资源定义机械链路、以 Database lifecycle 校准父层授权，不能照搬 Sequence 的 `Base::Db` 管理语义。
