# SCK-LCA-03 发布前候选

集成人：`engineering-grok-4e9709`。集成分支 `task/86b409f0`。本文件是预发布说明，不是生产验收，也不把实施票标成 done。生产发布、权限、许可和投影状态变更仍要等 G2 `553ba0a0-79d8-4b72-bdc9-9f8ef1d4bdee` 对这个候选和具体操作方案批准。

## 固定提交

| 来源 | 已验收提交 | 内容 |
|---|---|---|
| A | `1026694ed9fceb16be7bf3c0e867e6e7a36b24a5` | 契约与 900 秒上限 |
| B | `95847207976b898f7cc187ec2a5c4f8af39bcd04` | 内容库 006、换票与投影写入 |
| C | `ff0b66aa4489fe616dde3c1196317dfcadfd49fa` | 工作区入口与独立阅读页 |
| D | 本分支合并提交 | B 与 C 无文件重叠，合并无冲突 |

验收记录里出现过的 `9584720d48718a1b96a7d11e58ac9ffe1f26e179` 不是仓库对象。候选使用上面的 B HEAD。

## 时限

- 应用 lease、IdP 默认 TTL、数据库 `TOKEN` 与 `SESSION` 都是 15 分钟（900 秒）。
- `lease_end = min(now+900, subject 到期, 权益截止, 许可截止)`。空截止点不是无限授权。
- 已建立连接的新读取在 `min(token exp, session 截止, 投影 confirmed_until)` 内关闭，三者各自不超过起点后的 900 秒。
- 客户读取不能把 `confirmed_until` 往后推。

## 迁移

相对产品 `main` `15c49fb`，内容库只新增 `shared/sql/platform-content/006-content-reader.surql`。001–005 与 `shared/sql/system/021-product-entitlement.surql` 没有改。006 增加：

- `content_projection_sync`：受限 RECORD，只写投影和门禁。
- `content_authorization_projection`：每个 `workspace_id` 一行。
- `content_read_gate`：每个工作区的一个内容版本一行，带发布状态、许可动作和许可截止的同步副本。
- `content_reader`：RECORD JWT，时长 15 分钟。JWKS、issuer、audience 在启动时注入，不写进迁移文件。

来源许可原文仍只含运营动作时，不能从 `publish` 推出 `read`。客户动作必须同时出现在权益和许可里。

## 部署顺序（G2 批准后才执行）

1. 确认目标 IdP 已部署 `content_reader.v1`，并且 `content_reader_allowed_client_ids` 含本应用 confidential client。未配置时换票失败。不要在这一步改 `ma_hono` 代码。
2. 部署本候选服务。启动沿现有入口应用内容库迁移到 006，再用运行环境的 OIDC JWKS 定义 `content_reader`，并初始化投影同步凭证。root 只建凭证，不读取客户正文。
3. 不把正文复制进客户 workspace，不新增 service JWT。
4. 用下面的核验清单看投影，再交给 QA 做生产矩阵。

## 回退

1. 停止继续换票：去掉 IdP allowlist，或停止新版本服务。
2. 将 `content_authorization_projection` 与 `content_read_gate` 的 `status` 设为 `closed`。已建立连接最多再读到 900 秒。
3. 不删除 001–005，也不从版本链里抽掉 006。若要收回结构，另加更高版本迁移。
4. 回退服务镜像到批准前的版本。工作区原登录和 workspace token 不依赖内容票。

## 投影核验

- 活跃行的 `digest` 以 `sha256:` 开头，且等于该工作区当前权益快照。
- `revision` 是权益 revision 的十进制字符串。
- `confirmed_until - confirmed_at` 不超过 15 分钟。
- `allowed_subjects` 只含 `disabled_at = NONE` 的真人成员。
- 门禁行的 `publication_status` 不是 `published`，或 `license_until` 已过，则下一次内容查询没有正文。
- `content_reader` 对投影和门禁的更新不改变 root 读到的 `status`。
- 日志里没有 access token、client secret、subject token 或正文。

## 预发布结果

开发库是本机 SurrealDB 3.2.3 内存实例，合成内容和测试凭证。这不是最终验收。

| AC | 本候选看到的结果 | 未做 |
|---|---|---|
| 换票只信服务端事实 | handler 测试用假库和假 IdP：非成员、移除、无权益、缺内容、content_reader 自票和过期 subject 都拒绝；成功后才写投影 | 真实 IdP 与真实浏览器登录 |
| revision / digest | 投影集成测试把摘要和 revision 写入门禁，错误 revision 不能读 | 生产快照 |
| RECORD 与 schema 权限 | 读者会话读字段；管理员 `RL=Owner` 不能改正文。`DEFINE TABLE` 在 3.2.3 上挂起且 1.5 秒后表仍不存在 | 不能把挂起写成引擎返回了明确错误 |
| 阅读页 | web 单测覆盖第二连接、拒绝不留旧正文、切换工作区丢弃旧授权。官方 web typecheck 0 error，2 个既有 warning | 未打开真实浏览器 |
| 五动作 | 开发库分别验证 browse、search、read、cite、export；正文只在 read，摘录只在 cite。契约测试覆盖 AI 独立位 | 未跑 AI 产品流程 |
| 900 秒 | 契约测试拒绝超过 900 秒的截止；schema 时长为 15m | 未对长连接做超过 15 分钟的墙钟实验 |
| 受限写入 | 同步身份写入；读者更新不改变投影状态 | 未在生产库执行 |
| 双工作区矩阵 | 开发库覆盖两个工作区、错误 revision、移除主体、过期确认、撤回和许可截止 | 没有非成员浏览器账号矩阵 |

命令：`surreal validate shared/sql/platform-content/006-content-reader.surql` 退出 0。`bun test` 覆盖 reader 集成、投影集成、换票、handler、IdP adapter、web content-reader 与 route。server `tsc --noEmit` 退出 0。`pnpm --filter @surreal-ck/web typecheck` 退出 0。

## 交给样本计划与 G2 的未知项

- 目标 IdP 是否已经部署未提交的 `content_reader.v1`，allowlist 与实际 max TTL。
- `15c49fb` 之后的提交是否已经在生产。
- 正式内容集合、来源许可里的客户动作、两个真实工作区的成员身份。
- 样本计划任务不在工程可见队列里；QA 用自己的样本计划接这份候选，不用合成正文代替生产验收。
