# 显式七日 Pro 受控试用

普通 `/api/workspaces` 创建不再自动生成十四日 trial；返回 `commercial-source-required`。用户经 `/api/pro-trial/accounts`、`preview` 核对范围并主动确认后调用 `start`。仅 active 计费账户 owner/admin 且具显式资格可启动；workspace admin 身份不构成资格。

## 发布准备

`shared/sql/system/026-explicit-pro-trial.surql` 仅新增控制面表、字段、唯一索引和不可变事件，无存量数据改写、无默认商业配置/资格/额度。无新增环境变量或主机准备；沿用现有 system migration 发布入口和自有 native quota fork。

上线前审批 Pro 核心 product revision：仅 search/read/cite、research 与共享 `ai_cycle_allowance`，不含 export/专业模块/Max 通道；引用 trial 类型且 `^ent_` table/field/record 有限容量的不可变资源模板。每个 collection 必须有至少一条许可有效、发布状态有效且支持研究的内容，供应才可激活。容量、额度、研究费率、提醒时点由审批版本给出，本文不提供商业数值。

使用 operator 的 `subscription.manage` 能力，通过受控运维通道调用：

- `POST /api/ops/pro-trial/configuration`：`revisionKey`、`productRevision`、`researchRate`、`rateRevision`（至少 2）、`reminderHours`（1–167 小时）、`fixture`、`reason`、`enabled`（默认 true）。同 key 内容不可改；新配置使用新 key。费率修订必须避免与既有不同费率修订冲突。`enabled:false` 停止新领取；已有领取仍可按原不可变版本恢复。
- `POST /api/ops/pro-trial/eligibility`：`accountKey`、`enabled`、`reason`。仅已有 active 账户可被放行；不新增账号或将 workspace admin 提升为计费管理员。撤销资格会拒绝原请求恢复。

fixture:true 显示内部验收说明，不能作为正式商业承诺；语义检索销售承诺仍依赖 LCA12。禁止直接找 token、手工 root 业务写入或开启机器通道。

## 时钟、故障与恢复

预览起止时间为服务端估计；首次领取数据库 `time::now()` 固定开始与开始 + 7d 的截止，期间失败仍消耗原七日，不重置计时。客户端只回传展示版本用于变更校验，不能指定商品、额度或期限。

账户领取 slot/幂等请求用数据库事务收敛；同账户已有有效 trial（包括旧订阅 trial）不能再次领取。十分钟供应 lease 防止并发执行，失败释放；进程中断待 lease 超时，使用原账户、name、slug、key 重试。页面在本会话保存这些公开字段以恢复；身份、资格每次重新核验。当前配置切换不会更换旧请求的冻结版本。关闭配置停止新领取，撤销账户资格用于停止旧请求恢复。

恢复沿用 workspace reservation、订阅来源和内容投影/AI grant。产品、配额、内容许可投影与额度读回确认后，workspace active 和 claim active 在同一事务提交。无授权/无内容/过期/lease 丢失即拒绝激活。已生成但未就绪的数据库保留以恢复，不自动删除。

到期交由 LCA08 的订阅生命周期/内容撤回和 LCA09 当前权限引用/成果保留处理。Plus/Pro/Max 转换必须使用新商业来源及新周期；旧 trial bucket 不继承。提醒目前为成员配额页内提示（刷新间隔一分钟），不发送邮件或自动购买。

## 上线验收与回滚

实现阶段本地数据库供应/并发和受控页面检查，不替代生产用户身份与真实内容研究实测。独立验收后另开合入部署任务，在获批 fixture 配置下记录：显式启动回执、邀请成员后共享范围/余额、一项关键词/语义研究、引用打开、成果保存、准确截止权限收回、保留成果、Plus/Pro/Max 新来源及周期不继承旧余额。测成员/仅 workspace admin 拒绝、跨账户隔离、并发与中断恢复。生产模型调用或计费操作按受控运维授权范围执行。

