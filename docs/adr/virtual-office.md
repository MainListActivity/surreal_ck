# ADR: 虚拟办公室——基于 workspace-as-database 与 RECORD access 的自治协作架构

- **Status**: Proposed
- **Date**: 2026-05-16
- **Scope**: 全新 `server/` 目录、每个 workspace database 的 schema seed、`web/`（Web 前端）
- **Companions**:
  - [`web-only-pivot.md`](./web-only-pivot.md)（部署形态）
  - [`workspace-as-database.md`](./workspace-as-database.md)（workspace ↔ database 映射 + 用户身份）
  - [`frontend-direct-connect.md`](./frontend-direct-connect.md)（前端直连 SurrealDB：办公室 UI 直接 LIVE 订阅，dispatcher 仍后端）

## Context

产品目标已经从"本地表格 + AI 抽屉"偏移到 **虚拟办公室**：用户在工作区导入数据并写下目标，系统中由 **岗位** 驱动的 **虚拟员工** 自治推进数据建模、表单设计、跟进、汇报、向真人发起 **用户通知请求**。

新的部署 + 身份模型已由两份姊妹 ADR 锁定：

- 单容器 Bun server + 自部署 SurrealDB（同机房内网），前端不直连 DB，参见 [`web-only-pivot.md`](./web-only-pivot.md)。
- 每 workspace 一个 SurrealDB database，用户与虚拟员工都以 record 身份存在于该 db 内的 `user` 表，参见 [`workspace-as-database.md`](./workspace-as-database.md)。

本 ADR 在这两份 ADR 给的拓扑与身份基础上回答：

1. 虚拟员工怎么登录、怎么写库。
2. 谁来"拉起"虚拟员工执行——cron？webhook？常驻进程？
3. 派单 / 汇报 / 通知 走什么数据通路。
4. 与既有 Router workflow（用户主动发问—同步应答）如何并列。
5. 失败、重启、死循环、token 预算怎么治理。

## Decision

### 1. 虚拟员工的存在形式与登录方式

每个 workspace database 在 `create_workspace` execTemplate 中已经 DEFINE 好三条 access（详见 [`workspace-as-database.md`](./workspace-as-database.md) §1）：

| access | TYPE | 给谁用 | DB 引擎能力 |
|---|---|---|---|
| `admin` | JWT (OIDC) | 工作区管理员（`is_admin=true` 的真人） | DDL + DML |
| `participant` | RECORD | 普通成员（`is_admin=false` 的真人） | 仅 DML |
| `employee` | RECORD | **虚拟员工**（`kind='virtual'`） | 仅 DML |

虚拟员工通过 `employee` access SIGNIN，SIGNIN query 同时校验 subject + secret：

```surql
DEFINE ACCESS employee ON DATABASE TYPE RECORD
  SIGNUP NONE
  SIGNIN {
    LET $u = SELECT * FROM user
      WHERE subject = $subject AND kind = 'virtual' AND virtual_profile.status = 'active'
      LIMIT 1;
    IF $u = NONE { THROW "no such employee"; };
    LET $c = SELECT VALUE secret FROM employee_credential WHERE employee = $u.id LIMIT 1;
    IF $c != $secret { THROW "bad secret"; };
    RETURN $u;
  }
  DURATION FOR SESSION 1h;
```

虚拟员工 = `user` 表中 `kind='virtual'` 的一条记录：

```surql
DEFINE FIELD kind ON TABLE user TYPE string
  DEFAULT 'human'
  ASSERT $value INSIDE ['human', 'virtual'];

DEFINE FIELD virtual_profile ON TABLE user TYPE option<object>;
DEFINE FIELD virtual_profile.role           ON TABLE user TYPE option<record<office_role>>;
DEFINE FIELD virtual_profile.supervisor     ON TABLE user TYPE option<record<user>>;
DEFINE FIELD virtual_profile.status         ON TABLE user TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ['active', 'paused', 'retired'];
DEFINE FIELD virtual_profile.last_active_at ON TABLE user TYPE option<datetime>;
```

