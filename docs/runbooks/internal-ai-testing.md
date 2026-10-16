# 内部首次价值测试：逐次模型用量与现金门禁

适用目标 `2e2a6e41c1193595`。功能上线不表示活动启用，也不表示取得供应商余额或业务成本基线。默认没有活动/身份配置；已有活动 `enabled` 默认 false。不得把 `AI_API_KEY` 存在、AI额度桶、USD1经理上限当作余额证据。本模块不改变产品 `ai_reservation` 的AI单位语义。

## Interface 与身份

`InternalAiGate.bind(subject, database, runId, key?)` 使用服务端已认证身份；客户端 body 中的 activity/budget/disable 等字段没有入口。身份授权与活动配置在 `_system.internal_ai_binding`，仅 root 控制面维护。业务 SurrealDB 查询仍使用原调用者会话；本模块 root 只操作匿名内部预算控制面。

**撤销语义**：撤销是持久状态，不是删除。控制面用 `UPDATE internal_ai_binding SET revoked = true`（store.revoke）撤销身份；被撤销身份的旧 run、新 run、换 key 一律 `internal-ai-binding-revoked` 拒绝，重启后仍拒绝，不降级为非计量客户路径。即使 binding 行被直接删除，任何曾计量过的身份仍凭 `internal_ai_run` 的身份历史核验拒绝（该表只增不删）；仅删除 binding 且从未产生过任何计量 run 的身份不受账本保护，因此禁止用 DELETE 作为撤销手段。从未参与内部活动的客户身份维持原行为（非计量直传）。

`inRun` 把绑定放入 AsyncLocalStorage，后台工作流、分类、工具往返、研究回答与暂停续跑共用它。`internal_ai_run` 固定 run/key/logical 关联；续跑必须找到既有记录，不能用新 key 改归属。所有关联用目标域分隔的SHA256，不记录 subject/database 原文。客户更换 run/key 不增加预算；即使不同内部活动，`internal_ai_target:2e2a6e41c1193595` 同一事务汇总现金和次数。内部身份绑定须由经过评审的服务器配置登记，不能由客户创建或切换。

固定模型证书只覆盖直连、固定版本的文本/function调用：OpenAI `gpt-4o-mini-2024-07-18`、TypeSafe `jev-1.13.0` 与 SenseNova `sensenova-6.8-flash-lite`（Token Plan 零费率）。这不是要求或允许切换生产模型；生产现有模型若不符合证书，内部活动拒绝发送。OpenAI-compatible 协议、其它模型、浮动 alias、非USD、无法认证的endpoint或价格一律不可放行。模型路由若缺显式 baseUrl，也拒绝内部调用，避免把推断的host当作实际传输地址。

## 官方上界与价格

核实日期2026-10-09（SenseNova 2026-10-10），来源：

