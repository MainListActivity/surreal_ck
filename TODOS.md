# 接下来要做

更新时间：2026-11-25（核对基线：`origin/main` PR `#301`；延续 `2026-11-17` 纠偏索引并补齐种子律所反馈的协同会议与生产就绪主线）

本文是仓库级的下一步工作索引。详细需求、验收条件和讨论记录仍放在 `.scratch/<feature>/issues/*.md`；这里只维护当前优先级、开工顺序和容易忘掉的跨主题风险。

## 维护规则

- 新的可执行事项优先写成 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`。
- issue 状态使用 `docs/agents/triage-labels.md` 中的五个状态：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`；完成后直接标为 `done`。
- 本文只列“下一批要做”和“暂缓原因”，不要复制 issue 的完整验收清单。
- 每次完成一个 issue 后，同步更新本文的“当前主线”和“下一批候选”。
- 排期顺序以 [`.scratch/EXECUTION_PATH.md`](.scratch/EXECUTION_PATH.md) 及下列新主线 PRD 为准，本文只做索引。
- 工单头 `Status: done` 只表示实现已记录完成，不等于验收勾齐全、更不等于生产验收；不得凭 `done` 推断生产结果，也不得据此重复派发实现。
- **平台红线不变**：法律/破产词汇只留在 `workbook_template` 数据里，平台代码、数据库 schema、API 与系统提示不得出现法律硬编码。

## 当前主线（种子律所交付双主线）

根据种子律所真实反馈，律所除破产债权台账与外部协作者门户外，在日常保密办公及破产流程（债权人会议）中均刚需**保密协同与会议**（数据保密无法在公开的腾讯会议、飞书完成），且必须妥善覆盖**外部人员免下载客户端、免注册账号参会**等全部现实场景。同时需补齐生产容灾、端口安全与官网合规底线。

### 主线 1 — 全场景保密协同与会议（`.scratch/meeting-and-collaboration/`）

依据：[`.scratch/meeting-and-collaboration/PRD.md`](.scratch/meeting-and-collaboration/PRD.md)，共 13 张可独立验证工单，按 4 个波次推进：

- **波次 1（架构锁盘 + 原生客户端改版 + 公网互通）**：
  - `01-meeting-architecture-adr`（`ready-for-agent`）：全场景会议架构与外部参会安全 ADR（日常小会 P2P+托管TURN vs 外部正式大会私有 SFU、零注册/零 DB 凭证边界、隐私与录制红线）
  - `02-native-client-ux-shell-v2`（`ready-for-agent`）：协同 APP 壳层与产品文案改版（v2 阶段一，去“验收工具感”、登录前置首屏）
  - `03-native-client-chat-files-prejoin-v2`（`ready-for-agent`，依赖 `02`）：消息分组、显式文件卡片、会议首页、会前检查与防递归共享（v2 阶段二）
  - `04-managed-turn-and-cross-network`（`ready-for-agent`，依赖 `01`）：托管短时 STUN/TURN 凭据签发与三账号跨网公网互通验收
- **波次 2（免下载 Web 会议 + 日常外部访客）**：
  - `05-web-meeting-client-and-interop`（`ready-for-agent`，依赖 `01`、`04`）：Web 浏览器会议端与原生协同 APP 互通（含微信内置浏览器引导）
  - `06-external-guest-join-and-waiting-room`（`ready-for-agent`，依赖 `01`、`04`、`05`）：日常办公外部访客免下载免注册入会、等候室放行、踢出禁重入与零 DB 隔离
- **波次 3（私有 SFU + 受控外部正式会议闭环）**：
  - `07-sfu-private-media-plane`（`ready-for-agent`，依赖 `01`、`04`、`05`）：自托管私有 SFU 媒体平面（支撑 50–200 人大会、移动端纯音频省流与容量压测）
  - `08-roster-verified-external-meeting`（`ready-for-agent`，依赖 `01`、`07`）：名册核验型外部正式会议（支撑债权人会议，批量签发个人链接/访问码、单活互踢、单人吊销，法律术语留模板包）
  - `09-host-order-controls-and-hand-raise`（`ready-for-agent`，依赖 `07`、`08`）：主持人秩序强控（服务端强制全员静音禁自开、举手排队点名发言、锁定共享、结束全体会议）
  - `10-meeting-attendance-voting-writeback`（`ready-for-agent`，依赖 `08`、`09`）：精确签到与举手发言只追加流水、会中表决与异议、个人回执 PDF 及原子幂等回写工作簿
  - `13-meeting-recording-and-evidence-bundle`（`ready-for-agent`，依赖 `01`、`07`、`09`、`10`）：存证知情确认门禁、私有 SFU 轻量轨道直录 + 异步合成带 UTC 水印视频与分轨音频、私有加密归档与 SHA-256 根哈希《会议存证包》（预留 32 字节 TSA 司法时间戳接口）
- **波次 4（正式签名分发 + 综合验收）**：
  - `11-native-client-release-signing-pipeline`（`ready-for-human`，依赖 `02`、`03`、`04`）：macOS Developer ID 签名公证、生产更新信任根/feed、媒体供应链锁定与安全接收原生 CI
  - `12-meeting-e2e-and-pilot-acceptance`（`ready-for-agent`，依赖 `03`、`05`、`06`、`09`、`10`、`11`、`13`）：全场景端到端压测、存证包完整性验真与种子律所操作手册交付

