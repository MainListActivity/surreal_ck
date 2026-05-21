# ADR: 弃用本地优先架构，转向单容器 Web 后端

- **Status**: Accepted
- **Date**: 2026-05-16
- **Scope**: 全仓库形态调整。直接影响 `src/main/**`、`schema/main.surql`、`electrobun.config.ts`、`docs/adr/sync.md`、`.scratch/sync-v2/**`
- **Companions**:
  - [`virtual-office.md`](./virtual-office.md)（同期改写为 Web-only 版本）
  - [`workspace-as-database.md`](./workspace-as-database.md)（workspace ↔ database 映射 + 用户身份模型）
  - [`frontend-direct-connect.md`](./frontend-direct-connect.md)（2026-05-17 决定：前端直连 SurrealDB + IdP 接管身份分发）

## Context

仓库原有架构（参见 `CLAUDE.md` 技术栈章节）：

```
Electrobun 1.x (桌面壳)
└── Bun 主进程：surrealdb-node 嵌入 + Mastra + RPC bridge
    └── WebView：Svelte 5 + RevoGrid
```

原始设计动机（来自当时的口头决定，未单独 ADR 记录）：**不愿意维护后端服务，希望把全部能力收敛到"本地 app + 本地嵌入式 SurrealDB"**。

这个动机在 2026-04 之后被两件事情推翻：

1. **同步 v2 不可避免**（[`docs/adr/sync.md`](./sync.md)）：多设备 / 多成员协作要求引入 SurrealDB Cloud 作为权威写侧；本地变成派生状态。"零后端"假设此时已经实质崩溃——同步层（结构影子库 + 投影数据区 + LIVE 重建 + execTemplate）的总复杂度其实**高于**一个直白的后端服务，只是它被切碎散布在客户端。

2. **虚拟办公室方向**（[`virtual-office.md`](./virtual-office.md)）：虚拟员工必须 7×24 在线。任何一个"用户笔记本关上"的设计都不可能兑现"出门旅行只看报告"的产品承诺。这强制要求一个常驻执行体。

继续坚持本地优先架构的后果：

- 同步 v2 主线（仓库当前最重的工作流）必须完成。
- 虚拟办公室必须在桌面端、移动端、Web 端各自重复实现执行模型，或者引入"云端 + 客户端"双形态的额外协调层。
- 客户和合作者需要每个人都装桌面应用并保持运行才能让协作不掉线。

## Decision

**正式弃用"本地 app + 嵌入式 SurrealDB"形态，转向"Web 前端 + 单容器 Bun server + SurrealDB Cloud"**。

### 1. 新拓扑（三角，浏览器分别直连 SurrealDB 与后端）

```
Browser (Svelte 5 + RevoGrid + surrealdb browser SDK)
   │
   ├── OIDC Auth Code + PKCE ───► IdP（外部，只负责登录与 token scope 签发）
   │    登录 hook 从 Bun server 获取默认 workspace scope
   │
   ├── WSS（surrealdb browser SDK）──────► SurrealDB（公网 WSS + TLS）
   │    用 token 中的 https://surrealdb.com/db / ac claims signin
   │    所有读 / 写 / LIVE SELECT 直接走这条连接
   │
   └── HTTPS / WSS ─────────────► Bun server (Hono)
                                   ├─ Workspace Scope Module
                                   │  ├─ GET/POST /api/session/*
                                   │  ├─ POST /api/workspaces（创建 workspace）
                                   │  └─ GET /api/internal/idp/default-scope
                                   ├─ POST /api/chat（Mastra）
                                   ├─ WS  /api/chat/stream
                                   ├─ POST /api/resources/research/save（资源保存 SSE）
                                   ├─ Office dispatcher（进程内，无 endpoint）
                                   └─ root 路径：_system schema、workspace lifecycle、employee_credential
```

- **前端**：浏览器原生，**默认直连 SurrealDB**（详见 [`frontend-direct-connect.md`](./frontend-direct-connect.md)）。读 / 写 / LIVE 订阅 / 管理员 DDL 全部走浏览器内 surrealdb-js。
- **后端（Bun server）**：单容器单副本 MVP。只承载"必须在后端跑"的少数职责：Workspace Scope Module（workspace 列表、切换、创建、IdP default scope hook）、Mastra（LLM key 在后端）、资源保存 SSE（embedding provider key 在后端；用户确认后用调用者 workspace session 写入资源与 embedding）、Office dispatcher（员工 secret 在后端）、root 操作（_system schema 启动 / workspace lifecycle / employee_credential 写入）。**不再有业务数据 CRUD / LIVE 转发代理 endpoint**。
- **数据库**：SurrealDB **自部署或托管，公网 WSS + TLS**（可选 IP 白名单 + WAF）。MVP 接受公网；不再要求与后端同机房内网。
- **IdP**：只负责 OIDC 登录与 token scope 签发。workspace 列表、最近一次 workspace、成员关系和 workspace 创建都由本应用维护；IdP token 中只需要 `https://surrealdb.com/db` 与 `https://surrealdb.com/ac` claims。