`signin_secret` 不在 user 表上——它在独立的 `employee_credential` 表（PERMISSIONS NONE，对所有 access 不可见，仅 SIGNIN query 与 root 可读，详见 issue 01）。

**SIGNIN 流程**：

1. 员工**创建时**（issue 03 endpoint），后端生成 secret 并：
   - 写 `employee_credential { employee, secret }`（root 写入，因为该表 PERMISSIONS NONE）。
   - 把 secret 缓存到后端进程内（按 ws_db × employee_id 索引），用于后续 SIGNIN。
2. 后端 dispatcher 决定要拉起员工 X 的执行窗口时，直接从缓存取 secret + 员工 subject。
3. 调 `SIGNIN { ac: 'employee', ns: 'main', db: '<ws db name>', subject: X.subject, secret }`。
   - employee access 的 SIGNIN query 内部 SELECT employee_credential 校验 secret——SIGNIN 是 db 级特权脚本，**可读 PERMISSIONS NONE 的表**（实测验证）。
4. 拿到 1h token 在执行窗口期间写入 office_*；归因 `$auth = X` 由 SurrealDB engine 自动保证。
5. 窗口结束扔掉 token；secret 仍在缓存里，下次复用。
6. 后端进程重启时缓存丢失——重启时遍历 `_system.workspace` 后用 root 重新读取所有 employee_credential 装载缓存。

**后端因此不持有任何长期员工 token**——所有员工 token 都是按需 SIGNIN、按需丢弃。secret 本身是长期的，永不出 SurrealDB（除了进程内缓存）。

### 2. 虚拟办公室的协作四张表（在每个 workspace db 内）

每个 workspace db 在创建时由 execTemplate seed 这四张表。归因字段直接用 `record<user>` 引用本 db 的 user 表，PERMISSIONS 因此天然简单。

| 表 | 含义 | 关键字段 |
|---|---|---|
| `office_task` | 派单与待办 | `assigner`, `assignee`, `goal`, `parent_task?`, `status`, `due_at?`, `result?` |
| `office_message` | 员工 / 真人之间的通信 | `from`, `to?`, `body`, `in_reply_to?`, `mentions[]` |
| `office_report` | 下属对上级的进度汇报 | `from`, `to`, `task?`, `summary`, `next_steps`, `blocked_by?` |
| `user_notification` | 需要真人介入 | `from_employee`, `to_user`, `severity`, `body`, `requested_action`, `resolution?` |

PERMISSIONS 范例：

```surql
DEFINE TABLE office_task SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    -- 同 workspace 任何人可见（已天然满足，因为他们能登录这个 db）
    FOR select WHERE $auth != NONE,
    -- assigner 必须是自己
    FOR create WHERE assigner = $auth,
    -- assignee 推进自己的状态；assigner 撤销 / 改 due；管理员兜底
    FOR update WHERE
      assignee = $auth
      OR assigner = $auth
      OR $auth.is_admin = true,
    FOR delete WHERE $auth.is_admin = true;
```

**office_message** 创建放开 `from = $auth`，让未来真人聊天功能零迁移。

### 3. Office dispatcher：Bun server 进程内、按 workspace 分组维持连接

dispatcher 启动时：

1. 用 root 凭证连 `_system`，SELECT `workspace`，得到所有活跃 workspace 列表。
2. 对每个 workspace：
   - 用 root 凭证 SELECT 该 db 的 active 虚拟员工列表（一次性），缓存内存。
   - 对每个员工 SIGNIN 一次（拿一个 1h token），用该 token 建立一条 LIVE 订阅连接。一个员工一连接，订阅：
     - `LIVE SELECT * FROM office_task WHERE assignee = $auth AND status = 'open'`
     - `LIVE SELECT * FROM office_message WHERE to = $auth`
     - `LIVE SELECT * FROM user_notification WHERE from_employee = $auth AND resolved_at != NONE` （检测 user 已回复）
   - token 临到期时再 SIGNIN 续约（用 secret，不需要 refresh token 概念）。
3. 维护单一全局心跳 `setInterval(60s)`，按 `office_role.heartbeat_interval` 决定本轮拉起哪些员工。
4. LIVE 命中或心跳到点 → 拉起 **执行窗口**：复用该员工的 token，跑一次 Mastra workflow，写入直接走员工自己的会话。

