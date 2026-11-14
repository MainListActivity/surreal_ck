# 测试物料自助（运营 MCP test_kit_*）

让授权的 agent（例如架构评审 bot）自己开测试账号，不再由运营临时发数据。

## 能做什么

| 工具 | 作用 |
| --- | --- |
| `test_kit_rules` | 只读。是否启用、邮箱正则、每个 agent 未到期上限、有效期、套餐、AI 额度。连接器授权后先调它。 |
| `test_kit_provision` | `email`、`displayName`、`workspaceSlug`、可选 `workspaceName`、`idempotencyKey`。新建 IdP 用户 + trial workspace（trial_v2 容量）+ 100 AI 额度，登记为 30 天到期的测试主体（origin=`test-kit:<agent subject>`），一次性返回激活链接。 |
| `test_kit_status` | `idempotencyKey`。开通慢于同步窗时收尾：登记测试主体并一次性收取激活链接。 |
| `test_kit_list` | 只列本 agent 开的测试账号。 |
| `test_kit_add_member` | `workspaceSlug`、`email`、可选 `isAdmin`/`displayName`。workspace 必须由未到期测试账号拥有、被加者必须是未到期测试账号；以 workspace 所有者身份加入，首次登录按邮箱绑定。 |
| `test_kit_purge` | `subject`、`confirm="purge <subject>"`。立即清理本 agent 开的测试账号（整库删除其独占 workspace）。到期也会被 reaper 自动清理。 |

激活：在浏览器打开激活链接自行设置密码（建议存进 agent 自己的密码库）。任何接口都不收发明文密码。

## 边界

- 邮箱必须整串匹配 `TEST_KIT_EMAIL_PATTERN`（忽略大小写）；未配置 = 全部关闭。正则应只覆盖测试专用别名（例如 `name[+][a-z0-9-]+@gmail[.]com`；用字符类代替反斜杠，避免 env 文件转义），因为身份系统里已存在的邮箱会被复用：此时工具拒绝登记，但代办开通已为其建过 workspace，需要运营手动清理。
- 邮箱已出现在产品成员索引或测试主体登记里 → 直接拒绝，不开通。
- 每个 agent 未到期测试账号 ≤ `TEST_KIT_MAX_ACTIVE`（默认 10）。
- 套餐固定 trial，额度固定 100，有效期固定 30 天；不能登记、清理他人主体，不能操作非测试 workspace。
- 能力 `test.provision` 只经 `PLATFORM_OPERATOR_TEST_AGENTS` 授给 kind=agent 主体；写进 `PLATFORM_OPERATOR_CAPABILITIES` 会让启动 seed 失败。已登记为 human 的 subject 不能被改成测试 agent。

## 给一个 agent 开通

1. 在 IdP 为该 agent 建专用账号（不要复用人的账号），记下其 subject。
2. GitHub secret `ORIGIN_ENV_PLATFORM_OPERATOR_TEST_AGENTS=<subject>`（多个逗号分隔）、`ORIGIN_ENV_TEST_KIT_EMAIL_PATTERN=<正则>`，跑 Deploy origin。启动 seed 登记 `platform_operator{kind:"agent"}` + `test.provision`。
3. IdP 的 MCP scopes 必须含 `test.provision`（ma_hono `DEFAULT_MCP_SCOPES`），否则 token 里没有这个 scope，工具报 forbidden。
4. agent 在其客户端添加 MCP 连接器 `https://<api>/api/ops/mcp`，用专用账号授权并勾选 `test.provision`，先调 `test_kit_rules`。

## 收回

从 `PLATFORM_OPERATOR_TEST_AGENTS` 删掉 subject 不会撤销已授能力（seed 只补不收）；需要在 `_system.platform_operator_capability` 把该行 `status` 改为 `revoked`，或把 `platform_operator.status` 改为 `disabled`。清空 `TEST_KIT_EMAIL_PATTERN` 可立即关闭开通（列出、清理仍可用）。