### 1.1 身份与权限（详见 [`workspace-as-database.md`](./workspace-as-database.md) + [`frontend-direct-connect.md`](./frontend-direct-connect.md)）

- 用户登录走 OIDC（浏览器内 SPA Auth Code + PKCE，**不经过后端**）。
- 浏览器拿 OIDC token 直接按 `https://surrealdb.com/db` / `https://surrealdb.com/ac` claims `db.signin({ ac, ns, db, token })`。
- 不存在"service JWT"。后端持有的 SurrealDB root 凭证仅用于：启动期 `_system` schema 初始化 + workspace 创建 / 迁移 + 写 `employee_credential`。
- 虚拟员工是 workspace database 内 `user` 表中 `kind='virtual'` 的 record；通过 `DEFINE ACCESS employee ON DATABASE TYPE RECORD` 由 SurrealDB 自身管理。**dispatcher 在后端**每次执行窗口前用 employee secret SIGNIN 一次，拿短期 token 用完即弃。

### 2. 弃用清单

| 组件 | 处置 |
|---|---|
| Electrobun 1.x 桌面壳 | 暂停发版，配置文件 `electrobun.config.ts` 保留但不再 CI 构建 |
| `surrealdb-node` 嵌入式实例 | 移除依赖 |
| `src/main/**` 中所有"本地 DB / 同步 / RPC bridge" | 大部分迁移到 `server/` 目录或弃用 |
| 同步 v2 主线（`.scratch/sync-v2/**`） | 整体 Cancelled，issue 文件保留作为决策史 |
| `docs/adr/sync.md` | 标 Superseded（保留作为历史） |
| Electrobun sidecar 窗口（`.scratch/agentic-ai-product/issues/09`） | 整体 Cancelled |

### 3. 保留 / 复用清单

| 组件 | 处置 |
|---|---|
| `schema/main.surql` 业务表定义 | **整体保留**——直接是 SurrealDB Cloud 的 schema |
| `src/main/ai/mastra/**` (Router workflow + 子 agents + tools) | 整体迁到 `server/ai/mastra/`，运行环境从 Bun-in-Electrobun 变为 Bun-in-container，代码近零修改 |
| `src/renderer/**` (Svelte 5 + RevoGrid 前端) | 整体迁到 `web/`，把"Electrobun RPC"调用替换为"HTTP/WS + SurrealDB SDK 直连"；UI 组件零修改 |
| `src/shared/**` (类型 / DTO) | 保留，前后端共享 |
| 领域语言 `CONTEXT.md` | 保留无变化 |
| `docs/adr/virtual-office.md` | 同期改写为 Web-only 版本 |

### 4. 目录结构调整（具体执行见后续 issue）

```
/
├── web/                  # 前端（Svelte 5）— 由 src/renderer/ 迁入
├── server/               # 后端 Bun 进程 — 由 src/main/ai/、src/main/services/ 等迁入
├── shared/               # 前后端共享类型 — 由 src/shared/ 迁入
├── schema/               # SurrealDB schema — 不动
├── docs/                 # 不动
├── Dockerfile            # 新增：单容器 Bun + 前端静态资源
└── package.json          # pnpm workspaces：web / server / shared
```

### 5. 部署

- **Bun server**：单容器单副本 MVP，部署到任何能跑 Bun 的平台（Fly.io / Railway / Render / 自部署 VPS）。
- **SurrealDB**：自部署或托管均可，**公网 WSS + TLS**；可选 IP 白名单 / Cloudflare WAF。MVP 不要求与后端同机房。
- 开发：docker-compose 起 `server` + `surrealdb` 两服务即可；surrealdb 在本地走 `ws://`。
- 环境变量：
  - 后端：
    - `PORT`（默认 8080）
    - `SURREAL_URL`（如生产 `wss://db.example.com/rpc`）
    - `SURREAL_NS`（默认 `main`）
    - `SURREAL_ROOT_USER` / `SURREAL_ROOT_PASS`（仅 `_system` 写入、workspace lifecycle、employee_credential 写入用）
    - `OIDC_ISSUER` / `OIDC_JWKS_URL` / `OIDC_AUDIENCE`（验 `/api/chat` 等后端 endpoint 的 token）
    - `IDP_SCOPE_API_URL` / `IDP_SCOPE_API_TOKEN`（Workspace Scope Module 调 IdP 更新 token scope）
    - `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 等模型 key
  - 前端：
    - `VITE_SURREAL_URL`（如 `wss://db.example.com/rpc`）
    - `VITE_OIDC_ISSUER` / `VITE_OIDC_CLIENT_ID` / `VITE_OIDC_REDIRECT_URI` / `VITE_OIDC_AUDIENCE`
    - `VITE_API_BASE_URL`（Bun server 的对外地址）