**为什么按员工建连接而不是单条 service 连接**：

- 写入归因走 `$auth`，不能用别人的 token 替写。
- 每员工一条连接是 SurrealDB 推荐用法，连接数与员工数同阶（MVP 数千内可接受）。
- 将来要拆 dispatcher 到独立进程也按员工水平切分。

**为什么不用 Inngest 等 durable engine**：与前一稿同理——SurrealDB 自身是 durable state，重启后 dispatcher 重新枚举 + 重新 SIGNIN + 重新 LIVE 即恢复。Inngest 升级路径作为 §7 备选。

### 4. 岗位仍是数据：`office_role` 表驱动

```surql
DEFINE TABLE office_role SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create, update, delete WHERE $auth.is_admin = true;
DEFINE FIELD key                ON office_role TYPE string;
DEFINE FIELD label              ON office_role TYPE string;
DEFINE FIELD system_prompt      ON office_role TYPE string;
DEFINE FIELD tool_bundle_key    ON office_role TYPE string;
DEFINE FIELD heartbeat_interval ON office_role TYPE duration DEFAULT 5m;
DEFINE FIELD daily_token_budget ON office_role TYPE int DEFAULT 200000;
DEFINE FIELD default_supervisor_role ON office_role TYPE option<string>;
DEFINE INDEX office_role_key_unique ON office_role COLUMNS key UNIQUE;
```

注意：表 PERMISSIONS 中的 `workspace` 字段被取消——本 db 内所有记录都属于本 workspace，不需要再标。

### 5. 与 Router workflow 的关系

并列。Router workflow 由用户在 Web 抽屉发问触发，同步产出。Office dispatcher 由 LIVE + 心跳触发，异步产出落库。

二者共享：

- 同一份 tool bundle registry。
- 同一份 Mastra `WorkflowsStorage`（建议放在 `_system` db 的 `workflow_run` 表，跨 workspace；workspace 字段标归属，PERMISSIONS 限本人/本 workspace 成员）。
- 同一份 `SharedConfirmed` 语义。

二者不共享入口与生命周期，且使用不同的 SurrealDB 会话：

- Router workflow：用真人 OIDC token 直接连用户当前所在 workspace db 执行。
- Dispatcher：用员工 token 连员工所在 workspace db 执行。

### 6. 失败、重启、单例、死循环

- **重启**：Bun server 进程重启后 dispatcher 从 `_system` 重新枚举 workspace + 员工 + SIGNIN + LIVE 订阅；所有未结 task 仍在各自 ws db，下一次事件或心跳就会自然恢复。
- **单实例约束**：MVP 后端**只跑一个实例**（参见 `web-only-pivot.md` §部署）。多副本扩展由后续 issue 处理（在 _system 加一个 dispatcher leader 锁）。
- **进程 crash**：容器 orchestrator 重启即可；中途中断的 workflow run 通过 `WorkflowsStorage` 的 suspend/resume 恢复。
- **死循环**：dispatcher 内置三道闸门：
  - 每窗口步数硬上限
  - 每员工每日 token 预算（计数表 `employee_daily_usage` 在每个 ws db 内）
  - 任务深度（parent_task 链长度）硬上限
- **token 预算**：所有 LLM 调用通过统一 wrapper 计费。

### 7. 升级路径

如果未来出现：

- 多副本后端 → 在 `_system` 加 leader lock 表。
- 复杂 saga / 长 retry → 用 Inngest / Temporal 接管"何时拉起"，dispatcher 内部业务逻辑零修改。

业务表设计（office_*）保持稳定，本 ADR 显式承诺这条升级路径。

### 8. UI 表面（仅契约，不在本 ADR 实现）

- **办公室视图**：workspace 级页面，左花名册 + 中活动流（消息/汇报）+ 右任务看板。
  - 数据来源：**浏览器直接 LIVE SELECT** ws db 的 `user` / `office_message` / `office_report` / `office_task` 表（admin 或 participant access）。**后端不参与**——参见 [`frontend-direct-connect.md`](./frontend-direct-connect.md)。
  - 管理员"重派 / 取消 / 暂停员工"等操作也由浏览器以 admin access 直接 UPDATE。
