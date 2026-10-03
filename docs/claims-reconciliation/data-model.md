# 11.1 债权对账 · 数据模型

- **Status**: Accepted（经理锁定，设计定稿 `7f671391`）
- **Date**: 2026-10-03
- **Companion ADR**: [`../adr/creditor-token-submit.md`](../adr/creditor-token-submit.md)

## 范围

一个破产案件 = **一个 workspace 数据库**。名册、企业账面、债权人申报、差异结论、令牌哈希、利息计算快照都在该库的表中。

- **管理人**：OIDC + 浏览器直连 SurrealDB（既有 `admin` / `participant` 权限）。
- **债权人**：无数据库账号；仅通过令牌窄入口由服务端写入申报与附件元数据。

本期文档只定**逻辑模型与校验规则**。物理表名、是否落在专用表或工作簿实体表，由后续导入 / 入口 / 利息 / 对账实现任务在 schema 迁移里落地；不得违背下列字段语义与约束。

与现有可选模板包 `bankruptcy-claims`（债权人 + 债权申报两张工作表）的关系：该模板仍可用于日常台账；**11.1 对账链路以本文字段为准**。实现可将对账表与模板表对齐或映射，但不得删减本文必填语义。

## 表与字段

### 1. 债权人名册 `creditor_roster`

| 字段 | 类型语义 | 约束 |
| --- | --- | --- |
| `subject_type` | 枚举：`enterprise` \| `person` | 必填 |
| `name` | 文本 | 必填；与令牌打开时输入的「名称」比对 |
| `identity_code` | 文本 | 必填；名册内**唯一**；不做身份证 / 统一社会信用代码校验算法 |
| `contact_name` | 文本 | `subject_type=enterprise` 时**必填**；个人可与 `name` 相同或留空按实现约定，推荐填写 |
| `contact_channel` | 文本 | 联系方式；推荐填写 |
| `created_at` / `updated_at` | 时间 | 系统维护 |

**导入校验**：企业行缺少对接联系人 → **拒绝该行并给出 Excel 行号**。识别码空或与名册内已有行冲突 → 拒绝并给出行号。

### 2. 企业账面 `enterprise_ledger`

| 字段 | 类型语义 | 约束 |
| --- | --- | --- |
| `identity_code` | 文本 | 必填；必须已存在于名册 |
| `principal` | 十进制金额 | 必填；≥ 0 |
| `book_interest` | 十进制金额 | 必填；≥ 0（企业账面已记利息，可为 0） |
| `contract_ref` | 文本 | 合同引用 / 编号；可空 |
| `note` | 文本 | 备注；可空 |

**导入校验**：必须先有名册。识别码不在名册中 → **拒绝该行并给出行号**。同一识别码允许多条账面分录（若业务需要拆合同）；对账视图按识别码聚合或逐条对齐的策略在对账交付中固定，默认 **按识别码聚合本金与账面利息** 再与申报对比。

### 3. 债权人申报 `claim_submission`

由令牌入口写入（或更新草稿→提交）。

| 字段 | 类型语义 | 约束 |
| --- | --- | --- |
| `roster_id` / `identity_code` | 关联名册 | 由令牌绑定，债权人不可改绑 |
| `principal` | 十进制金额 | 必填；≥ 0 |
| `rate_segments` | 分段利率列表 | 见利息规则；至少一段或显式「不计息」 |
| `interest_start` | 日期 | 计息起始日（含） |
| `interest_end` | 日期 | 计息终止日（不含）；须 > 起始日 |
| `interest_method` | 枚举 | v1 固定支持 `simple`（单利）；其它值拒绝 |
| `penalty` | 十进制金额 | 可空；**无约定则不算**（空或 0 且无说明则对账不纳入违约金主张） |
| `statement` | 文本 | 说明 |
| `status` | 枚举 | `draft` \| `submitted` \| `needs_info` \| `closed` 等（对账交付可扩展） |
| `submitted_at` | 时间 | 首次提交时写入 |

**附件**：至少一份。类型枚举至少覆盖：`contract`（合同）、`statement`（对账单）、`judgment`（判决书）。元数据字段：`attachment_type`、`file_name`、`content_type`、`byte_size`、`storage_key`、`uploaded_at`。字节在对象存储；库内只存元数据（见 ADR §5）。

### 4. 提交令牌 `claim_access_token`

| 字段 | 类型语义 | 约束 |
| --- | --- | --- |
| `roster_id` | 关联名册一行 | 必填；一对一或一对多（作废旧令牌）由实现定，推荐同一债权人仅一条 `active` |
| `token_hash` | 字节 / hex | 必填；明文不存 |
| `status` | 枚举 | `active` \| `revoked` \| `exhausted` |
| `opened_at` / `last_attempt_at` / `failure_count` | | 限速与审计 |
| `created_by` | 管理人 subject | 审计 |

### 5. 利息计算快照 `interest_calculation`

每次重算写入**新行**，不覆盖旧行。

| 字段 | 类型语义 | 约束 |
| --- | --- | --- |
| `submission_id` | 关联申报 | 必填 |
| `rule_version` | 文本 | 必填；如 `interest-rules/v1` |
| `inputs` | 结构化 | 本金、分段、起止日等输入快照 |
| `segments` | 结构化 | 每段：起止、天数、基数、利率、利息 |
| `total_interest` | 十进制 | 必填 |
| `calculated_at` | 时间 | 必填 |

**不可变**：历史计算结果不因以后修改规则文档或代码而被改写；新规则用新 `rule_version` 另算。

### 6. 差异结论 `reconciliation_finding`

| 字段 | 类型语义 | 约束 |
| --- | --- | --- |
| `identity_code` | 文本 | 对齐键 |
| `categories` | 枚举集合 | 见下「四类差异」；一条结论可含多类 |
| `manager_note` | 文本 | 管理人结论或补充要求 |
| `state` | 枚举 | `open` \| `waiting_creditor` \| `resolved` 等 |
| `linked_submission_id` | | 可空 |

## 四类差异

| 类别 | 含义 |
| --- | --- |
| `amount_mismatch` | 金额差：申报本金（及纳入的违约金主张）与账面本金等金额字段不一致 |
| `interest_mismatch` | 利息差：申报隐含利息或系统按合同重算结果与账面利息不一致 |
| `missing_evidence` | 缺合同或证据：附件缺失、类型不足，或账面/申报引用的合同材料不完整 |
| `identity_mismatch` | 身份不符：**账面识别码对不上名册**（导入期应已拒绝；若历史数据或手工写入仍出现，对账必须标出） |

债权人侧看不到企业账面；对账并排视图仅管理人可见。

## 权限摘要

| 主体 | 名册 / 账面 | 申报 / 附件元数据 | 利息快照 / 差异 |
| --- | --- | --- | --- |
| 管理人 admin | 直连读写 | 直连读；不经门户写他人申报 | 直连读写 |
| 管理人 participant | 按既有 PERMISSIONS | 读 | 读（写权限随实现收紧） |
| 债权人 | 无 | 仅令牌入口写自己的 | 无 |
| 匿名 | 无 | 无（打开前） | 无 |

## 迁移类型预期（后续实现任务）

后续 schema：**只新增结构**（新表 / 新字段）。本设计定稿交付**无数据库迁移**。
