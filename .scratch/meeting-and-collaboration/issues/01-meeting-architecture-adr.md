Status: ready-for-human

# 01 · 全场景会议架构与外部参会安全 ADR

**目标**：在 `docs/adr/` 新增正式架构决策记录，锁定日常办公会议与受控外部正式会议的媒体拓扑、跨端互通协议、外部免下载/免注册安全边界与隐私红线，作为后续 `04`–`10` 实施工单的唯一权威约束。

## 范围与设计决策项

1. **双模式与媒体平面分层**：明确 2–6 人日常小会（P2P + 托管短期 TURN）与 6+ 人/外部正式大会（自托管私有 SFU，选型 LiveKit 或 mediasoup，部署在受控私有主机）的切换条件、单机容量基线与资源边界。
2. **外部人员零注册/零数据库凭证边界**：定义两类外部主体——日常访客（限时访客链接 + 等候室放行）与名册主体（个人专属令牌 + 访问码，复用 `claims-portal` 服务端受控会话模式）；明确其均不拥有工作区 `user` 记录、不持 SurrealDB token、无法读取成员目录或其他工作簿。
3. **跨端信令与会话模型**：统一原生协同 APP（macOS/Windows/Android）与 Web 浏览器端的房间状态、信令交换、设备隐私状态机与强制断连语义，兼容现有 `069-native-meeting.surql` 升级路径。
4. **客户端与浏览器兼容边界**：明确桌面/手机浏览器免下载直入矩阵、微信/钉钉内置 WebView 的跳转系统浏览器引导、无摄像头/麦克风降级（纯听/纯音频）。
5. **双模式录制与司法存证红线**：明确日常办公会议默认不录制（可手动开启并全员红标告知），正式外部会议默认启用「全程存证模式」（入场知情勾选确认 + 全端常驻红标）；采用私有 SFU 轻量轨道直录（Track Egress，不与业务库争抢实时转码 CPU）+ 异步合成带服务端 UTC 水印的视频/混音及分轨音频 + 只追加举手表决账本 + 独立私有对象存储信封加密归档 + 根哈希《会议存证清单》（预留 32 字节摘要对接 TSA 可信时间戳）；明确说明服务端存证录制与浏览器端到端加密（E2EE）的互斥取舍；明确通用平台层禁止出现法律硬编码词汇。

## 非目标

- 本任务不编写业务代码、不修改数据库迁移、不部署 SFU 服务器。

## 独立验收标准

- [x] 在 `docs/adr/` 落盘完整 ADR 文档并在 `CONTEXT.md` 补充关键领域术语（日常会议、外部访客会话、受控外部会议、名册参会主体、等候室、私有 SFU 媒体平面）。
- [x] ADR 明确列出两类外部参会者（日常访客 vs 名册主体）的认证链路、令牌生命周期、单活互踢/吊销机制、枚举防护与限速常量。
- [x] ADR 明确说明私有 SFU 选型依据、部署位置（遵循单一控制面与最小服务面原则）、带宽/并发上限估算与回退方案。
- [x] ADR 明确列出现有 `069-native-meeting.surql` 的兼容与增量迁移策略，且经审查确认不包含任何法律/破产硬编码模型名。
- [ ] 经独立复核（产品 + 工程/安全视角）确认无权责模糊或与 `frontend-direct-connect` / `workspace-as-database` ADR 冲突。

**依赖**：无（可立即开工）。  
**验证方式**：文档契约审查 + 领域术语一致性核对（对照 `CONTEXT.md` 与 `docs/adr/`）。

## Comments

- [架构与存证 ADR](../../../docs/adr/meeting-architecture-and-evidence.md)已起草并核对现有会议 schema、成员直连及工作区隔离契约。独立产品与工程/安全复核尚未完成，不记为 `done`。

### 2026-11-28 独立工程与安全复核

在主干 `3fd77731` 上按仓库约定与工单验收标准独立复核，修订了 [会议 ADR](../../../docs/adr/meeting-architecture-and-evidence.md)。

