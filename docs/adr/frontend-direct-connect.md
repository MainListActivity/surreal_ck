# ADR: 前端默认直连 SurrealDB，IdP 接管身份与 workspace 分发

- **Status**: Accepted
- **Date**: 2026-05-17
- **Scope**: 全仓库形态。直接影响 `web/`、`server/`、`schema/`、所有既有 ADR 的"前端不直连"假设
- **Companions / Supersedes-companion**:
  - [`web-only-pivot.md`](./web-only-pivot.md)（同期改写：拓扑改为三角）
  - [`workspace-as-database.md`](./workspace-as-database.md)（同期改写：身份在 IdP token claim 里、execTemplate 删除、user_workspace_index 变 IdP 同步缓存）
  - [`backend-framework-hono.md`](./backend-framework-hono.md)（同期改写：后端职责瘦身）
  - [`virtual-office.md`](./virtual-office.md)（同期改写：办公室 UI 直接 LIVE 订阅）

## Context

之前 ADR 群（web-only-pivot / workspace-as-database / backend-framework-hono）默认采用"前端不直连 SurrealDB，一切走 Bun server"的拓扑。该决定的原始动机是"内网部署 + 不暴露公网 + 后端是唯一信任域"。

但累积到现在，"不直连"产生的代价已经超过了它的收益：

1. **后端必须为每张表实现 LIVE 转发**——浏览器要看任何实时数据（消息流、任务看板、单元格更新），后端就多一对长连接 + RunBus + 心跳 + 重连机制。
2. **后端必须为每种业务查询写一个 endpoint 或暴露一个透传层**——否则前端新加一个筛选条件、新做一个统计图都要后端配套发版。这是最大的隐性成本。
3. **延迟多一跳**：浏览器 → Bun → SurrealDB 多了一段网络 + 一次 JSON 二次序列化；表格类应用对延迟敏感。
4. **架构观念错位**：SurrealDB 本来就是给"浏览器/移动端直连 + DEFINE ACCESS 控权"设计的；不直连等于浪费一半特性。
5. **后端瘦不下来**：sessions / members / workspaces / LIVE 转发等大量 endpoint 全部为"代前端做事"而存在；删掉它们后端只剩 Mastra + dispatcher 两件正事。

实测验证已确认（2026-05-17）：

- SurrealDB JWT access 用户能跨 db 执行 `DEFINE DATABASE`；定义在 namespace 级 access 即可让管理员直接建 workspace。
- RECORD access 用户被引擎硬拒任何 DDL；DML 受 PERMISSIONS 约束。
- SIGNIN query 内部可读 PERMISSIONS NONE 表（用于 employee_credential 校验）。

并行地，**身份系统决定走 IdP 接管**：用户登录 IdP 时选择当前 workspace、IdP 颁发的 OIDC token 中带 `current_db` / `role` claim；切换 workspace = 调 IdP 重发 token；workspace 列表的权威源在 IdP，本仓库 `_system.user_workspace_index` 退化为"IdP 同步过来的缓存 / 兜底"。**IdP 的具体接口形态（切换 endpoint、推送通道、claim schema）当前未定**，本 ADR 把这些列为 Open Questions，但不堵塞文档同步。

## Decision

**前端默认直连 SurrealDB。后端仅承载"必须在后端跑"的少数职责。IdP 是身份与 workspace 分发的权威。**

### 1. 新拓扑（三角形）

```
Browser (Svelte 5 + RevoGrid + surrealdb-js)
   │
   ├─── OIDC Auth Code + PKCE ──► IdP（外部）
   │     ↑ 颁发 OIDC token，含 current_db / role claim
   │     ↑ 维护 "用户能进哪些 workspace" 权威
   │     ↑ 暴露"切换 workspace"endpoint（待定）
   │
   ├─── WSS（surrealdb-js）──────► SurrealDB（公网 WSS + TLS + 可选 IP 白名单）
   │     ├─ db.signin({ ac: 'admin', ns: 'main', token })            ← NS 级 admin access：能 DEFINE DATABASE
   │     ├─ db.signin({ ac: 'admin', ns: 'main', db: ws_xxx, token }) ← db 级 admin：能 DDL + DML
   │     ├─ db.signin({ ac: 'participant', ns: 'main', db: ws_xxx, token }) ← 普通成员：DML
   │     └─ SELECT / LIVE SELECT / INSERT / UPDATE / DELETE          ← PERMISSIONS 把关
   │
   └─── HTTPS / WSS ──────────────► Bun server (Hono)（同机房或公网均可）
                                    ├─ POST /api/chat                  ← Mastra Router workflow（LLM key 必须在后端）
                                    ├─ WS  /api/chat/stream            ← workflow 流式进度
                                    ├─ Office dispatcher（内部，无 endpoint） ← 跑虚拟员工，用员工 secret SIGNIN
                                    ├─ root 路径（极少）：建 _system schema、写 employee_credential、IdP 同步钩子
                                    └─ 不再有 sessions / members / workspaces / LIVE 转发 endpoint
```