- **通知抽屉**：合并到 AI 抽屉，作为 inbox tab。浏览器直接 LIVE SELECT `user_notification WHERE to_user = $auth AND resolved_at = NONE`；resolve 也是浏览器 UPDATE。
- **AI 抽屉**：Router workflow 入口，调后端 `/api/chat` + WS `/api/chat/stream`。与办公室视图正交。
- **退休员工 / 改员工 secret 等**：调后端 `/api/internal/employee-retired` 等内部 endpoint（dispatcher 需要同步清缓存 + 关 LIVE 会话），不能让浏览器直接改 `employee_credential`（该表 PERMISSIONS NONE）。

## Consequences

### 正面

- 用户达成"导入数据 + 说目标 → 自动推进 + 出门旅行只看报告"。
- 虚拟员工 7×24 在线，独立于用户设备生命周期。
- **比前几稿都更简单**：
  - 没有 service JWT。
  - 没有 root execTemplate 链路签发员工 JWT——员工 SIGNIN 走 SurrealDB 原生 RECORD access。
  - 跨 workspace 隔离由 db 边界天然保证。
  - PERMISSIONS 不再有 workspace 嵌套子查询。
- 部署：Bun server + 自部署 SurrealDB（同机房内网），运维面清晰。
- 升级路径明确（Inngest / leader 锁），业务表稳定。

### 负面 / 待权衡

- **每员工一条 SurrealDB 连接**：MVP 数千员工内 OK；上万要重新设计。
- **SurrealDB root 凭证**：后端唯一长期凭证；用于 _system 倒查、execTemplate、写 employee_credential、邀请认领等场景。必须严守。
- **employee_credential 缓存**：后端进程内保存所有员工 secret，重启时遍历 _system.workspace 重新装载——属于"启动 N 秒"开销，MVP 可接受。
- **dispatcher 必须跨所有 workspace 的所有员工**：单实例瓶颈。多 workspace + 多员工 + 多 LIVE 订阅在 MVP 后期可能要早做容量测试。
- **审计与归因**：所有写都有正确的 `$auth` 字段，但 `office_message.from = $auth` 这种约束意味着虚拟员工冒名顶替不可能；好处。
- **schema seed 一致性**：所有 ws db 的 office_* schema 必须保持版本一致；schema 升级需要遍历所有 ws db 跑迁移（见 [`workspace-as-database.md`](./workspace-as-database.md) §Negative）。

## Alternatives Considered

### A. 单一 service JWT 代写（前一稿）

抛弃。理由：归因被迫放表字段、长期密钥保管、攻击面大。RECORD access 替代。

### B. 每个虚拟员工独立长期 JWT，本地保管（更早一稿）

抛弃。理由：执行 root 签发链复杂。RECORD access + 每次 SIGNIN 替代。

### C. 把虚拟员工建在 `_system` 全局 user 表

抛弃。违背 [`workspace-as-database.md`](./workspace-as-database.md) §C 的核心原则——用户身份属于其所在 workspace db。

### D. dispatcher 用 Inngest

延后。MVP 单实例 + SurrealDB durable state 已经够；§7 承诺升级路径。

## Open Questions

1. **MVP 岗位最小集合**：单一"通才"岗位先跑通通路，还是直接上"项目经理 + 数据分析师 + 表单专员"三岗？倾向单岗 tracer 先。
2. **用户回执时机**：用户 resolve 一条通知后，后端是立即拉起发起方员工窗口（用员工 token 建 LIVE 已订阅 user_notification 变更，自然命中），还是显式 trigger？倾向 LIVE 自然命中即可。
3. **office_message 写权限**：未来真人聊天功能上线时直接放开 `create WHERE from = $auth`——本 ADR 已经这样写。
4. **多 workspace 的 dispatcher 启动顺序**：MVP 数十 workspace 内串行枚举即可；上百时需要并行 + 进度上报。
