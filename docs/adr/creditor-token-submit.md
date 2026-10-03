# ADR: 债权人令牌提交窄入口（11.1 债权对账）

- **Status**: Accepted（经理锁定，设计定稿任务 `7f671391`）
- **Date**: 2026-10-03
- **Scope**: `server/` 新增一组公开 Hono 路由；`web/` 债权人提交页（无 workspace 登录）；案件 workspace 内申报与附件元数据表。不影响管理人直连路径。
- **Companions**:
  - [`frontend-direct-connect.md`](./frontend-direct-connect.md)（本 ADR 是对其「后端不做业务 CRUD 代理」原则的**唯一、窄例外**）
  - [`workspace-as-database.md`](./workspace-as-database.md)（一案一库不变）
  - [`../claims-reconciliation/data-model.md`](../claims-reconciliation/data-model.md)
  - [`../claims-reconciliation/excel-templates.md`](../claims-reconciliation/excel-templates.md)
  - [`../claims-reconciliation/interest-rules.md`](../claims-reconciliation/interest-rules.md)

## Context

11.1 破产债权对账要求：管理人把专属链接发给债权人；债权人在线填写申报并上传附件；数据进入该案件 workspace，供管理人与企业账面、系统利息重算并排对账。

现有架构（`frontend-direct-connect`）规定：业务读写由浏览器直连 SurrealDB；后端不做工作簿 / 数据表 / LIVE 的通用代理。债权人**没有** IdP 账号，也**不能**获得 workspace `db`/`ac` token，因此无法走直连。

若把债权人做成普通用户并签发 workspace scope，会扩大身份面、混淆「管理人权限」与「债权人只看自己申报」的边界，并迫使 IdP / membership 为临时外部主体建档。

## Decision

**只增加一组带令牌的公开 Hono 路由，作为服务端写入申报记录与附件元数据的唯一入口。不增加通用 CRUD / LIVE 代理，不引入 service JWT，不给债权人发数据库账号。**

### 1. 拓扑

```
管理人浏览器 ──OIDC──► IdP
              ──WSS──► SurrealDB（案件 workspace：名册 / 账面 / 申报 / 差异 / 令牌哈希）
              ──HTTPS─► Hono（workspace 创建、scope、运营……既有能力）

债权人浏览器 ──HTTPS─► Hono 令牌窄入口（本 ADR）
                         ├─ 校验令牌哈希 + 姓名/识别码双重匹配
                         ├─ 写入本债权人申报行与附件元数据
                         └─ （附件字节）→ 既有对象存储（见 §5；当前有缺口）
              ✗ 不直连 SurrealDB
              ✗ 不走 OIDC / workspace scope
```

### 2. 令牌

| 规则 | 约定 |
| --- | --- |
| 熵 | 加密安全随机，建议 ≥ 256 bit（如 32 字节 URL-safe base64） |
| 存储 | 案件库只存**哈希**（如 SHA-256(token \|\| server_pepper)）；明文永不入库 |
| 出示 | 明文只在管理人生成后的**复制瞬间**出现一次；刷新/重开列表只显示「已生成 / 已打开 / 已提交」等状态 |
| 绑定 | 一枚令牌绑定名册一行（债权人主体）；不可跨债权人复用 |
| 打开 | 必须同时输入**名称**与**唯一识别码**，与名册该行一致才进入 |
| 失败 | 统一文案（例如「姓名或识别码不正确」），不区分哪一项错，不回显名册任何字段 |
| 限速 | 按令牌（及可选 IP）限制尝试次数；超限暂时锁定（实现默认：同一令牌 15 分钟内失败 ≥ 5 次则锁定 30 分钟，具体常量可配置） |
| 分发 | 系统**不发送**邮件或短信；UI 只提供链接复制，由管理人自行转发 |

### 3. 路由面（实现契约，路径可微调但语义固定）

公开前缀建议：`/api/claims-portal/:token/...`（最终实现以路由注册为准）。

