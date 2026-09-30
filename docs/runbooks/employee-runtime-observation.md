# 员工会话受控观测（VER02 补交付）

入口：`GET /api/internal/workspaces/:slug/employees/:employeeKey/runtime`。
生产：`https://l.maplayer.top`；employeeKey 是生命周期 API 返回 `employee.id` 去掉 `user:` 前缀。
现有 OIDC Bearer 认证；token `db` 必须精确等于 slug 对应数据库，`ac=admin`。无凭证 401，participant/跨库/缺 scope 403。无前端页面，无业务 CRUD/SQL 代理，无 schema 迁移、新环境变量或主机准备。

生产装配读取 `getEmployeeRuntime()`，与员工生命周期、执行窗口共用同一进程实例。探测只在已有会话调用 SDK 2.0.8 `auth()`：固定读取当前 `$auth`，校验员工 ID 和 active 状态，1500ms 超时。不会注册、SIGNIN、重连或写业务。读取结果中的其他字段全部丢弃。返回 `Cache-Control: no-store`。

| 字段 | 含义 |
| --- | --- |
| database / employeeId | 本次目标库和员工 |
| instanceId / sampledAt | runtime 随机 UUID 和完成采样的 UTC 时间；实例变化意味着重启/不同进程，不能拼成同进程证据 |
| sessionPresent / usable | 当前允许获取的会话是否存在，以及固定身份探测是否通过；不能用 HTTP 200 代替 usable |
| connectionCount | 此员工 runtime 持有的连接对象数，含连接中及关闭失败的对象；单员工辅助证据，不是数据库全局连接数 |
| generation / lastRegisteredAt | 本实例此员工成功完成 SIGNIN 并登记的累计代次与最后时间 |
| lastClosedAt / closeConfirmed | 实际 SDK close 完成时间和确认结果；null=尚无实际关闭或关闭处理中，false=实际关闭失败，true=待关闭对象均完成；它是最近一次关闭的证据，恢复后仍保留 |
| probeCode | ok / absent / unavailable / timeout / changed；探测期间发生关闭或换代返回 changed 且 usable=false |

SDK WebSocket 引擎的 close 在 disconnected 事件后完成。失败会返回稳定 `employee-close-failed`，保留待关闭连接用于重试，不确认成功。普通窗口 close 完成后允许下一次显式注册；生命周期暂停/退休才持续封禁。暂停/退休立即封住 session 获取，作废旧注册，并串行等待旧 SIGNIN 与实际 close；退休不能通过 activate 复活。重复 pause/retire 重试关闭。替换会话也先确认旧连接关闭，关闭失败时不新开连接。日志只发 registered/closed/close-failed/signin-failed 和随机实例标识，不输出目标输入、凭证、payload、原始错误链。

## QA 最小复测

QA 先登记测试 workspace，取得该库 admin、participant 和另一库 admin 的 OIDC token，安全注入环境。不要把 token 放在命令行、证据或文件中。只创建本次专用员工，禁止操作 `claims_risk_reminder` 或客户数据。

所需临时环境：`SCK_VERIFY_WORKSPACE`、`SCK_VERIFY_ADMIN_TOKEN`、`SCK_VERIFY_PARTICIPANT_TOKEN`、`SCK_VERIFY_FOREIGN_ADMIN_TOKEN`；可选 `SCK_VERIFY_URL`（默认生产）。这不是服务部署环境变量。

```sh
rtk proxy bun scripts/verify-employee-runtime.ts
```

脚本无需重启：创建专用员工→同实例可用探测→无凭证/participant/跨库拒绝→并发重复 pause→确认关闭且不可用→resume→同实例新代次且仅一连接→并发幂等创建重放→并发 retire→关闭且拒绝恢复。每阶段只输出操作、状态与白名单诊断字段。失败后 finally 尝试通过正常 API retire；如果清理失败，从最后输出的专用 employee key 通过正常 retire API 重试。创建返回未知响应或网络失败时，使用本次 requestKey 的幂等创建恢复后 retire；生产验证期间需单独安全记录该 key。

QA 证据应保留脚本退出码及阶段摘要、生产运行提交/发布 CI、实例/代次/时间；结合 closeConfirmed、connectionCount 和 usable，不能用 Map 有/无或独立新 SIGNIN 代替部署连接证据。日志去敏用本地合成敏感标记测试，不向生产注入失败。生产日志抽样由 QA 使用已授权的现有观测通路完成；该脚本不读取主机日志、不 SSH。

## 本地回归与边界

```sh
rtk proxy bun test server/ai/office/employee-runtime.test.ts server/ai/office/employee-runtime-observation.test.ts server/ai/office/employee-lifecycle.test.ts server/src/routes/employees.test.ts server/src/db/employee-lifecycle.integration.test.ts --preload ./server/test/setup-env.ts
rtk proxy pnpm lint
rtk proxy pnpm typecheck
rtk proxy pnpm test
```

真实库测试使用本地临时内存 SurrealDB 与本地 JWKS，确认已有员工连接固定 auth 可用，pause/retire 的 disconnected 事件与 SDK disconnected 状态、resume 新代次。并发/关闭失败/去敏测试使用注入连接，合成敏感标记不会进入响应或诊断日志。运行成功不等于生产验收。

诊断数据仅在进程内，无持久化历史。本交付不新增 scheduler，不覆盖 VER04 真正 trigger/window 拒绝，不代表 VER06 续约、重连、容量或长期运维已验收。上线后仍需 QA 生产复验，且目标整体验收等待该链完成。

## 受控 trigger 投递诊断口（VER 联验补齐）

入口：`POST /api/internal/workspaces/:slug/employees/:employeeKey/triggers`，与上文 GET runtime 观测口同级、同一 scope 规则（token `db` 精确等于 slug 对应数据库且 `ac=admin`；无凭证 401，participant/跨库 403）。

用途：给指定员工投递一个**无副作用**的 `qa-probe` 触发，验证"投递 → employee SIGNIN → 执行窗口 → durable run → effect 账本"整条真实链路。handler 只经 `runEffect("qa-probe", …)` 记一行 `employee_effect` 账本并返回 `{ probe: true, triggerId, employeeId, payloadRef }`；不写任何业务表，不消耗模型额度。生产装配在 `getEmployeeTriggerRuntime()` 共享单例上常驻注册，不依赖 dispatcher 启动顺序。

请求体：

| 字段 | 规则 |
| --- | --- |
| idempotencyKey | 必填，8–200 位 `[a-zA-Z0-9:_-]`；同键重放返回既有终态 |
| payloadRef | 可选 string ≤200 字符，原样回显在 probe 结果里 |
| reason | 可选，仅允许 `qa-probe`（缺省即 qa-probe），其他值 400 |
| chainDepth | 可选非负整数，默认 0；超过 runtime 链深上限时 outcome=failed |

响应恒为 HTTP 200 + `{ ok: true, outcome, triggerId?, error? }`：`completed`/`coalesced`/`waiting`/`failed` 都是正常终态——`failed` 本身就是诊断结论（如暂停/退休/缺凭证员工在 SIGNIN 阶段被拒，此时 `employee_trigger` 不落行、`error` 说明原因；超链深同上）。参数非法才返回 4xx。响应不含 Surreal 行对象、会话、凭证或堆栈；投递后可用 GET runtime 观测口核对会话/窗口证据。

QA 最小用法：登记测试 workspace 的 admin token → POST 本口投递 `qa-probe` 到 active 夹具员工 → 期望 `outcome:"completed"`；pause 该员工后换幂等键再投 → 期望 `outcome:"failed"` 且观测口无新窗口。