回滚先禁用当前配置并撤销未完成测试账户资格，再回滚应用提交。新增控制面结构和已发 trial 不删除。回滚/恢复目标的入口语义由发布脚本门禁强制执行（见 production-release.md「切换与回滚的可执行门禁」）：目标是会恢复隐式试用创建的旧 origin（LCA10 之前，公共创建入口自授 trial）时，发布与自动回滚都会被拒绝，不会在人工处置前静默恢复旧入口。保留已有 workspace 和成果，继续使用订阅有效期与当前权限约束。


## LCA14 D2–D3：消费口径与精确来源终止

消费口径以当前 workspace 的商业快照为准：有效的 trial/subscription 来源 ID、有效起止时间、active 状态、未到期及无终止标记共同决定套餐桶是否可消费。购买/补偿桶按自身状态与时间核验，不依附套餐来源；动作权限仍由服务端独立核验。抽屉通过既有 product-entitlement API 获取来源，再浏览器直连读取账本；请求失败、工作区不匹配或来源无法核验时关闭套餐可消费显示。未来生效桶显示“尚未生效”；旧 trial 来源不匹配显示“来源已失效，不可消费”。账面余额与可消费总额分开，不把无物理终止标记的旧桶伪装成已回填。

`027-ai-trial-conversion-source.surql` 与 `047-ai-source-termination.surql` 只追加结构、索引及事件，不扫描/回填旧订阅或旧额度桶。正常 provider trialing→active 或运营 subscription_upsert 转换，在同一商业事务冻结当前 workspace、同一 billing account 的旧 source ID、转换时间和事件键；套餐投放只用这一精确身份终止关联 trial 前缀，不宽扫所有试用桶。终止事实存 workspace 的 `ai_allowance_source_termination`，桶的 `terminated_at/terminated_note` 对应同一商业事件；迟到的同来源桶 CREATE 会继承终止事实。旧金额/期限/历史流水不改。在途预留依既有规则按原桶结算；终止后的取消释放只冲销，不恢复可消费额度。

独立 QA 在受控发布后按以下步骤验收（只用 ops_* 会话，不取 token）：

1. 确认 origin 与 web 均为获准提交；现存 `sck-lca10-qa-02` 仅只读。原试用桶账面28且缺少终止标记是历史状态，不直接 UPDATE。以原授权成员查看抽屉：可消费0、旧桶原因“来源已失效”；与同账号真实研究预留响应及运营 GET `/api/ops/product-entitlements/workspaces/:slug` 的 consumableAllowance 对账。没有该成员身份时记录缺项，不能替换身份声称完成。
2. 新隔离夹具复用获批的不可售试用配置与有效许可内容。计费 owner/admin 通过 preview/start 启动七日试用，记录 claim、workspace、billing account、实际 `quota_subscription:provision_<db>` 与试用 period_key；转换前预留应命中旧试用桶。不要手工 CREATE/UPDATE 生产试用桶。
3. 运营先调用 `/api/ops/quota/preflight`，再 `/api/ops/quota/intents` 提交 `subscription_upsert`，mode=manual_assignment、source=manual、status=active，选择获准的新商业 subscription 与套餐，effectiveAt 在试用启动之后，携带 requestId/customerReason/operatorReason。仅此夹具模拟确认，不调用付款/provider 收款。轮询 `/api/ops/quota/intents/:intentId` 至完成，再读双方来源、桶与终止审计。断言旧 source 与新 source 不同、旧桶标记存在、新桶前缀只属新 source。
4. 同请求重放、并发刷新、在途结算与取消释放、另一 workspace 及其他来源/购买/补偿均须核对。各桶赋相等测试余额，分别检验未来生效、到期、暂停、显式终止、非当前套餐来源，避免余额巧合掩盖过滤错误。受控业务操作造状态，不能让 QA 直接更新旧生产账本。

发布兼容下限由 `origin-release.sh` 的 `require_allowance_source_compat` 强制执行：候选与自动回滚目标必须同时包含共享消费谓词、候选读取与原子扣减的同谓词、v4 精确转换及两份新增结构。缺文件、旧代码或检查失败均在 env/服务切换前拒绝。保留已落地的新增 schema、审计和桶；不得回滚结构或删除事实。首次发布若 previous 未满足下限，自动回滚会被拒绝，应提前准备通过 Quality gate 的兼容回滚提交；健康失败时禁止改脚本绕过门禁启动旧代码。后续规则升级须同时维护这一兼容断言。前端回滚也必须保留来源显示规则，选取同一已验证兼容提交重跑 Deploy production。

