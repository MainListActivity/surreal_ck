# ADR: 弃用本地优先架构，转向单容器 Web 后端

- **Status**: Accepted
- **Date**: 2026-05-16
- **Scope**: 全仓库形态调整。直接影响 `src/main/**`、`schema/main.surql`、`electrobun.config.ts`、`docs/adr/sync.md`、`.scratch/sync-v2/**`
- **Companions**:
  - [`virtual-office.md`](./virtual-office.md)（同期改写为 Web-only 版本）
  - [`workspace-as-database.md`](./workspace-as-database.md)（workspace ↔ database 映射 + 用户身份模型）

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

### 1. 新拓扑

```
Browser (Svelte 5 + RevoGrid)        ← 公网
   │
   │ HTTP / WS  (业务 API + LIVE 转发)
   ▼
Bun server                            ← 内网
   │
   │ 内网地址 + 用户 OIDC JWT 透传
   ▼
SurrealDB                             ← 内网（与 Bun server 同机房）
```

- **前端**：浏览器原生，**不直连 SurrealDB**——SurrealDB 不暴露公网。所有数据交互（读、写、LIVE 订阅）都通过 Bun server 中转。
- **后端**：单 Bun 进程（单容器 / 单副本 MVP），承载 Router workflow、Office dispatcher、虚拟员工执行、HTTP API、WS LIVE 转发。后端不持有数据库；通过内网用户名/密码（root，仅 execTemplate 用）+ 用户透传 JWT 访问 SurrealDB。
- **数据库**：SurrealDB（自部署，与 Bun server 同机房内网），唯一权威。

### 1.1 身份与权限（详见 [`workspace-as-database.md`](./workspace-as-database.md)）

- 用户登录走 OIDC，浏览器拿到 JWT 后只发给 Bun server。
- Bun server 以"用户透传"方式连 SurrealDB——每个 workspace 是独立 database，用户的 JWT 直接是该 db 的合法 user（`DEFINE ACCESS member ON DATABASE TYPE JWT URL <jwks>`）。
- 不存在"service JWT"。后端唯一持有的长期凭证是 SurrealDB root 凭证（环境变量），仅在 execTemplate 创建新 workspace database 时使用。
- 虚拟员工是 workspace database 内 `user` 表中 `kind='virtual'` 的 record；通过 `DEFINE ACCESS employee ON DATABASE TYPE RECORD` 由 SurrealDB 自身管理。后端每次执行窗口前 SIGNIN 一次，拿短期 token 用完即弃。

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

- 同一机房内两个容器：**Bun server** + **SurrealDB**（自部署），走内网通信，SurrealDB 不暴露公网。
- 也可同 docker-compose 单机起 MVP；线上分两台。
- MVP 后端 `replicas=1, concurrency=1`。
- 环境变量：
  - `SURREAL_URL`（内网地址）
  - `SURREAL_NS`（默认 `main`）
  - `SURREAL_ROOT_USER` / `SURREAL_ROOT_PASS`（仅 execTemplate 用，不参与日常请求）
  - `OIDC_ISSUER` / `OIDC_JWKS_URL`
  - `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 等

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

- **后端服务终于成为现实**：服务发布、监控、密钥轮换、灰度都要做。但这些是已知熟练领域，比"自造同步层"低风险。
- **SurrealDB 自部署 + 同机房内网**：消除了"前端直连 SurrealDB Cloud"的公网攻击面，但引入了"自己运维一台 SurrealDB"的运维项；备份、升级、故障恢复需要文档化。
- **SurrealDB root 凭证**：是后端唯一长期凭证，仅 execTemplate 用。环境变量注入 + 不写日志 + 文档化轮换流程；详见 [`workspace-as-database.md`](./workspace-as-database.md) §4。
- **中国法律数据合规**：自部署后境内合规问题缓解。仍需在国内法律实体下完成数据本地化部署的工程项；从"上 SurrealDB Cloud"假设下的 launch-blocker 降回 P1 / pre-launch。
- **本地优先体验丢失**：离线编辑不再支持。本产品定位下不构成实际损失（用户离线时虚拟员工仍在内网服务器上工作）。

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
