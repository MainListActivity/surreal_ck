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

## 隔离联调（真实浏览器 + 真实 SurrealDB，合成数据）

QA 退回补做的浏览器联调。环境：vanilla SurrealDB 3.2.3 内存实例（`ws://127.0.0.1:19000`）、fixture OIDC IdP（`http://127.0.0.1:19001`，脚本 `.scratch/sck-lca-03-e2e/fixture-idp.ts`，含真实 authorize/PKCE/token/JWKS/scope 端点，签发前真实调用应用 default-scope hook）、候选 server `:8080`（唯一 stub 是 native-quota 启动门，vanilla 无该扩展面）、vite dev `:5173`。工作区 `ws_alpha`（alice admin、bob participant、carol 已移除）与 `ws_beta`（eve participant、权益快照已过期）由 root 种子按 creator 同名字段写入，工作区库应用真实 workspace-template。内容、集合绑定、许可修订、过期许可来源为 root 种子。

这不是最终验收：IdP 是 fixture、内容与工作区是合成种子、工作区 provisioning 因 vanilla 缺 `INFO FOR QUOTA` 改走 root 种子。

### 浏览器路径（ego-browser 实测，页面真实渲染）

| 步骤 | 实际结果 |
|---|---|
| alice（alpha admin）登录 | 真实 OIDC code+PKCE 流程过 `/api/auth/token` 代理；hook 返回 `db=ws_alpha, ac=admin`；浏览器直连 SurrealDB signin 成功，工作区 dashboard 渲染 |
| 入口 → 打开 `law-demo-1` | 侧栏"法律内容"入口 → 输入公开 ID → `/w/alpha/content/law-demo-1` 渲染：标题、精确版本"2026 联调修订 · #3"、来源 `full_text · https://synthetic.invalid/law-demo-1`、授权状态"当前已授权读取"、正文两段 |
| 返回工作区 | 工作区界面与连接正常，workspace token 未被替换 |
| bob（alpha participant）同流程 | 同样成功打开阅读页，正文可读 |
| 不存在公开 ID `no-such-law` | 阅读页显示"无法打开正文／当前授权不允许读取"，无内容泄漏 |
| `law-withdrawn`（publication_status=withdrawn） | 同上拒绝页 |
| eve（beta，权益快照已过期） | 登录 beta 工作区正常；打开 `law-demo-1` → 拒绝页（API 实际 `content-reader-entitlement_expired`） |
| carol（已从 alpha 移除） | 登录后看到"还没有工作区"；直接访问 `/w/alpha/content/law-demo-1` 同样不能进入（API 实际 `content-reader-member_removed`） |

### 数据库层矩阵（`.scratch/sck-lca-03-e2e/db-matrix.ts`，真实 SurrealDB + 真实签发 token）

| 检查 | 结果 |
|---|---|
| 换票成功 | HTTP 200，`expiresInSeconds=900`，返回 workspaceId/revision/digest/leaseEndSeconds |
| content_reader 认证读正文 | 认证成功，`SELECT body_text` 返回两段正文；法条 `legal_article_version.body_text` 可读 |
| 隐藏字段 | `license evidence_text` 0 行；版本 `evidence`/`processing` 返回 NONE |
| 读者自读门禁 | 只看到自己工作区的 1 行 gate，`actions=["browse","read","cite"]` |
| DDL | `DEFINE TABLE` → IAM NotAllowedError |
| DML/写投影/写门禁 | UPDATE 正文、DELETE gate、UPDATE 自身投影、CREATE gate 均无报错但 0 行生效（root 复核：body 未变、gate 仍 1 行、无新增投影） |
| 并发换票 | 同工作区 3 并发全成功；投影仍 1 行 active、门禁仍 1 行 |
| 换票负例 | 过期权益 `entitlement_expired`；移除成员 `member_removed`；非成员 `not_member`；撤回内容 `content_withdrawn`；过期许可 `license_expired` |
| 伪造 token | workspace/revision/subject 任一项不匹配 → authenticate 被拒"content projection rejected" |
| 投影中断 | `status=closed` 后旧有效 token authenticate 被拒；恢复 `active` 后恢复 |
| token 过期 | 1s token 过期后 authenticate 被拒 |
| 工作区 admin token 用 RL=Owner 直签内容库 | 拒绝（内容库无 admin access） |

### 联调期发现并修复

- `fn::content_reader_action` 的 `ai_use` 分支改查 `ai_actions`（修复前在 B 分支，合入候选）。
- 换票发票条件：动作交集仅剩 export 或 aiUse 时不再拒绝。
- 成员核验按 workspace `identityFilter` 同语义放宽为 subject 或（subject=NONE+email）匹配，否则未 switch 的 email 绑定成员会被误判移除。
- 换票失败与投影写失败分别返回 503/`projection_incomplete`，均不扩大访问。

### 遗留未验证项（交 QA/G2）

- 真实 IdP（ma_hono `content_reader.v1` 部署态、allowlist、实际 TTL）与生产库。
- native-quota 版 SurrealDB 的启动门与 provisioning saga（vanilla 上 stub 跳过）。
- 超过 15 分钟墙钟的 reader 会话与 `DURATION FOR TOKEN 15m` 到期行为。
- 门户级"双工作区浏览器矩阵"中 beta 用合成过期权益代替真实跨工作区夹具。