此链不修复既有生产历史桶的物理终止标记，也不批准客户灰度。若验收坚持补全历史审计，需另报 owner 红线请求、精确影响范围与只读方案，获准前不执行补账或迁移。


## 首次价值只读核定（首次价值01、03共用）

以下入口仅 GET，无迁移、回填、slot 释放、资格设置或额度变更。每次请求沿用运营 audience、token 活跃性、active operator 与 `subscription.manage` 实时能力校验；客户 audience 返回 403，无登录返回 401，无能力或撤权返回 403。能力是平台范围，具该能力的运营可核定指定账户；不是 billing owner 身份授权。必须给出精确 `accountKey` 和待核定成员的 IdP `subject`，没有账户枚举入口；额外参数拒绝。通过现有 `ops_request` 调用，不持有 token、不新建代理。

- `GET /api/ops/pro-trial/configuration`：当前配置 `enabled/revision/updated_by/updated_at` 与该不可变修订 `fixture/product_revision/research_rate/rate_revision/duration_days/reminder_hours/approved_by/created_at`。没有配置为 `configurationState:missing`；配置引用悬空为 `revisionState:missing`。不泄漏审批理由。
- `GET /api/ops/pro-trial/eligibility?accountKey=<精确账户键>&subject=<成员subject>`（URL 编码参数）：账户状态、该成员 role/status、资格批准人/时间、全部有效旧订阅 trial、全部未到期冻结 claim，以及仍存在的 slot（包括已过期或悬空）。`active` 与 `administrator` 针对指定账户/成员；`eligible` 是显式资格开关，**不是可立即开始试用的总判断**。账户缺失返回 `accountState:missing` 及 `active/administrator:null`；没有资格记录为 `eligibilityState:missing, eligible:null`，明确关闭为 `disabled,false`。不会把无记录/未知当 false。slot 悬空返回 `claimState:missing, blocksNewClaim:null`；原冻结修订缺元数据为 null，不代用当前配置。日期/审计元数据 null 表示未知。
- 数据库 `serverTime` 固定本次观察时钟。有效订阅条件是 `trial_start <= serverTime < trial_end` 且 trialing；claim 的 `unexpired` 是 `ends_at > serverTime`；只有 slot 当前引用的未过期 claim 才使该 slot 的 `blocksNewClaim:true`，与现有启动逻辑一致；lease 只返回 `leaseHeld` 与 `lease_until`（严格大于时钟有效），绝不返回 lease token。数组没有 LIMIT，不能只看第一条；未到期且不再由 slot 引用的冻结 claim 也返回。截止恰等于时钟为过期。
- 引用商品继续使用 `GET /api/ops/product-entitlements/revisions/<product_revision>/inspect`：`templates.resource` 补充原不可变资源模板（id、selector、finite limits、rules）；content/ai/feature 沿用现有读回。workspace 的当前来源与内容不可变修订继续通过 `GET /api/ops/product-entitlements/workspaces/<slug>`（`quota.read`）核对。本链不复制 entitlement 控制面，不读取客户正文。
- `GET /api/ops/runtime-version`：独立返回 `origin` 和 `web` 的 `{state,sha,deploymentId}`。origin 是进程启动时从当前发布包 `server/runtime-release.json` 捕获的完整 SHA；web 是从固定 `https://l.maplayer.top/runtime-version.json` 无凭证、no-store 读取的当前 Pages 构建 SHA。发布 workflow 用批准的 RELEASE_SHA 和 run_id-run_attempt 生成，均非 secret；不新增 `ORIGIN_ENV_*` 或主机准备。缺失、无效、404、SPA fallback 或读回失败均为 `state:unknown,sha:null,deploymentId:null`。origin/web 分开观察，滚动发布时可能不一致；不能把 CI 成功或 health 200 当运行 SHA。web 标识证明当前 Pages 部署，不证明某浏览器仍缓存的旧 JS 已刷新。