| 能力 | 行为 |
| --- | --- |
| 打开会话 | 提交名称 + 识别码；成功则签发短时**门户会话**（HttpOnly cookie 或等价），作用域仅该令牌 |
| 读自己的申报草稿/已提交 | 仅本令牌绑定债权人 |
| 写/更新申报 | 仅本令牌；字段见 data-model「申报」 |
| 上传附件 | 至少一份；类型枚举含合同、对账单、判决书；服务端写附件元数据并关联申报 |
| 响应管理人补充要求 | 往返留痕（后续对账交付实现） |

写入主体是 Hono 使用的**受控服务端会话**（root 或专用窄权限写入路径，仅触及本案件库的申报/附件元数据表）。**禁止**引入可被浏览器持有的 service JWT 代替债权人身份。

### 4. 明确不做

- 未知债权人公开自助报名（须管理人先补名册再发链接）
- 支付宝 / 微信等真人识别（下期）
- 系统代发邮件 / 短信
- 工作簿、办公、LIVE 的通用后端代理
- 用 AI 给出利息数字（利息见 `interest-rules.md`）

### 5. 附件存储查证（2026-10-03）

任务要求：沿用 Cloudflare R2 的前提须写明查证结果。

| 查证项 | 结果 |
| --- | --- |
| `server/src/**` 是否存在 S3/R2 客户端或上传路径 | **无**（全库 `PutObject` / `@aws-sdk` / `R2_` / `S3_` / `ATTACHMENT` 业务引用为空） |
| `.env.example` 是否声明桶或上传相关变量 | **无** |
| GitHub `production` Environment 的 `ORIGIN_ENV_*` | 现有：`AI_DELIVERY_KEY`、`CONTENT_PUBLISHER_SECRET`、`OIDC_OPS_CLIENT_ID`、`PLATFORM_OPERATOR_*`；**无** `R2_*` / `S3_*` / `BUCKET*` / `ATTACHMENT*` |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` | 存在，用于 Pages / Worker **部署**，不能当作已配置的 R2 对象桶读写凭证 |

**最小缺口（不规划新云厂商、不写购买步骤）：**

1. 生产需已有（或老板批准后由有权者创建的）**一个** Cloudflare R2 桶，供债权申报附件使用。
2. 需在 `production` 登记服务端可读的 `ORIGIN_ENV_*`（建议键名，实现时可微调但须写入 runbook）：
   - `ORIGIN_ENV_CLAIMS_ATTACHMENT_ACCOUNT_ID`（或复用既有账户 ID 的只读配置面）
   - `ORIGIN_ENV_CLAIMS_ATTACHMENT_ACCESS_KEY_ID`
   - `ORIGIN_ENV_CLAIMS_ATTACHMENT_SECRET_ACCESS_KEY`
   - `ORIGIN_ENV_CLAIMS_ATTACHMENT_BUCKET`
   - `ORIGIN_ENV_CLAIMS_ATTACHMENT_ENDPOINT`（R2 S3 兼容 endpoint）
3. 对象键建议：`claims/{workspaceDb}/{submissionId}/{attachmentId}/{filename}`；元数据（文件名、MIME、大小、类型枚举、存储键、上传时间）落在案件库表，由令牌入口写入。
4. 管理人查看附件：经已认证的管理人会话由 Hono 签发短时下载 URL 或受控代理流；债权人和匿名者不能列举桶。

**债权人入口实现交付（链上 `5573b733`）在缺口未关闭时必须 `report_blocker to=gm`，不得新购桶或换厂商。** 本设计定稿只记录缺口，不阻塞文档合入。

### 6. 与直连原则的关系

本例外的边界是：**仅**令牌证明的债权人申报写路径 + 附件元数据。名册导入、账面导入、对账结论、利息重算触发、导出等，仍由**已登录管理人**在浏览器直连（或既有运营/导入能力）完成，不借本窄入口做通用代理。

## Consequences

- 后续实现必须保持令牌哈希存储与统一失败文案；安全回归以「不回显名册」为硬条件。
- 附件能力依赖 R2 缺口关闭；在关闭前可先落地令牌会话与申报字段写入（无附件）的骨架，但产品完成标准要求附件必传，故入口交付不能在缺口上宣称完成。
- 历史利息结果的不可变规则见 `interest-rules.md`，与本入口解耦。
