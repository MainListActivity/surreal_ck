# ADR: 前端默认直连 SurrealDB，Workspace Scope Module 管理 token scope

- **Status**: Accepted
- **Date**: 2026-05-17
- **Scope**: 全仓库形态。直接影响 `web/`、`server/`、`shared/sql/**`、所有既有 ADR 的"前端不直连"假设
- **Companions / Supersedes-companion**:
  - [`web-only-pivot.md`](./web-only-pivot.md)（同期改写：拓扑改为三角）
  - [`workspace-as-database.md`](./workspace-as-database.md)（同期改写：workspace 权限权威在本应用，IdP 只签 token scope）
  - [`backend-framework-hono.md`](./backend-framework-hono.md)（同期改写：保留 Workspace Scope Module endpoint）
  - [`virtual-office.md`](./virtual-office.md)（同期改写：办公室 UI 直接 LIVE 订阅）

## Context

之前 ADR 群（web-only-pivot / workspace-as-database / backend-framework-hono）默认采用"前端不直连 SurrealDB，一切走 Bun server"的拓扑。该决定的原始动机是"内网部署 + 不暴露公网 + 后端是唯一信任域"。

但累积到现在，"不直连"产生的代价已经超过了它的收益：

1. **后端必须为每张表实现 LIVE 转发**：浏览器要看任何实时数据（消息流、任务看板、单元格更新），后端就多一对长连接 + RunBus + 心跳 + 重连机制。
2. **后端必须为每种业务查询写一个 endpoint 或暴露一个透传层**：否则前端新加一个筛选条件、新做一个统计图都要后端配套发版。
3. **延迟多一跳**：浏览器 → Bun → SurrealDB 多了一段网络 + 一次 JSON 二次序列化；表格类应用对延迟敏感。
4. **架构观念错位**：SurrealDB 本来就是给"浏览器/移动端直连 + DEFINE ACCESS 控权"设计的；不直连等于浪费一半特性。
5. **后端瘦不下来**：业务数据代理 endpoint 全部为"代前端做事"而存在；删掉它们后端才只剩真正需要保密钥或跨 workspace 索引的职责。

同时，身份系统的职责已经收窄：**IdP 不是 workspace 列表或成员关系的权威**。IdP 只负责 OIDC 登录与签发 token，并提供一个很小的 token scope 更新能力。workspace 列表、最近一次登录 workspace、成员关系和 workspace 创建都由本应用维护。

SurrealDB access 读取的 token scope 使用标准 claim：

- `https://surrealdb.com/db`：当前 workspace database 名。
- `https://surrealdb.com/ac`：当前 SurrealDB access 名，MVP 为 `admin` 或 `participant`。

## Decision

**前端默认直连 SurrealDB。后端保留一个深的 Workspace Scope Module，用来管理 workspace 列表、最近选择、workspace 创建和 IdP token scope 更新。**

### 1. 新拓扑（三角形）

```
Browser (Svelte 5 + RevoGrid + surrealdb browser SDK)
   │
   ├─── OIDC Auth Code + PKCE ──► IdP（外部）
   │     ↑ 只负责身份登录与 token 签发
   │     ↑ 登录 hook 调本应用拿默认 token scope
   │     ↑ scope 更新接口只改 token 中 surreal db/ac claims
   │
   ├─── WSS（surrealdb browser SDK）──► SurrealDB（公网 WSS + TLS + 可选 WAF）
   │     ├─ db.signin({ ac, ns: 'main', db, token })
   │     └─ SELECT / LIVE SELECT / INSERT / UPDATE / DELETE
   │
   └─── HTTPS / WSS ─────────────► Bun server (Hono)
                                    ├─ Workspace Scope Module
                                    │   ├─ 列出可进入 workspace
                                    │   ├─ 切换 token scope
                                    │   ├─ 创建 workspace（root 建 db + 应用模板）
                                    │   └─ 登录 hook 默认 scope
                                    ├─ POST /api/chat + WS /api/chat/stream
                                    ├─ POST /api/resources/research/save（SSE 保存进度）
                                    ├─ Office dispatcher（内部，无 endpoint）
                                    └─ root 路径：_system schema、employee_credential、workspace lifecycle
```

### 2. Workspace Scope Module

这是后端少数必须保留的深 Module。它的 Interface 很小，Implementation 集中处理 `_system` 查询、workspace membership 校验、最近一次 workspace 选择、workspace 创建和 IdP scope 更新。

MVP endpoint：

| Path | 用途 |
|---|---|
| `GET /api/session/workspaces` | 登录后列出当前 OIDC subject 可进入的 workspace；数据来自 `_system.user_workspace_index`。 |
| `POST /api/session/switch-workspace` | 输入 workspace slug / db_name；后端验证该 workspace 内有这个真人用户，更新 `last_selected_at`，调用 IdP scope adapter。 |
| `GET /api/internal/idp/default-scope` | IdP 登录 hook 调用；本应用返回该 subject 最近一次 workspace scope，若没有 workspace 则拒绝登录。 |
| `POST /api/workspaces` | 创建 workspace；后端 root 建 db、应用 `shared/sql/workspace-template/`、写 owner user、写 `_system` 索引，再调用 IdP scope adapter 切到新 workspace。 |