部署后独立 QA 只读步骤（示意参数，句柄从本任务 ops 登录返回，不写进交付证据）：

```text
sck call ops_operator_login {"alias":"QA_OPS_LCA11"}
sck call ops_request {"session":"<本任务运营句柄>","method":"GET","path":"/api/ops/runtime-version"}
sck call ops_request {"session":"<本任务运营句柄>","method":"GET","path":"/api/ops/pro-trial/configuration"}
sck call ops_request {"session":"<本任务运营句柄>","method":"GET","path":"/api/ops/pro-trial/eligibility?accountKey=<专用账户键>&subject=<专用管理员subject>"}
sck call ops_request {"session":"<本任务运营句柄>","method":"GET","path":"/api/ops/product-entitlements/revisions/<配置product_revision>/inspect"}
```

核对 fixture `pro_trial_revision:lca10_qa_r1` 与原审批商品/资源/内容修订一致；连续读两遍并比较配置审计时间、slot/claim/资格、订阅期限（serverTime 允许变化）。通过既有 entitlement/额度只读入口补核余额，不能使用 POST“读回”。用客户 `ops_login` 句柄调用三个新 GET，均应 403；无 subscription.manage 的运营身份同样拒绝。保存 origin/web 完整 SHA 与部署 ID，再对照获准提交。尚未部署的实现不能宣称完成这些生产条件。

回滚仅重发先前通过 Quality gate 且满足现有试用/来源兼容门禁的应用 SHA，再重发其 web；新增观测无 schema 或数据需要回滚。回滚到无版本标识的版本时返回 unknown/入口缺失，不能伪造当前版本。此只读链不执行旧 runbook 的禁用配置或撤资格操作，不激活 fixture、不扩资格、不调用模型。

## 统一规则口径（首次价值03）

产品 create/preview/start、额度/到期页、营销站试用说明与本文档使用同一套规则。数值一律来自服务端核定的不可变 `pro_trial_revision`，不在前端或营销页硬编码（历史 12/40 单位等数字不视为现值）。

- 开放对象与计费资格：具备显式 `pro_trial_eligibility` 资格的 active 计费账户 owner/admin 才可在产品内经显式确认启动；workspace admin 身份不构成资格。既有 G2 律师邀请灰度维持其获批范围，本统一文案不扩大也不取消其授权。
- 显式确认：preview 展示完整范围（内容、额度、容量、期限、排除项、fixture 标记）后，须人工勾选确认才 `start`。
- 内部 fixture：`fixture:true` 配置仅用于受控验收，不代表正式商业承诺；产品界面与营销页必须标明。
- 有限容量与共享 AI 额度：容量、研究费率、额度由审批 revision 给出；全体成员共享同一 `ai_cycle_allowance`。
- 七日服务端时钟：起止以数据库 `time::now()` 为准，预览起止仅为估计；期间失败仍消耗原七日，不重置计时。
- 到期保留：到期进入保留模式，成果保留；全文与追问按当前权限重新核验。
- 新来源转换：转 Plus/Pro/Max 必须使用新商业来源与新周期，不继承试用桶。
- 不自动收费与失败重试：无需信用卡、不自动转付费；交付失败用原请求字段重试，不重新计时；slug 冲突或输入错误可修改后重试。
- 无资格/无有效配置：给出明确可恢复步骤（联系计费管理员或邀请人、稍后重试），不承诺所有新用户能新建工作区。

运营配置与读回：更改用 `POST /api/ops/pro-trial/configuration` 与 `eligibility`（`subscription.manage`）；`GET` 同名端点读回 revision/资格/期限/费率/fixture/enabled 与 slot/claim/订阅边界，容量经 `GET /api/ops/product-entitlements/revisions/<product_revision>/inspect` 的不可变资源模板核对。`enabled:false` 停止新领取，已领取按原不可变版本恢复；撤销资格停止旧请求恢复。新增配置不默认启用公众试用，配置与权限 fail-closed。
