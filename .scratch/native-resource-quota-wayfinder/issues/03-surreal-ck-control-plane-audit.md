Status: done
Label: done
Assignee: /root/research_surreal_ck

# 摸清 surreal_ck 现有配额与控制面迁移边界

## Parent

[`SurrealDB 原生配额与 surreal_ck 订阅控制面决策地图`](../PRD.md)

## Question

当前仓库的事件式配额、workspace 创建与迁移、root 控制面、浏览器直连 DDL、动态实体表创建、错误归一和测试分别落在哪里？哪些部分在原生配额引擎上线后应删除、保留为展示缓存、迁移为套餐控制面，或改为跨仓契约调用？仓库里是否已经存在 subscription/billing 的权威模型，还是只有静态 Plus / Pro / Max 套餐数据？

研究必须以当前源码、ADR、schema 和测试为证据，输出迁移影响清单，不替后续票决定产品语义。

## Expected asset

`.scratch/native-resource-quota-wayfinder/research/surreal-ck-control-plane-audit.md`

## Dependencies

- Blocked by: none
- Blocks: [`锁定首期可计费资源与口径`](04-billable-resource-taxonomy.md)、[`确定套餐、订阅与配额权益的权威模型`](09-subscription-entitlement-authority.md)、[`设计 surreal_ck 策略编译与调和流程`](10-policy-compilation-reconciliation.md)

## Comments

- Resolution (2026-07-24): [研究报告：surreal_ck 现有配额与控制面迁移边界审计](../research/surreal-ck-control-plane-audit.md) — 当前事件式配额只能约束正常应用路径，原生引擎上线后应删除事件 enforcement、保留 root 生命周期与浏览器直连架构，并新建订阅权益权威及跨仓策略、用量、错误契约。
