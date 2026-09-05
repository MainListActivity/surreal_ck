Status: done
Label: done
Assignee: product

# 确定订阅优先的一级商品与计费单位

Parent: [`律师行业订阅与平台法律数据产品决策地图`](../PRD.md)

## Question

律师用户首次购买时应该选择案例集、专业模块还是统一行业套餐？套餐按用户、席位还是工作区收费？

## Decision

- 首期唯一一级商品为 Lawyer Plus、Lawyer Pro、Lawyer Max。
- 用户购买的是持续更新的法律研究能力，不购买底层案例集。
- 案例集只作为后台来源、版本、覆盖和授权单元。
- 核心案例能力进入主套餐；高成本、深加工或单独授权的内容未来才作为专业实务模块增购，并由系统在理解用户问题后推荐。
- 按工作区计费，不限制工作区成员席位；工作区成员共享套餐授予的内容访问、自建容量和 AI 额度。
- Plus 包含有限案例检索或有限带引用研究；Pro 提供完整核心案例研究；Max 增加组织治理、私有知识与集成能力。
- 高成本 AI 使用采用套餐内共享额度；额度耗尽后默认停止，只有计费账户管理员可以主动加购或开启受预算约束的自动充值。
- table、field、record 配额是详细容量指标，不是价格页的主要价值标题，且不按超额行数自动收费。
- 对外使用“持续更新”并披露更新时间，不承诺无法验证的绝对实时更新。

## Evidence

- [`法律数据库与法律 AI 产品的套餐包装研究`](../research/legal-product-pricing-models.md)
- [`中国法律产品的套餐与数据包装研究`](../research/china-legal-product-packaging.md)
- [`数据产品与垂直 SaaS 定价研究`](../research/vertical-data-saas-pricing-models.md)

## Dependencies

无。

## Comments

该决定只锁定商品和计费单位，不代表无限成员可以无限使用。公平使用、API、批量导出、机器人访问和共享额度规则由后续子票定义。
