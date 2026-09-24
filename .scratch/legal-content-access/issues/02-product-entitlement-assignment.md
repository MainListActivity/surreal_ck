# 02 — 工作区绑定产品套餐并展示内容权益

**What to build:** 平台运营为一个工作区分配版本化的律师行业套餐，客户和运营都能查看实际内容范围、允许动作、有效期及权益来源，并区分资源容量已生效和仍在同步的状态。

**Blocked by:** None — can start immediately（无阻塞，可立即开始）。

**Status:** done

**ID:** SCK-LCA-02
**确认时序号:** 2
**Repository:** surreal_ck
**Parent:** [本簇实施规格](../PRD.md)

## Acceptance criteria

- [x] 建立稳定 product_plan、不可变产品套餐版本及工作区产品权益快照；产品版本引用资源、内容、AI 和功能子模板，既有 quota_plan_revision 保持资源专用。
- [x] 通过受运营能力保护且带原因与审计的分配入口，为工作区绑定产品套餐版本；订阅条目逐步支持产品版本，旧资源订阅可继续运行，不因名称相同自动获得内容权限。
- [x] 内容授权使用稳定 content_collection 与动作集合；Plus 仅限配置的可读集合，普通浏览、关键词检索和打开全文均不扣 AI 额度。Pro/Max 的集合也由显式版本配置决定。
- [x] 有效基础来源按已确认规则确定，内容的有效增量来源取并集；快照记录来源、生效区间、递增修订、摘要和解析版本，重试不会产生重复交付或改写历史。
- [x] 客户权益页及运营工作区页显示内容范围、来源与到期时间；授权投影未核验时显示待交付，AI 无可用账本时不得显示可消费额度，资源继续显示真实 applied 状态。
- [x] 模板发布不追溯修改旧订阅；同一产品来源到期后解析为无有效内容授权。新增/迁移流程使用明确映射，不把资源 Plus 自动映射为 lawyer_plus。
- [x] 用有限 fixture 模板验收分配、并发解析、到期、无来源、旧订阅兼容和跨计费账户拒绝；正式集合、额度和价格不在测试默认值中暗中确定。

## 范围与交接

本票交付产品权威与可解释展示。内容数据库读取由 03 交付；AI 消费账本由 05 交付。

遵守本簇已确认的产品规则、授权边界与发布门槛。完成时在 Comments 记录实现范围、验证命令与结果、未解决限制和下游交接；只更新本票完成状态，不自动关闭或修改产品设计父票。

## Comments

- 2026-09-24：用户确认拆分后发布；当前为实施规格，尚未执行实现与验收。
- 2026-09-24：在 `_system` 增加产品套餐、内容/AI/功能子模板、内容增量授权、不可变权益快照和审计。分配入口要求 `subscription.manage`、原因和幂等键；客户读取走工作区成员身份，运营读取走 `quota.read`。资源配额仍只看 `quota_plan_revision` 与已应用权益，名称 `plus` 不会变成 `lawyer_plus`。迁移不写入正式集合、额度或价格。内容读取仍由 03 交付，因此有内容授权时投影显示待交付；AI 消费账本由 05 交付，页面不显示可消费额度。
  验证：`surreal validate shared/sql/system/021-product-entitlement.surql`；server 服务测试与 system schema 测试；`RUN_LOCAL_SURREALDB_PRODUCT_ENTITLEMENT_TESTS=1 pnpm exec bun test ./src/product-entitlement/store.integration.test.ts --preload ./test/setup-env.ts`（本机 SurrealDB，1 pass）。server `build:types` 与 web `svelte-check` 通过。登录后的客户设置页和运营页未在浏览器里点选。

