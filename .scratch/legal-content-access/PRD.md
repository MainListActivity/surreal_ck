Status: ready-for-agent

# 法律内容访问权、订阅生效与授权 AI 研究

本实施簇对应用户于 2026-09-24 确认的 15 张切片：surreal_ck 14 张，ma_hono 1 张。每仓从 01 连续编号；下表保留确认时序号，跨仓票以唯一 ID 引用。建票不代表实现、生产权限验证或正式商业上线已经完成。

## 交付目标

有效订阅工作区的获授权成员能够搜索、阅读和引用其内容范围，AI 只检索并使用同一调用者当前获准的语料。订阅与来源许可变化能收回新的访问，用户自建数据与合法历史成果按已确认规则保留。

## 已确认的产品决策

- Plus 通过限定可读内容集合提供有限案例能力；普通浏览、检索、打开正文和合法引用读取不扣 AI 额度。AI 生成另按工作区共享额度计量。
- 上述规则由用户在本次拆票中明确确认，优先于早期套餐矩阵中“全文受共享额度控制”的歧义表述。原设计父票保持原状，本簇记录实施依据。
- 工作区按有效产品套餐版本获得权益；旧资源 Plus/Pro/Max 名称不等于 lawyer_plus/pro/max，不自动授予内容访问。
- 内容使用稳定集合授权；合法滚动发布可持续更新，引用固定精确版本。来源许可、发布状态与工作区权益取交集，未知或失效时拒绝扩大访问。
- 到期直接进入保留模式，无宽限；用户成果保留，全文重新鉴权，追问与重跑使用当前语料。保留模式沿用零增长/非恶化资源语义，不称为只读。
- 七日 Pro 试用由有资格的计费账户管理员显式启动，同账户最多一个有效自助试用；真人成员不设付费席位上限。

## 当前实现差距与边界

- 当前内容 schema 默认进入 _system，内容维护生产装配使用 root 查询；01 必须先完成独立内容库与受限发布路径的迁移。既有内容维护票的完成标记不能替代新边界验收。
- 当前客户法律搜索明确拒绝服务，尚未注入可用的调用者内容检索；不能接回运营搜索路径来消除错误。
- 已检查的 IdP scope 换票仅接受 admin/participant，并沿用原 token 剩余期限；必须完成跨仓短期 content_reader 契约后才能交付内容会话。
- 内容数据不放客户 workspace；收藏、批注和研究成果经调用者 workspace session 保存并受资源配额约束。
- 浏览器保留工作区连接并另建内容连接。内容读取为 RECORD 身份，schema 权限执行授权，工作区管理员亦不能获得内容库 DDL/DML。RL 出现在 RECORD token 中本身不代表越权。
- root 仅用于已允许的控制面、schema 和迁移维护，不进入客户检索或日常内容发布；不新增 service JWT。受限发布与授权投影同步能力不能被客户利用为自授权入口。
- 每张票须包含有意义的正反例及所触及层的联调验收；并非等待最终票才验证权限。实现代码时按实际涉及内容加载 Mastra、SurrealQL、向量技能，并遵守 pnpm workspace 约定。

## 路线图