| 核对项 | 结论与依据 |
| --- | --- |
| 权责与直连 | Bun 负责准入和会控，私有 LiveKit 执行媒体权限，TURN 负责中继。普通工作簿读写、LIVE 和管理员 DDL 沿用 [前端直连](../../../docs/adr/frontend-direct-connect.md)、[workspace database](../../../docs/adr/workspace-as-database.md) 的边界。日常 V2 使用 [origin 专用 RECORD](../../../server/src/routes/meeting-v2-store.ts)。复核发现名册业务使用 root、管理入口缺少当前资格复核两处偏差。闭环证据见下节。 |
| 外部身份 | 日常访客经限时链接和等候室，名册主体经个人令牌、访问码和单活租约。两个公开入口只授予同场权限，均不创建 `user` 或发放数据库凭证。等候态无媒体与成员目录权限。核对了 [V2 入口](../../../server/src/routes/meeting-v2.ts)、[名册入口](../../../server/src/routes/meeting-roster.ts)和 [SFU 控制面](../../../server/src/routes/meeting-sfu.ts)。 |
| 升级、互通与术语 | [069](../../../shared/sql/workspace-template/069-native-meeting.surql) 保留成员信令。[070](../../../shared/sql/workspace-template/070-meeting-v2.surql) 增加日常 V2，[071](../../../shared/sql/workspace-template/071-roster-meeting.surql)、[072](../../../shared/sql/workspace-template/072-roster-meeting-records.surql) 增加名册及账本，[073](../../../shared/sql/workspace-template/073-meeting-evidence-projection.surql) 增加归档投影。查验 [CONTEXT](../../../CONTEXT.md)、上述迁移、会议服务、Web 和原生会议入口，未发现平台会议模型或流程的行业硬编码。ADR 已同步四席 Mesh、独立 SFU、HTTPS 快照轮询、协办人权限和首期 Web 名册范围。 |
| 存证与 E2EE | 服务端轨道录制需要媒体平面读取轨道。录制模式使用传输加密和封存加密，与 E2EE 互斥。[SFU](../../../server/src/meeting/sfu.ts)、[Track Egress](../../../server/src/meeting/evidence-recording.ts)和[归档](../../../server/src/meeting/evidence-archive.ts)的现状已写入 ADR。录制告知闭环、暂存加密和独立不可变留存仍需验收。工作区 Owner 可经 DDL 改动工作区投影，独立存证域负责可信根核验。 |

### 2026-11-28 M-01 工程偏差闭环

- [x] 074 自动升级已部署工作区，网关凭据、数据与权限按 workspace database 隔离。管理员以本人数据库会话创建会议和绑定表，受限 RECORD 执行名册核验、单活租约、表决/签到回写及存证投影。真实 fork 验证重复执行、跨库、DDL、无关表读写、绑定越界、配额原子回滚以及账本和投影改删负例。[074 迁移](../../../shared/sql/workspace-template/074-roster-meeting-gateway.surql) · [集成测试](../../../server/src/meeting/roster.integration.test.ts)
- [x] 名册管理逐请求复核两个数据库中的当前成员和管理员身份，并校验现行配额与服务模式。真实签名、未过期的旧 JWT 在工作区用户或成员索引降权或移除后均收到 403。实测账本失信和保留模式拒绝、宽限模式可用，以及公开入口缺失、伪造或重放挑战时拒绝发放会话。[ADR §6](../../../docs/adr/meeting-architecture-and-evidence.md#6-现行实现与上线条件) · [集成测试](../../../server/src/meeting/roster.integration.test.ts)

联测使用 `~/.surrealdb/surreal` 的公司 fork `4.0.1-native-quota.1`，制品 SHA-256 为 `a7e26e79edf7fa44a8ee437882c700a77bf9076bd16bd90987c9f00552569a4c`。使用回环网络和合成数据。媒体夹具为 LiveKit 1.9.9 与 Track Egress 1.15.0，覆盖真实会控、重新入会、表决异议、加密封存、离线校验及篡改检出。Turnstile 联测使用 Siteverify 测试替身验证 action、hostname 和重放限制。

| 验证范围 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| 服务端会议、公开入口、工作簿模板契约 | 49 | 0 | 0 |
| 服务端工作区鉴权、调用者会话、迁移执行器与相关路由 | 87 | 0 | 0 |
| 真实 fork 工作区创建 | 5 | 0 | 0 |
| Web 会议 | 49 | 0 | 0 |
| 共享工作区模板和模板包 | 61 | 0 | 0 |

`pnpm lint` 零错误、零警告。`pnpm typecheck` 通过，Svelte 报告既有 12 条警告。会议套件首轮有一项既有 LiveKit 信令用例收到 503，完整重跑时 49 项均通过。

联合验收保留 `ready-for-human`。录制和协议上线条件见 ADR §6。待产品负责人确认日常录制启用条件、正式会议告知及留存策略，以及原生名册入口的上线范围。
