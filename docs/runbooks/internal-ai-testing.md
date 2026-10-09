# 内部首次价值测试：逐次模型用量与现金门禁

适用目标 `2e2a6e41c1193595`。功能上线不表示活动启用，也不表示取得供应商余额或业务成本基线。默认没有活动/身份配置；已有活动 `enabled` 默认 false。不得把 `AI_API_KEY` 存在、AI额度桶、USD1经理上限当作余额证据。本模块不改变产品 `ai_reservation` 的AI单位语义。

## Interface 与身份

`InternalAiGate.bind(subject, database, runId, key?)` 使用服务端已认证身份；客户端 body 中的 activity/budget/disable 等字段没有入口。身份授权与活动配置在 `_system.internal_ai_binding`，仅 root 控制面维护。业务 SurrealDB 查询仍使用原调用者会话；本模块 root 只操作匿名内部预算控制面。

**撤销语义**：撤销是持久状态，不是删除。控制面用 `UPDATE internal_ai_binding SET revoked = true`（store.revoke）撤销身份；被撤销身份的旧 run、新 run、换 key 一律 `internal-ai-binding-revoked` 拒绝，重启后仍拒绝，不降级为非计量客户路径。即使 binding 行被直接删除，任何曾计量过的身份仍凭 `internal_ai_run` 的身份历史核验拒绝（该表只增不删）；仅删除 binding 且从未产生过任何计量 run 的身份不受账本保护，因此禁止用 DELETE 作为撤销手段。从未参与内部活动的客户身份维持原行为（非计量直传）。

`inRun` 把绑定放入 AsyncLocalStorage，后台工作流、分类、工具往返、研究回答与暂停续跑共用它。`internal_ai_run` 固定 run/key/logical 关联；续跑必须找到既有记录，不能用新 key 改归属。所有关联用目标域分隔的SHA256，不记录 subject/database 原文。客户更换 run/key 不增加预算；即使不同内部活动，`internal_ai_target:2e2a6e41c1193595` 同一事务汇总现金和次数。内部身份绑定须由经过评审的服务器配置登记，不能由客户创建或切换。

固定模型证书只覆盖直连、固定版本的文本/function调用：OpenAI `gpt-4o-mini-2024-07-18` 和 TypeSafe `jev-1.13.0`。这不是要求或允许切换生产模型；生产现有模型若不符合证书，内部活动拒绝发送。OpenAI-compatible 协议、其它模型、浮动 alias、非USD、无法认证的endpoint或价格一律不可放行。模型路由若缺显式 baseUrl，也拒绝内部调用，避免把推断的host当作实际传输地址。

## 官方上界与价格

核实日期2026-10-09，来源：