| 确认时序号 | ID | 独立交付 | Blocked by |
|---|---|---|---|
| 1 | SCK-LCA-01 | [将内容维护迁到独立内容库](issues/01-isolated-content-publishing.md) | 无 |
| 2 | SCK-LCA-02 | [工作区绑定产品套餐并展示内容权益](issues/02-product-entitlement-assignment.md) | 无 |
| 3 | IDP-LCR-01 | [IdP 签发独立的短期内容读取凭证](/Users/y/IdeaProjects/ma_hono/.scratch/content-reader-scope/issues/01-content-reader-token-exchange.md) | 无 |
| 4 | SCK-LCA-03 | [订阅成员打开一篇获授权的法律内容](issues/03-authorized-content-reader.md) | SCK-LCA-01、SCK-LCA-02、IDP-LCR-01 |
| 5 | SCK-LCA-04 | [检索、阅读和收藏授权法律内容](issues/04-authorized-legal-search.md) | SCK-LCA-03 |
| 6 | SCK-LCA-05 | [工作区共享 AI 额度闭环](issues/05-shared-ai-allowance.md) | SCK-LCA-02 |
| 7 | SCK-LCA-06 | [AI 使用平台内容与私有资料生成可核验回答](issues/06-authorized-ai-research.md) | SCK-LCA-04、SCK-LCA-05 |
| 8 | SCK-LCA-07 | [暂停恢复、缓存和追问重新鉴权](issues/07-reauthorize-resumed-research.md) | SCK-LCA-06 |
| 9 | SCK-LCA-08 | [订阅变更驱动内容权限生效与收回](issues/08-subscription-content-lifecycle.md) | SCK-LCA-03、SCK-LCA-05 |
| 10 | SCK-LCA-09 | [到期后保留成果，引用按当前权限展示](issues/09-historical-results-and-citations.md) | SCK-LCA-06、SCK-LCA-08 |
| 11 | SCK-LCA-10 | [显式启动七日 Pro 受控试用](issues/10-explicit-pro-trial.md) | SCK-LCA-08、SCK-LCA-09 |
| 12 | SCK-LCA-11 | [公开预览与安全的覆盖缺口提示](issues/11-safe-discovery-and-coverage.md) | SCK-LCA-01、SCK-LCA-02 |
| 13 | SCK-LCA-12 | [授权范围内的语义类案检索](issues/12-authorized-semantic-retrieval.md) | SCK-LCA-06 |
| 14 | SCK-LCA-13 | [运营解释、临时授权与交付修复](issues/13-operator-entitlement-recovery.md) | SCK-LCA-03、SCK-LCA-05、SCK-LCA-08 |
| 15 | SCK-LCA-14 | [真实身份矩阵验收与生产灰度](issues/14-production-acceptance-rollout.md) | SCK-LCA-07、SCK-LCA-09、SCK-LCA-10、SCK-LCA-11、SCK-LCA-12、SCK-LCA-13 |

## 开工规则

Status: ready-for-agent 表示规格已准备好，不表示阻塞条件已完成。只领取 Blocked by 全部完成的票；每张票完成后记录实现、真实验证、限制和交接证据，再将自身状态改为 done。

- 当前 frontier：SCK-LCA-01、SCK-LCA-02、IDP-LCR-01。
- 01 是内容路径的前置迁移；02 与跨仓凭证票不修改该路径，可独立推进。
- 基础读取链：01 + 02 + IDP-LCR-01 → 03 → 04。
- AI 研究链：02 → 05；04 + 05 → 06 → 07 / 12。
- 生命周期链：03 + 05 → 08；06 + 08 → 09；08 + 09 → 10。
- 发现页 11 只依赖 01/02，运营修复 13 依赖 03/05/08；最终 14 汇合全部必要前沿。
- 内容维护 MCP 的剩余 OAuth 联调不作为客户读取的额外人工依赖；本簇复用已存在维护能力并在 01 验证数据边界。真实内容供应仍需发布前核验。

## 发布配置与后续范围

研发和联调用明确标识的可合法使用 fixture、测试集合及费率版本。生产启用必须具备获批的实际内容集合及来源许可、Plus/Pro/Max 产品版本、AI 动作费率/额度、试用容量、IdP 配置和历史资源订阅迁移映射；这些数值不由实现人员从测试默认值推定。

本轮不拆新支付供应商接入、价格/单位经济实验、加量包商业支付、完整 Max 机器通道产品化、专业模块商品运营或通用采集器。14 的上线结论仅覆盖本簇已验收并实际启用的能力，不据此宣称完整行业订阅路线图收口。

## 规格来源

- [产品决策地图](../legal-data-product-wayfinder/PRD.md)
- [产品与权益模型](../legal-data-product-wayfinder/issues/03-entitlement-domain-model.md)
- [共享 AI 额度](../legal-data-product-wayfinder/issues/04-workspace-shared-allowance.md)
- [内容目录与授权](../legal-data-product-wayfinder/issues/05-content-catalog-licensing-lifecycle.md)
- [授权语料与引用](../legal-data-product-wayfinder/issues/06-agent-authorized-corpus-retrieval.md)
- [试用与发现](../legal-data-product-wayfinder/issues/07-trial-preview-module-discovery.md)
- [订阅及成果生命周期](../legal-data-product-wayfinder/issues/08-subscription-content-lifecycle.md)
- [既有内容维护实施簇](../legal-content-mcp/PRD.md)

- [IdP 跨仓实施簇](/Users/y/IdeaProjects/ma_hono/.scratch/content-reader-scope/PRD.md)