### 主线 2 — 种子律所生产就绪与商业收口（`.scratch/pilot-production-readiness/`，可与主线 1 并行）

依据：[`.scratch/pilot-production-readiness/PRD.md`](.scratch/pilot-production-readiness/PRD.md)，共 6 张可独立验证工单：

- `01-surrealdb-offsite-backup-and-restore`（`ready-for-agent`）：生产 SurrealDB 加密异地自动备份与隔离恢复演练
- `02-vps-port-lockdown-and-retire-legacy`（`ready-for-human`）：VPS 通配暴露端口收口（Grafana/Prometheus/Exporter/TiKV/PD）与退役 `sck-company-mcp` 清理
- `03-marketing-commercial-and-legal-compliance`（`ready-for-agent`，表单部分依赖 `04`）：官网补齐《隐私政策》《用户协议》、移除 fixture 提示、补保密协同与债权人会议卖点、接半自助试用申请
- `04-public-portal-turnstile-and-rate-limit`（`ready-for-agent`）：外部协作者门户、外部会议入口与官网表单统一接入 Turnstile 与双层限流
- `05-native-quota-rollout-decision-and-cutover`（`needs-info`，依赖 `01`）：请老板裁决 PR `#59` 冻结状态并按 runbook 完成原生配额生产切流
- `06-legacy-done-tickets-production-evidence`（`ready-for-agent`）：补齐 VER-06 / VO-04 / VO-06 / claims-vertical / external-collaborator-portal（PR `#278`）生产验收证据与工单簿记纠偏

## 已经落地的底座（不再派发实现）

Web pivot 的五个需求簇（A 仓库重组、B Hono 骨架、C workspace-as-database、D1 Router workflow、D2 前端迁移）以及 D3 dashboard 迁移、运营迭代计划（OIP-01..18）、资源检索（RR-001..014）、工作区设置、个人中心、home 重设计全部 done。此外：

- **订阅配额控制面**（`.scratch/native-resource-quota/`）：SCK-NQ-01..10 全部 done，SurrealDB fork 生产已于 2026-11-21 升级到 `sck-4.0.1-native-quota.1`（镜像 `e68a34a4`，rocksdb，依据维护运行 44890559131），compose 只接受 digest 固定的自有镜像。配额切流收口见主线 2 工单 `05`。
- **虚拟员工 runtime & 虚拟办公室**（`.scratch/virtual-employee-runtime/`、`.scratch/virtual-office/`）：VER-01..06、VO-01..06 全部 `Status: done`，实现已上 `main`。生产验收证据补齐见主线 2 工单 `06`。
- **律师破产债权垂直簇**（`.scratch/claims-vertical/`）：01..06 均 `Status: done`，实现已上 `main`。生产复测收口见主线 2 工单 `06`。
- **外部协作者门户**（`.scratch/external-collaborator-portal/`）：主干已合入（PR `#275` 等），生产验收记录见开放 PR `#278` 及主线 2 工单 `06`。
- **原生协同客户端与内部 P2P 会议底座**（`native-client/`、`native-call/`、`062-native-signaling.surql`、`069-native-meeting.surql`）：双人信令与工作区内部成员会议骨架已合入 `main`；UI v2 改版、托管 TURN、Web 互通、外部免安装参会与私有 SFU 见主线 1。
- **shadcn 迁移 / server-skeleton / 法律内容 MCP / 法律内容持续采集**：实现工单均标 `done`（其中法律内容真实来源授权与持续采集未生产就绪，运营侧 bootstrap 现状需在主线 2 工单 `06` 核实）。
- **AI 产品层**（`.scratch/agentic-ai-product/`）：全部 done / wontfix，作为语义参考保留。

## 已 Cancelled / Superseded

- **同步 v2**：整体取消（Web pivot 后只有一个 SurrealDB 实例）。`.scratch/sync-v2/**` 已删除，`docs/adr/sync.md` 标 Superseded。
- **Electrobun sidecar 窗口**：`AI-009` wontfix，Web 浏览器无 sidecar 概念。
- 历史 issue 文本里的 pre-pivot 执行路径（`src/main/**`、renderer/main RPC、service JWT、NS-admin、后端业务 CRUD 代理、后端 LIVE 转发）一律不得复活。

## 长线风险与后续事项

- **中国法律数据合规**（P1 / pre-launch，Not started）：法律案件数据出境、国内数据中心选址与法务合同条款，建议单独立项 ADR + 持牌法务咨询。
- **SurrealDB root 凭证管理**（High，Not started）：文档化环境变量管理、禁打日志与轮换流程，后续评估短期 token / 密钥管理服务。
- **文件上传磁盘满错误处理**（Medium，进行中：开放 PR `#259` / `task/13e35c74`）：上传前校验可用磁盘空间并返回显式错误。
- **`GRAPH_TRAVERSE` 计算字段重算防抖**（Medium，Not started）：批量收集 dirty 计算字段，500ms 静默期后统一重算。
- **审计轨迹 UI**（P3 / post-MVP，Not started）：表格 UI 中按单元格/记录查看 mutation 轨迹。