### 2. 三种身份的连接路径

| 身份 | 浏览器 SIGNIN 走的 access | 后端介入？ |
|---|---|---|
| **NS-admin**（新增）| `admin` ON NAMESPACE（TYPE JWT） | 否——浏览器直接拿 IdP token signin |
| **工作区管理员** | `admin` ON DATABASE（TYPE JWT） | 否 |
| **普通成员** | `participant` ON DATABASE（TYPE RECORD WITH JWT） | 否 |
| **虚拟员工** | `employee` ON DATABASE（TYPE RECORD） | **是**——dispatcher 在后端持员工 secret SIGNIN |

### 3. NS 级 admin access（新增）

```surql
DEFINE ACCESS admin ON NAMESPACE TYPE JWT URL <oidc-jwks>
  AUTHENTICATE {
    -- 仅校验 token 合法 + claim 中标记 ns-admin
    IF $token.ns_admin != true { THROW "not a namespace admin"; };
    RETURN $token.sub;
  };
```

让 IdP 在 token 中标记"该真人是否有 NS 级管理能力"（譬如"能创建新 workspace"）。NS-admin 才能 `DEFINE DATABASE ws_xxx`。

普通真人（只是 ws db 内的 admin / participant）拿到的 token 不带 `ns_admin: true` claim → 进不到 NS 级 access → 无法跨 db 操作。

### 4. workspace 创建路径

```
1. 浏览器调 IdP "create workspace"endpoint（IdP 自家流程，含 slug 校验 / 唯一性 / 计费等）
2. IdP 内部：决定 db_name = ws_<nanoid12>，给该用户颁发新 token：
     { sub, current_db: ws_<id>, role: 'admin', ns_admin: true（仅此一次） }
3. 浏览器拿新 token：
     a. db.signin({ ac: 'admin', ns: 'main', token })       ← NS 级登录
     b. DEFINE DATABASE ws_<id>;
     c. USE DB ws_<id>;
     d. DEFINE ACCESS admin ... ; DEFINE ACCESS participant ... ; DEFINE ACCESS employee ... ;
     e. seed 业务表 schema（user / office_role / employee_credential / 其它）；
     f. INSERT user CONTENT { email, subject, kind: 'human', is_admin: true, ... };
4. 浏览器调后端 webhook `POST /api/internal/workspace-created`（或 IdP 直接通知后端）
   → 后端用 root 写一行 _system.workspace + _system.user_workspace_index 作为缓存 / dispatcher 索引
5. 后续操作（添加成员、加字段等）浏览器以 db 级 admin access 直接做
```

**workspace 模板 SQL 文件 `shared/sql/workspace-template/*.surql` 由前端 bundle 进自己代码**——它就是浏览器要执行的 DDL 序列。后端不再独占。

### 5. 后端的"瘦身"清单

**删除**：

- `/api/sessions/*`（IdP 接管）
- `/api/workspaces/*` 全部 CRUD（浏览器直 SurrealDB DDL；workspace 创建走 IdP + 前端 DDL）
- `/api/workspaces/:slug/members/*`（管理员浏览器内直接 INSERT/UPDATE/DELETE user 表）
- `/api/.../office/state` 与 `/api/.../office/stream` LIVE 转发（浏览器直接 LIVE SELECT）
- `WorkflowsStorage` 的"按 workspace 隔离查询"逻辑（仍保留 storage，但 reconciler 不再依赖 _system）

**保留**：

- `POST /api/chat` + `WS /api/chat/stream`——LLM key 必须在后端
- Office dispatcher（进程内服务，无 HTTP endpoint；用员工 secret SIGNIN）
- `_system` 极小：仅 `workspace` 索引（IdP 同步过来）+ `user_workspace_index` 缓存（同上）
- root 凭证用于：启动 _system schema、写 employee_credential、接收 IdP 同步钩子

### 6. SurrealDB 网络暴露

- 部署形态：**SurrealDB 公网 WSS + TLS**（自部署或托管均可；不再要求"内网"）。
- 可选加固：IP 白名单（来自 IdP 或前端域）、Cloudflare 等 WAF / DDoS。
- DEFINE ACCESS + PERMISSIONS 是真正的安全边界，**不能假设任何代码层兜底**。
- SurrealDB 进程自身的 query timeout / connection limit / rate limit 必须配置。

### 7. PERMISSIONS 与 AUTHENTICATE 的化简

因为身份信息（is_admin、当前 db、role）都在 IdP 颁发的 token claim 里：