这些 endpoint 不是业务数据代理。工作簿、数据表、办公室消息、派单、汇报、通知等业务读写仍然由浏览器直连 SurrealDB，PERMISSIONS 兜底。

### 3. IdP Token Scope Adapter

IdP 的 Interface 收窄为两件事：

1. 登录时通过 hook 从本应用读取默认 scope。
2. 用户切换 workspace 或创建 workspace 后，接受本应用请求更新 token scope。

概念 Interface：

```ts
type SurrealTokenScope = {
  db: string; // maps to claim['https://surrealdb.com/db']
  ac: 'admin' | 'participant'; // maps to claim['https://surrealdb.com/ac']
};

interface IdpTokenScopeAdapter {
  updateUserScope(subject: string, scope: SurrealTokenScope): Promise<void>;
}
```

IdP 不维护 workspace 列表，不决定成员关系，不执行 workspace 创建，也不保存业务状态。

### 4. 登录与切换流程

登录：

```
1. 浏览器跳 IdP（OIDC Auth Code + PKCE）
2. IdP 登录 hook 调本应用 `GET /api/internal/idp/default-scope`
3. 本应用按 subject 查 `_system.user_workspace_index`
   - 优先 last_selected_at 最新的 workspace
   - 没有最近选择则取第一个 active workspace
   - 没有任何 workspace 则返回 login denied
4. IdP 签发 OIDC token，含 `https://surrealdb.com/db` + `https://surrealdb.com/ac`
5. 浏览器回到应用，按 token scope `db.signin`
```

切换 workspace：

```
1. 前端调 `GET /api/session/workspaces` 展示可进入 workspace
2. 用户选择目标 workspace
3. 前端调 `POST /api/session/switch-workspace`
4. 后端验证该 subject 在目标 workspace 中有 user 记录 / index 行，得出 access
5. 后端更新 `_system.user_workspace_index.last_selected_at`
6. 后端用 confidential client 调 IdP Token Scope Adapter，以当前 access token 换取目标 scope 的新 access token
7. 前端保存后端返回的新 access token
8. 前端关闭旧 SurrealDB 连接，按新 token scope 重新 signin
```

### 5. Workspace 创建路径

浏览器不再持有 NS-admin token，也不直接执行 `DEFINE DATABASE`。

```
1. 前端调 `POST /api/workspaces { name, slug }`
2. 后端验证当前 OIDC subject 有创建 workspace 权限
3. 后端 root 生成 db_name = ws_<id12>，创建 database
4. 后端应用 `shared/sql/workspace-template/` 模板
5. 后端创建 owner user（human, is_admin=true）
6. 后端写 `_system.workspace` + `_system.user_workspace_index`
7. 后端调用 IdP Token Scope Adapter，返回带新 workspace admin access 的 access token
8. 前端保存新 access token，直连新 workspace database
```

创建失败由后端在同一个 lifecycle Module 内补偿：模板失败则删除刚创建的 db；IdP scope 更新失败则保留 workspace 但返回明确错误，前端可重试切换。

### 6. 后端的"瘦身"清单

**删除 / 不再新增**：

- 业务数据 CRUD 代理 endpoint（工作簿、数据表、记录、办公室消息、派单、汇报、通知等）。
- SurrealDB LIVE 转发 endpoint。
- 浏览器 NS-admin token 与前端建库流程。
- service JWT / 代写模式。

**保留**：

- Workspace Scope Module：session workspaces、switch workspace、workspace create、成员管理（add / remove / role 变更）、员工 lifecycle（create / retire）、IdP default-scope hook。
  - 成员管理与员工 lifecycle 都需要"原子同写 `_system` 与目标 ws db"，因此归在同一个深 Module，不是业务数据代理。
  - 员工 `employee_credential` 写入只能由 root 完成（PERMISSIONS NONE），dispatcher 缓存随 lifecycle endpoint 同步刷新。
- `POST /api/chat` + `WS /api/chat/stream`：LLM key 必须在后端。
- `POST /api/resources/research/save`：资源检索人工补库的用户确认保存动作，返回 SSE 进度。它是窄动作 endpoint，因为 embedding provider key 在后端；写资源与 embedding 时仍使用调用者 workspace session，不提供通用业务 CRUD、embedding enqueue 或 retry/reindex。
- Office dispatcher：进程内服务，用员工 secret SIGNIN。
- root 维护路径：`_system` schema、workspace lifecycle、`employee_credential` 写入、dispatcher 启动遍历。

### 7. SurrealDB 网络暴露

- 部署形态：SurrealDB 公网 WSS + TLS（自部署或托管均可）。
- 可选加固：Cloudflare / WAF / IP 策略 / query timeout / connection limit / rate limit。
- DEFINE ACCESS + PERMISSIONS 是业务数据安全边界；Workspace Scope Module 是 token scope 与 workspace lifecycle 的安全边界。

### 8. 虚拟办公室

dispatcher 仍在 Bun server 进程内，用 root 读 `employee_credential` → SIGNIN `employee` access → 用员工身份写 office_*。

前端办公室视图（花名册 / 活动流 / 任务看板）直接 SurrealDB LIVE SELECT。后端不做 LIVE 转发。

## Consequences

### 正面

- **业务数据路径短**：表格读写 / LIVE 直连 SurrealDB，少一跳。
- **后端 Module 更深**：Workspace Scope Module 把 token scope、最近 workspace、workspace lifecycle 集中起来，Interface 小，Locality 高。
- **IdP Interface 很窄**：只处理 token scope，不再把 workspace 权威外包给 IdP。
- **workspace 创建原子性更好**：root 建库、模板、_system 索引、IdP scope 更新集中在后端 lifecycle 中。
- **浏览器不持 NS-admin 能力**：降低误操作和 XSS 后果。

### 负面 / 必须正面解决

- **SurrealDB 公网暴露**：必须配置 query timeout、connection limit、rate limit、TLS 和 WAF。
- **后端仍保留少量 session/workspace endpoint**：但这些是 token scope / lifecycle endpoint，不是业务数据代理。
- **IdP scope 更新失败会影响切换体验**：需要重试与清晰错误。
- **`_system.user_workspace_index` 成为应用权威索引**：成员变更路径必须同步维护它，否则登录 hook 和 workspace 列表会漂移。
- **浏览器持有 SurrealDB token**：必须落实 CSP、markdown sanitize、第三方脚本约束和短 token duration。

## Alternatives Considered

### A. 完全不直连

抛弃。后端业务代理和 LIVE 转发复杂度高，且浪费 SurrealDB access / PERMISSIONS 能力。

### B. IdP 维护 workspace 列表与成员关系

抛弃。workspace lifecycle 与成员关系是本产品业务逻辑；交给 IdP 会让业务 Module 变浅，且每个功能都被 IdP 选型牵制。

### C. 浏览器拿 NS-admin token 创建 workspace

抛弃。它能减少一个后端 endpoint，但把跨 db DDL 能力暴露给浏览器，且失败补偿分散在前端、IdP、后端三处。

### D. 混合：读 / LIVE 直连，写走后端

抛弃。两条业务数据路径让开发者每次都要判断"这个操作该走哪边"。本 ADR 只把 token scope / workspace lifecycle 留在后端，业务数据读写统一直连。

## Open Questions

1. **IdP scope adapter 具体协议**：IdP 已选定 `o.maplayer.top/t/ck`（见 [`../oidc.md`](../oidc.md)），它提供专门的 scope 更新 API。具体 endpoint URL、管理 token、请求 / 返回 body、失败码待簇 C issue 03 实测回填。
2. **登录 hook 鉴权**：`GET /api/internal/idp/default-scope` 由 `o.maplayer.top/t/ck` 的登录流程回调；鉴权方式（HMAC / 专用 bearer token）待簇 C issue 03 按 IdP 实际能力回填。
3. ~~**成员管理路径**：管理员新增 / 删除成员时，如何同时写 workspace `user` 表与 `_system.user_workspace_index`，需要单独 issue 固化。~~ **已决定**（2026-05-18）：归 Workspace Scope Module（见 §6 保留清单），后端 root 原子同写两边。前端不直接写 ws db `user` 表的 human 行；浏览器若以 admin 直接 INSERT user，reconciler 会在下一轮校对中拉回 `_system.user_workspace_index`，但**不是**推荐路径。
4. **创建 workspace 权限**：用应用内 entitlement 还是 IdP claim（如 `can_create_workspace`）作为 UI 显示和后端校验依据，待产品策略定。

## P1 待补 ADR（公网形态遗留盲区，不阻塞簇 C / D，部署或扩容前必须补）

这几个盲区在 2026-05-20 评审中识别，决定推迟到 P1：

1. **SurrealDB 网络加固**（`surrealdb-network-hardening.md`）：公网 WSS 暴露后的 nginx / Cloudflare 前置、token DURATION 上限、admin token 短窗口（防 XSS 后任意 DDL）、LIVE 并发上限、CSP / markdown sanitize。**上线前必须有。**
2. **Schema 迁移多 workspace 策略**（`schema-migration-strategy.md`）：启动期遍历 N 个 ws db 跑迁移的串行 / 跳过失败 / 异步重试策略，`status='provisioning'` 期间的访问处理，失败留痕（`_system.workspace.last_migration_error`）。**workspace 数量上规模前必须有。**
3. **单实例 dispatcher 容量边界**（`single-instance-budget.md`）：MVP 单容器 dispatcher 的 workspace × employee × LIVE 连接容量上限、启动时序、中断恢复语义、何时该上 leader lock。**员工数上规模前必须有。**