- [OpenAI模型官方资料](https://developers.openai.com/api/docs/models/gpt-4o-mini)：128000上下文、16384输出上限；输入USD0.15、缓存输入USD0.075、输出USD0.60 / 百万token。
- [TypeSafe官方模型资料](https://docs.typesafe.ai/models)：固定Jev1.13；全部state与问题合计上下文上限64000；输入USD0.042 / 百万token，输出不收费。

nanoUSD=USD×10^9，整数费率分别是150/75/600或42/42/0 nanoUSD/token。最坏预留按**供应商整个上下文窗口**和最大输出计算，含system、history、工具定义和所有工具回传；无需猜分词或把字符裁剪当tokenizer。OpenAI预留29030400 nanoUSD，Jev2688000 nanoUSD。输入超过供应商context ceiling不可接受；即使供应商拒绝或报错，也不释放这笔保守预留。输出显式收紧到证书上限。此证书限非推理文本模型，不支持联网付费工具或多模态；provider-defined工具、嵌套媒体tool结果和未知provider options发送前拒绝。证书不覆盖第三方代理附加费用。

输入包含cache，费用按 `(input-cache)*inputRate + cache*cacheRate + output*outputRate`，不把cache再重复加入input。reasoning原字段保留，当前证书不接受非零reasoning。缓存独立费率模型缺cache字段、缺input/output、实际model不匹配或usage超过上界，不能核定费用，保留预留；不会记零，也不会把估算标provider实测。不能从Mastra聚合usage和逐step usage双算费用。

## 发送与恢复

`InternalBudgetModel` 在V2 `doGenerate` / `doStream` seam计每次底层模型step；原SDK文本/工具结果照常返回。分类标 `llm-classify`，Jev标 `jev-classify`，研究回答标 `research-answer`，提案step标对应agent。finish流片段归一化input/output/cache/reasoning，response-metadata留实际model及request ID；不落prompt、response或工具载荷。Jev在单HTTP尝试前经过同一门禁，并保存可取得的x-request-id。

发送前事务预留活动和全目标金额/次数；单次<=USD0.10，活动只能收紧USD1/30次上限，全目标总额USD1/30次，余额还要覆盖全目标支出与预留。承诺持久化失败不发送。先持久标sent后才执行传输；保留标记后任何断连、取消、失败或无usage均不自动释放。数据库进程重启后仍保留reserved/sent/uncertain与累计次数；模型幂等重放不能重新发送同ticket。

内部调用关闭SDK自动重试，HTTP Jev client没有重试；自动重试数为0（满足单逻辑任务最多1次上限），ledger retryIndex=0。用户明确新提交/续跑不是隐藏自动重试，仍消耗同目标预算。Jev低置信成功后的LLM fallback各自预留。数据库事务冲突重试只重试账本操作，从不重试provider；提交结果未知保留预算、不发送。事务错误可能报告通用reservation-denied，运营从余额/已用/预留/次数查看原因。

Embedding在内部活动中发送前禁止（包括资源检索调用生成器）；没有embedding费率及上界证书。关键词回退可继续；不存在未计量embedding调用。当前真实模型路径仅这些通道，新增计费通道必须先接门禁或拒绝。

## 受审配置与余额未就绪

本PR只提供受控只读运营接口，没有客户或通用HTTP启用/充值/资料上传接口。配置由独立工程/运营评审的服务器控制面维护，必须保留审批证据与配置版本，绑定明确批准的内部账号+workspace；不得临时读取凭证或让QA绕 `_system` 写配置。需要运营代理登记配置时，由经理安排专用受审配置交付，不能用 `ops_query` 绕身份边界。没有资料就保持disabled与paidCallsAllowed=0。

活动字段须同时具备固定goal、enabled、service_approved、approval_revision、匹配price_revisions、未到期evidence_expires_at、USD现有余额、balance_sampled_at、余额证据SHA256、`balance_source=reviewed-document:<同SHA256>`、auto_topup_disabled=true。这些是服务器审核资料的绑定，不是客户端自报余额。真实批准服务、证据内容真实性/账户绑定、官方当时价格、余额采样和自动充值停用须由运营独立核查后进入受审配置；代码不会自动从key推导或伪造余额。本轮没有取得这些资料，也没有配置生产活动。

只读接口使用既有运营audience与实时 `subscription.manage` capability：

- `GET /api/ops/internal-ai/runtime`：配置provider/model、实际配置endpoint的host（不含userinfo/query/key）、当前安装Mastra版本、支持的price证书、余额unavailable原因。实际modelVersion只由已完成尝试的返回值证明，配置值不是实测版本。
- `GET /api/ops/internal-ai/activities/:id?after=0`：固定50行分页，匿名run/key/logical关联、attempt序号、usage来源和字段、实际模型/requestId、货币/价格版本/成本、活动及目标支出/预留/剩余、审核余额证据引用与时点。无配置返回404，未知usage/cost/model/requestId显式null。不会返回客户业务快照、凭证或账单身份。没有余额API时runtime明确unavailable；活动审核资料与供应商实时余额不是同一事实。

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