- ws db 内 `admin` / `participant` access 的 AUTHENTICATE 可以简化为"读 claim 即可"，不再需要"按 subject / email 查 user 表 + 回填"。
- user 表仍存在（保留人类可读的 display_name / avatar / last_seen_at 等），但**不再作为登录 gating 表**——IdP 决定谁能登录。
- AUTHENTICATE 内仍 UPDATE user.last_seen_at 一下（首次进来时若 user 行不存在则按 claim CREATE 一行）。

### 8. 虚拟办公室

保持原 ADR §1 模型：dispatcher 仍在 Bun server 进程内，用 root 读 employee_credential → SIGNIN employee access → 用员工身份写 office_*。

前端办公室视图（花名册 / 活动流 / 任务看板）**改为直接 SurrealDB LIVE SELECT**——浏览器以 admin 或 participant access 订阅 user / office_message / office_task / office_report / user_notification。后端不再有 LIVE 转发 endpoint。

## Consequences

### 正面

- **后端大幅瘦身**：从"全权代理"变成"Mastra + dispatcher 两件正事"，运维表面急剧缩小。
- **延迟降低**：表格类操作浏览器直达 SurrealDB，少一跳。
- **新业务查询零后端发版**：前端写 surql 即可（PERMISSIONS 由 DB 引擎兜底）。
- **同步 / 倒查复杂度急剧下降**：IdP 是 workspace 列表权威，后端 _system 只是缓存。
- **架构观念回归 SurrealDB 设计意图**：access + PERMISSIONS 作为唯一信任边界。
- **DDL 自服务真正兑现**：管理员浏览器内直接 DEFINE TABLE / DEFINE FIELD。

### 负面 / 必须正面解决

- **SurrealDB 公网暴露**：是新攻击面。必须配置 query timeout、connection limit、rate limit；TLS 证书运维；DDoS 防护。
- **IdP 依赖加深**：IdP 不可用 = 用户不能登录 / 不能切 workspace / 不能新建 workspace。MVP 接受单 IdP；高可用方案后置。
- **IdP ↔ 后端同步通道未定**：workspace 创建 / 成员变更后，后端 _system 的更新协议（webhook / polling / push）当前是 Open Question。
- **IdP token claim schema 锁死了"用户切换 workspace 必须重发 token"**：DURATION 内切换不及时；MVP 接受短 DURATION（如 1h）。
- **浏览器持有 surreal token**：放 sessionStorage 接受 XSS 风险；同源 + 自部署威胁面较小，但要避免在 web 内引入未审计的第三方脚本。
- **前端 bundle 增加 workspace 模板 SQL**：约几 KB，可接受。
- **前端代码可访问 surql 直写权限**：恶意脚本 / 调试控制台可以发任意 surql，但都受 PERMISSIONS 约束——这与"前端能调任意 REST endpoint 但 endpoint 有鉴权"是同等威胁模型。

## Alternatives Considered

### A. 完全不直连（前一稿）

抛弃。理由见 Context；累积成本 > 收益。

### B. 混合：读 / LIVE 直连，写走后端

抛弃。引入"两条数据路径"的复杂度：前端开发者每次都要判断"这个操作该走哪边"；token 也要管两套（admin/participant for 直连读 + 某种 cookie/session for 写 endpoint）。比"全直连"或"全代理"都更复杂。

### C. 混合：只把 LIVE 直连，其它走后端

抛弃。理由相似——只是减轻了一部分代价，没消除"后端为每张表写 endpoint"的根本问题。

### D. 后端代理但用 GraphQL / surql 透传

抛弃。变相把后端做成了"假 SurrealDB"，等于自己做了一遍引擎工作。

## Open Questions

1. **IdP 与后端的同步通道**：workspace 创建 / 成员变更 / role 改动后，后端 `_system` 如何同步？候选：(a) IdP webhook 推后端；(b) 后端定时 polling IdP；(c) 浏览器代发通知。倾向 (a)，需要选定 IdP 后定。
2. **IdP token claim schema**：当前假设 `{ sub, email, current_db, role, ns_admin?, available_dbs? }`。`available_dbs` 是否需要每次塞 token？倾向"不塞，前端走 IdP query endpoint 拉列表"。
3. **切换 workspace 的 IdP endpoint 形态**：silent refresh + 新 claim？还是 full re-authenticate？倾向前者。
4. **workspace 创建：IdP 先还是 SurrealDB 先**：本 ADR 选择"IdP 先决定 db_name 并签 token → 浏览器到 SurrealDB 建 db"。反向（浏览器先建 db 再注册到 IdP）会留下"建了 db 但 IdP 不认"的悬空态。
5. **NS-admin 何时给**：是"创建账号即给"还是"仅创建 workspace 那一刻临时给"？倾向后者——降低误操作面。
6. **IdP 选型**：自部署 Keycloak / Authentik / 商用 IdP，待定。决定后回填全部 access 的 JWKS URL。
7. **dispatcher 单实例瓶颈**：本 ADR 不改动；仍由 virtual-office ADR §7 覆盖。