- [OpenAI模型官方资料](https://developers.openai.com/api/docs/models/gpt-4o-mini)：128000上下文、16384输出上限；输入USD0.15、缓存输入USD0.075、输出USD0.60 / 百万token。
- [TypeSafe官方模型资料](https://docs.typesafe.ai/models)：固定Jev1.13；全部state与问题合计上下文上限64000；输入USD0.042 / 百万token，输出不收费。
- [SenseNova 官方文档 List Models](https://platform.sensenova.cn/docs)（`GET https://token.sensenova.cn/v1/models`）：`sensenova-6.8-flash-lite` context_length 262144、max_output_length 65536、pricing 全 0；[SenseNova Token Plan 官方页](https://www.sensenova.cn/token-plan)明示公测期完全免费（60,000积分/5小时滚动窗口，付费档未上线）。该服务是配额制，不存在 USD 现金价目与 USD 余额。

nanoUSD=USD×10^9，整数费率分别是150/75/600或42/42/0 nanoUSD/token，SenseNova Token Plan 证书费率全 0（最坏预留 0）。最坏预留按**供应商整个上下文窗口**和最大输出计算，含system、history、工具定义和所有工具回传；无需猜分词或把字符裁剪当tokenizer。OpenAI预留29030400 nanoUSD，Jev2688000 nanoUSD，SenseNova预留 0 nanoUSD（成本按官方零费率结算为 0，额度占用仍以官方配额页面为准、不折算美元）。输入超过供应商context ceiling不可接受；即使供应商拒绝或报错，也不释放这笔保守预留。输出显式收紧到证书上限。此证书限非推理文本模型，不支持联网付费工具或多模态；provider-defined工具、嵌套媒体tool结果和未知provider options发送前拒绝。证书不覆盖第三方代理附加费用。

输入包含cache，费用按 `(input-cache)*inputRate + cache*cacheRate + output*outputRate`，不把cache再重复加入input。reasoning原字段保留，当前证书不接受非零reasoning。缓存独立费率模型缺cache字段、缺input/output、实际model不匹配或usage超过上界，不能核定费用，保留预留；不会记零，也不会把估算标provider实测。不能从Mastra聚合usage和逐step usage双算费用。

## 发送与恢复

`InternalBudgetModel` 在V2 `doGenerate` / `doStream` seam计每次底层模型step；原SDK文本/工具结果照常返回。分类标 `llm-classify`，Jev标 `jev-classify`，研究回答标 `research-answer`，提案step标对应agent。finish流片段归一化input/output/cache/reasoning，response-metadata留实际model及request ID；不落prompt、response或工具载荷。Jev在单HTTP尝试前经过同一门禁，并保存可取得的x-request-id。

发送前事务预留活动和全目标金额/次数；单次<=USD0.10，活动只能收紧USD1/30次上限，全目标总额USD1/30次，余额还要覆盖全目标支出与预留。承诺持久化失败不发送。先持久标sent后才执行传输；保留标记后任何断连、取消、失败或无usage均不自动释放。数据库进程重启后仍保留reserved/sent/uncertain与累计次数；模型幂等重放不能重新发送同ticket。

内部调用关闭SDK自动重试，HTTP Jev client没有重试；自动重试数为0（满足单逻辑任务最多1次上限），ledger retryIndex=0。用户明确新提交/续跑不是隐藏自动重试，仍消耗同目标预算。Jev低置信成功后的LLM fallback各自预留。数据库事务冲突重试只重试账本操作，从不重试provider；提交结果未知保留预算、不发送。事务错误可能报告通用reservation-denied，运营从余额/已用/预留/次数查看原因。

Embedding在内部活动中发送前禁止（包括资源检索调用生成器）；没有embedding费率及上界证书。关键词回退可继续；不存在未计量embedding调用。当前真实模型路径仅这些通道，新增计费通道必须先接门禁或拒绝。

## 受审配置与余额未就绪

内部控制面通过专用运营路由消费公司可信证明，客户没有配置入口。配置由独立工程/运营评审的服务器控制面维护，必须保留审批证据与配置版本，绑定明确批准的内部账号+workspace；不得临时读取凭证或让QA绕 `_system` 写配置。需要运营代理登记配置时，由经理安排专用受审配置交付，不能用 `ops_query` 绕身份边界。没有资料就保持disabled与paidCallsAllowed=0。

活动字段须同时具备固定goal、enabled、service_approved、approval_revision、匹配price_revisions、未到期evidence_expires_at、balance_sampled_at、余额/配额证据SHA256、auto_topup_disabled=true；余额型证据还须 USD 现有余额与 `balance_source=reviewed-document:<同SHA256>`，配额型（reviewed-token-plan）证据还须 `balance_source=token-plan:<同SHA256>`、planName/planSourceUrl/account_plan_type/quotaUnit/quotaAmount/quotaWindowSeconds 齐全、account_plan_type 等于 `TOKEN_PLAN_PLAN_TYPE_FREE`、quotaRemaining 存在时大于 0，且 USD 余额字段必须为 NONE（配额绝不折算美元）。这些是服务器审核资料的绑定，不是客户端自报余额。真实批准服务、证据内容真实性/账户绑定、官方当时价格、余额或配额采样和自动充值停用须由运营独立核查后进入受审配置；代码不会自动从key推导或伪造余额。本轮没有取得这些资料，也没有配置生产活动。

只读接口使用既有运营audience与实时 `subscription.manage` capability：

- `GET /api/ops/internal-ai/runtime`：配置provider/model、实际配置endpoint的host（不含userinfo/query/key）、当前安装Mastra版本、支持的price证书、余额unavailable原因。实际modelVersion只由已完成尝试的返回值证明，配置值不是实测版本。
- `GET /api/ops/internal-ai/activities/:id?after=0`：固定50行分页，匿名run/key/logical关联、attempt序号、usage来源和字段、实际模型/requestId、货币/价格版本/成本、活动及目标支出/预留/剩余、审核余额证据引用与时点。无配置返回404，未知usage/cost/model/requestId显式null。不会返回客户业务快照、凭证或账单身份。没有余额API时runtime明确unavailable；活动审核资料与供应商实时余额不是同一事实。
- `GET /api/ops/internal-ai/activities/:id?after=0&assessment=1`（FV06）：在上述读面追加版本化只读成本评价，默认参数下响应完全不变。逐 attempt 增加 `costAssessment`（version、status=`measured_derived|unverifiable|uncertain`、costNanoUsd、reasons、certificate、priceRevision、usage快照、evidence窗口引用、sourceHash）；顶层 `costAssessment` 为 run/路径聚合（按 runHash 分组、唯一 attempt ID 去重、knownSubtotalNanoUsd/unknownCallCount/unknownRunCount、总成本仅全覆盖时核定，任一缺口→unassessed）。`successfulTasks=N` 提供成功闭环分母；N=0 或总成本未核定时 perSuccessfulTask=null（reason=`undefined_zero_success`/`cost-unassessed`）。评价规则见 `server/src/internal-ai/assessment.ts`：仅显式评价证书覆盖的 `priceRevision×host/path×model×reviewed-token-plan×FREE×调用时刻证据窗口` 得 `measured_derived`；reasoning 计为 output 子集不二次计费，maxOutput 无条件检查；缺 usage/越界/非法值→uncertain，范围/证据/身份不符→unverifiable。该投影不改动账本 state/cost/usage，也绝不代表供应商实扣或积分扣减。

运行origin/web SHA复用原发布标识链，本模块不增加或改写其路由。

## QA与回退

本地用公司fork运行：

```sh
rtk proxy env RUN_INTERNAL_AI_FORK_TESTS=1 pnpm --filter @surreal-ck/server exec bun test src/internal-ai src/routes/ops-internal-ai.test.ts --preload ./test/setup-env.ts
rtk proxy pnpm typecheck
rtk proxy pnpm lint
```

RocksDB tests覆盖多连接及两个独立客户端进程并发、真实服务器重启、幂等、跨活动目标上限、模型step发送前预留、finish usage、缺资料及embedding零外发。transport/usage/余额皆合成fixture，只作开发验证，不是供应商实测/业务基线。

生产独立QA先验证未配置或disabled、缺余额/未知价格/未知币种、客户身份/撤权拒绝、匿名分页。已耗尽的受审内部低限额活动只能用确定性拒绝探针，核对provider外发计数为0，不能用付费调用耗尽USD1。仅在现有服务资料、价格、余额、自动充值状态和上界均核定后，受控QA才可做最小真实调用，并计入目标总额。记录部署SHA、Mastra实际版本、全部分类/fallback/提案step、失败及续跑usage；测试不能当首次业务基线。

迁移034仅新增内部控制面结构，无回填或删除已有生产数据；无需新增环境变量或主机准备。受审活动配置是另一个启用关口。回滚前必须通过既有运营rollout接口把所有登记内部workspace的 `legal_research_ai` 禁用，确认旧版本也拒绝新run/续跑，再停用内部活动并回退origin SHA。旧版本没有现金门禁，不能仅回退代码或只依赖新活动disabled字段；禁用灰度不得在回滚后恢复。保留账本及未结预留，禁止重置以重跑测试。

统计分母：总测试成本包含全部有效底层尝试（失败/重试仍计），除以全部有效尝试数；同一总成本除以成功闭环数。任何uncertain成本使实际统计未核定，不能用预留额冒充实际成本；零成功闭环时后一项null。AI单位账本单独报告。


## 公司证明登记（54697f41）

只用已有 `subscription.manage` 实时运营能力：

- `POST /api/ops/internal-ai/company-proof` 接受公司代理实际 `{proof}` 信封（也可带 `reason`），固定 EdDSA/kid/JWK/issuer/audience/用途验签。真实 proof.type 是 `approved-service`，脱敏文档 type 是 `reviewed-service`（USD 余额）或 `reviewed-token-plan`（官方配额计划）。登记永远 disabled；双身份仅来自公司正常 OIDC 权威投影，不接受 caller subject。
- `POST /api/ops/internal-ai/activities/:id/evidence`：`{revision, document, reason}`；文档 UTF-8 SHA256 必须与已签 documentHash 相同，严格受审证据 schema（USD-only 余额型 `development-disabled`/`reviewed-service`，或配额型 `reviewed-token-plan`）、服务账户/endpoint/模型/priceRevision 对齐。配额型字段（schemaVersion 2）：planName、planSourceUrl（官方出处 https）、accountPlanType（仅接受供应商读回常量 `TOKEN_PLAN_PLAN_TYPE_FREE`）、quotaUnit(points|requests)、quotaAmount>0、quotaWindowSeconds>0、quotaRemaining 可空（存在时须>0才无缺口）。v1 的 noPaymentInstrument/autoTopupDisabled 账户级断言已移除：前者在供应商侧无可核定来源，后者由我方计量配置断言；v1 文档全部过期且无在飞消费者，双端同步切换。正文不入库。每次新增审计 revision 并禁用活动。
- `POST /api/ops/internal-ai/activities/:id/enable`：`{revision, reason}`；仅最新 disabled revision、真实独立批准、过去采样/最多24小时资料窗口、停自动充值、服务批准、精确当前 provider/endpoint/model 和受审价目版本均齐全才可启用；余额型要求正 USD 余额，配额型要求有效配额字段、account_plan_type=FREE 且无 USD 余额。未知币种/FX 仍拒绝；TokenPlan 只能以 reviewed-token-plan 证据类型进入，配额绝不折算美元写余额。当前单账户契约无法证明Jev自己的余额/证书，Jev启用时也拒绝启用。
- `POST /api/ops/internal-ai/activities/:id/disable`：`{reason}`；`POST /api/ops/internal-ai/identities/revoke`：`{activity, alias, reason}`；撤销持久标记并禁用活动，重复撤销幂等，保留身份、run、ledger和uncertain预留。
- `GET /api/ops/internal-ai/activities/:id/revisions`：脱敏历史预览、操作者与原因、公司批准引用、真实 manifest hash、配置摘要及事务内前后快照。revision字段READONLY，服务无覆盖/删除历史路径。root维护权限不作为客户入口。
- `GET /api/ops/internal-ai/supplier-probe?host=token.sensenova.cn`：固定注册表明确 unsupported，无注册官方只读balance/plan/usage能力则不发送任何探测请求，列需补证据；Token Plan 配额与零费率只能经 reviewed-token-plan 受审文档登记。不是断言供应商不存在官方API；后续须独立核定固定能力后代码评审加入。不得套OpenAI证书、积分、CNY或推断价目。

公司状态由服务端 `INTERNAL_AI_COMPANY_STATUS_URL` 指向公司已核定的固定 HTTPS `/internal-ai/status`（无userinfo/port/query/hash、不跟随重定向）。该非secret部署值不得从caller或manifest读取。登记、补证、enable 在受控链路上重新请求随机nonce的签名状态；核对jti/批准版本、用途、pin、checkedAt/iat/exp（最长60秒）及proof自身最长300秒。地址缺失、不可达、撤回、租约/文件/身份变化、到期或key轮换均拒绝，无模型外发。status bearer只在进程内存，不入库/日志；受控链路重启后无能力也拒绝，必须重新投递仍有效证明；没有timer。

用户门禁与操作者投递会话解耦（def-capability-300s-fragility）：投递 proof 自身 ≤300s 且公司状态有效性绑定投递租约（proof 过期后公司状态服务必回 valid=false），因此底层 attempt 不再逐次请求签名状态，也不检查 `proof_expires_at`；用户流量只锚定受审账本状态——最新 revision enabled、未到期 evidence_expires_at、未撤销身份绑定、预算上限，全部在 reserve 同一事务内强制复核，与进程重启无关。绑定撤销、活动 disable、证据过期在同一事务内立即拒绝；登记/补证/enable 的验签、实时状态与审计链路不变，已吊销证明无法借用户流量复活，也不能重新启用。对已启用活动的远程即时断流走产品受控面（POST disable / identities/revoke，operator 鉴权），最坏漏杀窗口被证据窗口（≤24h）与预算上界（总额 USD1 / 30 次 / 单次 USD0.10）封顶。

登记/补证/enable/disable/revoke与审计快照单事务提交；活动版本CAS与身份唯一索引拒绝并发冲突，调用方先读回再重试。同jti同摘要幂等，不同配置或身份改绑冲突。同配置的新证明可以刷新，但绝不重置spent/reserved/attempts或共享target；旧证据revision不能绕过disable或revoke重新启用。

035迁移仅新增表/字段/索引，不回填或改写生产数据。036 迁移为 internal_ai_activity/internal_ai_revision 追加配额型证据字段（evidence_kind、plan_*、quota_*、no_payment_instrument、balance_source），并把 revision.currency 放宽为可空（USD-only 旧行值不变）；同样只新增、不回填或删除既有数据。038 迁移追加 `account_plan_type`（两表，`option<string>`，ASSERT 仅 `TOKEN_PLAN_PLAN_TYPE_FREE`）；no_payment_instrument 列保留兼容历史行但不再写入，v1 启用的 token-plan 活动因缺 account_plan_type 会被 reserve 拒绝，属预期切换。公开pin由 `ops_internal_ai_trust` 核对，轮换须代码发布。当前生产公网状态发布面未配置（本轮ops_info读回），本轮也未取得真实SenseNova财务/价目资料：`unsupported`、`dataReady=false`、`paidCallsAllowed=0`。上线链须先核定公司公开状态地址，再按runbook通过CI设 `ORIGIN_ENV_INTERNAL_AI_COMPANY_STATUS_URL`；缺地址可安全部署身份只读端点，登记/启用继续拒绝。真实prove/deliver/revoke/expiry/status公网实测归部署后的独立QA，不以合成fixture代替。

所有本地证明、余额及OpenAI正向启用均为隔离公司fork合成fixture，未替换生产SenseNova，未调用任何真实模型。回退仍按上文先关闭已有灰度并确认新旧run/续跑拒绝，保留所有历史和预留。


## 同活动证据续期（lca-v2-deploy-qa01，fv05 受审宿主）

本次 fv05 受审宿主固定为活动 `lca-v2-deploy-qa01`：两个现有身份绑定（LCA04_REMOVABLE/LCA04_MEMBER）保留在该活动，不新建 workspace、不改 `MEASUREMENT_DATABASE`、不撤销改绑、不换别名绕过。旧 `first_value_internal_v1` 在 `ws_45892981716d` 的 30 条账本不迁移、不重置。身份已绑定该活动是续期的前提——“绑定别的活动就换 activityId”是误导，已删除：同活动新文档走下面的续期链，而不是另起活动。

续期链（与首次受审同一条公司 prepare→独立 accept marker→fresh approved-service prove/deliver→产品登记/evidence/显式 enable 链）：

1. GM 另建 fresh 批准任务（依赖本代码部署 done 后才采样），取得新独立批准引用并签发 approved-service proof。新 manifest 除 documentHash 外与原受审配置逐字段相同（activityId/goal/project/env/workspace/service 全对象/全部 budget 字段/alias 与角色），新 configurationDigest 按公司规则从新 manifest 派生；新旧 identitiesDigest 一致（真实 subject/space/database/billingAccount/角色未变且未撤销）。旧 proof/旧批准不能替新文档授权；旧过期票据不能复活。budget.autoTopupDisabled 始终 true。
2. 产品登记（`POST /api/ops/internal-ai/company-proof`）：同活动新摘要不再整体拒绝，核验通过后追加新 revision（disabled）并冻结原路径（活动 disabled），前后快照进审计；新 proofJti/新 approvalTask 落库，旧 READONLY revision 与旧批准审计不动。登记时没有正文也可先登记，严格核验延至 evidence 阶段。
3. 短 proof 窗口：proof 自身 ≤300 秒且公司状态当前（lease/签名/nonce 实时核对），过期即整链拒绝；证据窗口 ≤24 小时（expiresAt−sampledAt），过期/未来/采样倒退（早于原已核定采样）分别在 enable/evidence 阶段拒绝；旧文档字节对不上新 revision 的 documentHash 即拒绝，旧 fresh proof 的未用 nonce 不能把链路滚回旧文档。
4. 提交新文档（`POST .../evidence`）后必须显式 enable（`POST .../enable`）：新 revision disabled 直到原字节 hash 匹配且全部门禁通过；重复 enable 同一 revision、已有 measurementCycle 上的新证据 enable（evidence_hash 失配）照旧拒绝。
5. 旧活动上限与目标单例 cycle 不被续期刷新：renewal 不清零 activity/target/cycle 的 attempts/reserved/spent/sequence，不动旧 attempt 与 identity_hash，不重置/延长/重建已有 measurementCycle；cycle 已存在时其固定 id/owner/attempt_limit/attempts/approval/evidence_hash/expiry 保持原样。本次实际 cycle=null，后续只可创建已批准的一次 ≤30 周期（见下节复测周期）。

## 一次性复测周期（按交付任务轮换，当前 108dfacb）

037 迁移只新增 `internal_ai_measurement_cycle` 与 attempt 的可空 `measurement_cycle`；不回填、不覆盖旧 30 条账本，也不改旧活动/目标计数约束。周期固定 ID 取交付它的任务 ID：首个周期 `f3974e8f-4c4d-41e2-af63-e4de68ea5f91` 已于 2026-10-15T20:37:59Z 用满（30/30）并随证据到期停止；第二周期 `09a8ab21-5850-4329-ab86-c55a91743c02` 随绑定证据 2026-10-16T01:37:59Z 到期停止；第三周期 `53ca2126-cf86-4722-8322-a0ad49981bf6` 已于 2026-10-16T06:37:59Z 用满（30/30）并随证据到期停止；第四周期 `886db7cb-7f44-4e63-a074-2ad56f1fe1a8` 已于 2026-10-16T11:37:59Z 用满（30/30）并随证据到期停止；本交付（任务 `108dfacb-260a-4ac0-a9af-7d1abc70b189`）把 `MEASUREMENT_CYCLE` 轮换为本任务 ID，enable 时在同一事务新建该行，旧行作为审计历史原样保留、不复活不重置。新周期追加最多 30 次（GM 批准上界 40 的收紧，且取该活动受审 attempt_limit，不放宽更小的预算），仅限 `ws_ddad14a98469`、`sensenova-token-plan-2026-10-10` 零费率证书。一次底层 model step 消耗一次，并非一个业务 run 固定只耗一次；uncertain 仍占次数。零费率不能推导配额余额。

部署腿按以下顺序准备并留证，本实现腿不产生供应商财务/配额事实：

1. 通过 `ops_info`、`ops_login` 与成员工具确认/复用 `sck-fv05-retest-01`，核对数据库为 `ws_ddad14a98469`。确认 LCA04_REMOVABLE 是该 workspace 的 admin/计费 owner，LCA04_MEMBER 是 participant/计费 member。不得把这些角色靠自填 proof 改成事实。本 workspace 的受审活动若已有身份绑定在别的活动，不得覆盖旧绑定或撤销记录——同活动续期走上一节续期链（lca-v2-deploy-qa01 宿主），不在此另起活动规避。
2. 运维协调取得当前真实服务账户的 reviewed-token-plan 采样文档，记录采样来源、账户脱敏引用、采样时刻、计划官方出处、供应商读回的 accountPlanType（须为 `TOKEN_PLAN_PLAN_TYPE_FREE`，非 FREE 不收）、额度与剩余额度（无法核定时 nullable，不能伪造）。使用 shared 的 reviewedEvidenceSchema，UTF-8 SHA256 必须与公司签名 documentHash 一致；expiresAt > sampledAt 且窗口 <=24h。此供应商是零费率配额计划，不以 USD 余额文档替代。
3. 使用公司代理 `ops_internal_ai_prepare/prove/deliver` 的既有 manifest/文档契约，取得新独立批准引用并签发 approved-service proof。manifest 的 workspaceSlug 指向复测 workspace，priceRevision 使用上述证书，budget.maxAttempts <=30、autoTopupDisabled=true；身份来自正常 OIDC 权威投影。证明、状态 bearer、原始账号资料不写证据。登记先 disabled，之后通过 evidence 路由提交同一受审文档。
4. 若 deliver 已自动启用活动，先用既有 disable 路由产生 disabled revision（不做模型调用）。读回当前 disabled revision，在 proof 与公司状态仍有效时，用运营会话调用 `POST /api/ops/internal-ai/activities/<id>/enable`，body 为 `{revision, reason, measurementCycle:true}`。活动启用、周期建立、revision 审计同事务提交。所有既有服务批准/实时状态/证据/runtime/身份门禁继续生效。未取得真实材料必须保持 disabled。
5. 读回 GET activities/<id>：measurementCycle 中有 attempts、attempt_limit、approval_revision、enabled_revision（创建周期的不可变审计版本）、evidence_hash、expires_at；target.attempts 与 attemptsUsed 保留旧周期语义，cumulativeAttempts/cumulativeAttemptsUsed 包含新周期。账本条目 measurementCycle 标记新周期，sequence 延续该活动旧记录；分页 nextAfter 规则不变。
6. QA 先快照旧 30 条记录，再以绑定主体执行一次真实调用，确认新 attempt 带实际 usage，按既有 settled/uncertain 语义记成本（缺 usage 不能当作已核定零成本），并逐条对比旧记录。未绑定 run 不能取得本周期预留，撤销身份、过期证据、disabled 活动、非本证书/非零预留均拒绝。普通从未参与内部活动的客户仍遵循既有非计量路径，不把它误当内部受测身份。

周期由全目标唯一固定记录控制，换 run/key/activity 不能加预算；重复 enable 不重置次数、不续期、不改变 documentHash/approvalRevision。首次周期绑定的文档到期后该周期停止，新的批准或证据不能复活/重新分配该周期，需要另行受审交付。并发数据库冲突可能由 SDK 只返回 NotExecuted；保留既有 fail-closed 行为，不把未知提交当作可安全重发。自动重试 provider 仍为 0。

回退：通过既有 disable 路由禁用复测活动并读回；保留新旧 attempt、周期计数和 revision。代码回滚后旧目标 30 次上限会拒绝继续调用，不删除 037 新结构。无需新增环境变量或主机停写迁移。