### 6. 桌面端长期定位

- 现阶段**不发**。
- 若未来确有客户需求，用 Tauri 套一个浏览器壳指向同一 Web 域名即可，2 天工作量；**不再回到嵌入式 DB 形态**。

## Consequences

### 正面

- **同步 v2 主线整个砍掉**：仓库当前最重的工作流消失，工程负担显著下降。
- **虚拟办公室落地路径变直**：单一信任域、单一执行者、所有状态在 SurrealDB Cloud。
- **跨设备零门槛**：分享一个 URL，手机 / 平板 / 任意桌面端都能用。
- **运维表面**只剩"一个容器 + 一个 SurrealDB Cloud 账号"，对一人维护友好。
- **客户演示**：URL 直接发出去，无需"先下载安装包"。

### 负面 / 必须正面解决

- **后端服务终于成为现实**：服务发布、监控、密钥轮换、灰度都要做。但比"自造同步层"或"全权代理 endpoint"低风险——后端只剩 Mastra + dispatcher 两件正事。
- **SurrealDB 公网暴露**：是新攻击面。必须开 query timeout / connection limit / rate limit；TLS 证书运维；可选 IP 白名单或 WAF。DEFINE ACCESS + PERMISSIONS 是真正安全边界。
- **IdP 依赖加深**：IdP 不可用 = 用户不能登录 / 不能切 workspace / 不能新建 workspace。MVP 接受单 IdP。
- **SurrealDB root 凭证**：仍是后端唯一长期凭证；用于启动期 _system schema、workspace lifecycle、employee_credential 写入。环境变量注入 + 不写日志 + 文档化轮换。
- **中国法律数据合规**：自部署可控；上线前完成境内部署可行性验证（P1 / pre-launch）。
- **本地优先体验丢失**：离线编辑不再支持。本产品定位下不构成实际损失（用户离线时虚拟员工仍在服务器上工作）。

## Migration plan（高层）

1. **冻结 sync v2 主线**——本 ADR 接受后，`.scratch/sync-v2/**` 不再开工；既有 issue 文件保留以记录决策史。
2. **CONTEXT.md** 更新技术栈描述章节（在仓库根 CLAUDE.md 内）——把"本地嵌入式 SurrealDB"替换为"Web 前端 + 单容器后端 + SurrealDB Cloud"。
3. **`.scratch/virtual-office/` 重排**——去掉本地凭证 / dispatcher 多实例协调相关 issue；详见同期 issue 重排记录。
4. **新立项目录迁移 issue**：分两批，先把 `server/` 跑起来（含现有 Router workflow），再迁 `web/`。
5. **Electrobun 暂停构建**：CI 中关闭 Electrobun 打包步骤；`electrobun.config.ts` 留档但不再维护。

## Alternatives Considered

### A. 保持本地优先 + 同步 v2 + 桌面端虚拟办公室

抛弃。理由：

- 同步层复杂度持续走高；
- 虚拟员工的"7×24"目标与桌面端生命周期冲突；
- 多端 / 多人协作需要额外协调层；
- "不维护后端"的原始动机已被同步 v2 的执行复杂度推翻。

### B. 双形态共存（本地客户端 + 云端协作）

抛弃。理由：维护成本最高（两套执行模型、两套 schema 边界、两套测试矩阵），且没有任何场景**只能**在客户端完成。

### C. 用 Mastra Cloud 作为后端

抛弃。理由：路径锁定深、长期 cron / LIVE 触发能力受限、计费不可控。后端用自部署 Bun + Mastra-as-library，保持出口可控。

### D. Serverless（Cloudflare Workers / Vercel Functions）

抛弃。理由：虚拟员工要求"持续 LIVE 订阅 + cron 心跳"，与 serverless 短请求模型不匹配，要么贵要么 hack。
