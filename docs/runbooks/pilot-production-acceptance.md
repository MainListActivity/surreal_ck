# 种子律所生产验真与对外交付边界

## 2026-11-27 / 2026-11-28 UTC 最新生产证据

- **P-01（SurrealDB 异地自动备份与恢复）**：首份生产 TiKV 全量加密备份完成 R2 回读，15 个 namespace / 72 个 database 在异机隔离 RocksDB 恢复与对账通过（耗时 227.52 秒，零差异）。VPS 已启用每日 `19:45:00 UTC` 自动定时备份（`surrealdb-offsite-backup.timer`）与 `<26h` 新鲜度检查（`/usr/local/sbin/sck-surrealdb-backup-check`，实测 `ok: true`），并通过 `surreal-ck-operations` PR `#2324` / `0.13.88` PR `#2325` 正式登记至 `company-landscape.json`。[首次生产备份与异机恢复](surrealdb-offsite-backup.md#首次生产备份与异机恢复)
- **P-02（VPS 端口收口与退役清理）**：VPS IPv4/IPv6 防火墙已拦截并持久化收口 `3000/9090/9100/9115/2379/2380/20160/12020/3425`，Caddy 已移除 `/sck-mcp/*`（返回 404），宿主机残留未加载 plist `org.surrealck.deliverable-preview.plist` 已清理。
- **P-03 / P-04（官网、反馈闭环与防滥用限流）**：`surreal-ck-operations 0.13.88`（`46101061404`）修复了 `owner-end/src/feedback.ts` 在 Bun 1.3.11 下转发流 502 缺陷；生产 `POST https://company.maplayer.top/api/feedback/surreal_ck` 完成 `202` 收件回执、幂等重放 `202`、改正文 `409` 冲突、库内回读确认 `contact` 独立隔离及合成数据清理验证。生产 `POST https://l.maplayer.top/api/public/trial-request` 实测第 1–12 次缺/假令牌返回 `403`，第 13 次精确返回 `429` + `Retry-After` + `Access-Control-Expose-Headers: Retry-After`。**2026-11-28T06:38:43Z 老板在真实浏览器完成 `https://www.maplayer.top/trial/` 真人 Turnstile 提交**，取得收件回执 `7db09d49a4a7f226cbb1925b0daf1049cc4e553bb648ca7ef7705f73ecf24a07`，生产库回读确认 `product_feedback` 与自动转化的 `product_requirement` 完整落库且联系方式零泄漏（`contact_leaked_in_text: false`、`contact_leaked_to_draft_requirement: false`），并已完成双表测试数据清理归零。仅余正式法务定稿确认、外部门户浏览器复测（并入 P-06）与原生名册客户端衔接决策。[P-03 实测](../../.scratch/pilot-production-readiness/issues/03-marketing-commercial-and-legal-compliance.md) · [P-04 实测](../../.scratch/pilot-production-readiness/issues/04-public-portal-turnstile-and-rate-limit.md)
- **P-05（原生配额解冻与 `synthetic_internal` 切流）**：老板于 2026-11-28 UTC 书面解冻切流。完成 `_system` 与 31/31 `synthetic_internal` 工作区（含唯一遗留旧事件工作区 `442d` 移除 7 张表 `resource_quota_guard` 事件）的原生配额实装、物理扫描零差异对账与 `sync_state: in_sync` 收敛，全局 `in_sync` 由 `9 → 35`；16 个 `standard` 工作区严格保留至强制 24h 观察窗（`observe_until: 2026-11-29T03:53:29.139Z`）后再按 `one_percent → ten_percent → fifty_percent → remainder` 推进。[P-05 实测](../../.scratch/pilot-production-readiness/issues/05-native-quota-rollout-decision-and-cutover.md)
- **P-06（历史已完成功能簇生产复验）**：已通过公司受控 QA 通道派发干净生产复验任务 `17785c49-637e-457e-bd28-a6ebda0a2274`（`qa-claude-c4c68d`），已完成生产 `ops_login`（`sck-qa1`）并正在持续执行 `claims-vertical 01/05/06`、外部门户剩余项、`VO-04/VO-06/VER-06` 及法律内容边界实测，结案后补充完整验收表与清理回执。

## 2026-11-27 UTC 早期健康记录

生产应用读回 `a06046e1a16e7752acc48e274fe9af83e20e080f`，部署 ID `45838340844-1`。[部署运行](https://github.com/MainListActivity/surreal_ck/actions/runs/45838340844) 的 origin 与 Cloudflare 作业均成功。公开 `/health` 返回 200，数据库状态为 `up`。配额 worker 各循环上报 `ok: true`，其中 native-audit 保留了 `lastError: QueryError`。源站精确运行版本仍需通过运营只读接口核验。

生产日志确认，native-audit 的 `quota_sweep_cursor` 认领事务提交时遇到 RocksDB 的 `!qm` 键并发冲突。原实现只立即重试一次，连续冲突仍会结束该轮。修复复用 [PR #301](https://github.com/MainListActivity/surreal_ck/pull/301) 的事务重试策略，仅在确认事务已回滚的冲突上退避重跑整笔事务，最多执行 24 次（含首次）。耗尽后保留原始错误。发布后复核 native-audit 最近成功时间与新增冲突日志。

| 验收项 | 已有证据 | 待核验 |
| --- | --- | --- |
| 破产债权模板 01/05/06 | 历史工单有实现和本地回归引用。 | 生产测试工作区用别名 Excel 建簿，核对失败行重导、数据体检、AI 提案及人工确认后的回读，留 SHA 与清理回执。 |
| 外部协作者门户 | 已合并的 [PR #278](https://github.com/MainListActivity/surreal_ck/pull/278) 将 [部署 44754592691](https://github.com/MainListActivity/surreal_ck/actions/runs/44754592691) 与历史生产验收关联。PR 报告批量下载与即时作废、申报与补正、催办与结论发布、中文 PDF/CSV 导出通过，并记录测试工作区已清理。 | 独立复核原记录中的 CSV 公式防护。补测只读聚合及小于 3 的分组合并、异议流程；按核准的生产版本复测。 |
| VER-06 | 存在运行验证工具与[观察手册](employee-runtime-observation.md)。 | 运营会话下实测续约、重连和容量，记录工具输出与生产健康读回。 |
| VO-04 / VO-06 | 花名册、活动页与 onboarding 实现已合入。 | 实测首个 Bootstrap 和重试，以及花名册、活动页跨成员更新。 |
| 法律内容 bootstrap 与收录范围 | 产品提供运营配置和独立开关。[法律内容门禁](legal-rollout-gates.md) | 用运营只读会话核对主体、capability 和已授权可见来源。 |

写入类核验使用[测试物料](test-kit.md)开通的隔离工作区与合成数据。每条证据记录测试 UTC、应用与 origin SHA、操作和读回、截图或回执索引、清理结果。此次公开读回未覆盖需登录的业务验收。

## 对外沟通口径

- 可以介绍独立工作区、破产债权建簿与表格流程、外部协作者入口和浏览器参会的试点范围。正式交付以通过生产复验的能力为准。
- 试用经人工审核。期限、容量与 AI 使用范围以获批方案为准。AI 分析由审查人确认，法律内容仅承诺该工作区已获授权且已核定可访问的来源。
- 日常会议默认关闭云端音视频录制。全程存证会议按入场告知、知情确认和工作区权限处理。
- 上线承诺需具备生产异地备份回执、公开入口实测及法律文案审核记录。商业容量按已核定实测状态沟通。

## 原生配额生产只读基线

2026-11-27 UTC 生产聚合读回

| 范围 | 脱敏结果 |
| --- | --- |
| `main` 命名空间 | 59 个库。其中 5 个已有原生策略且 `usage_trusted: true`，51 个尚无原生策略，余下 3 个未在摘要中分类。已核对范围内 `UNTRUSTED_COUNT: 0` |
| `quota_migration_run` | 仅有 2026-08-30 在 3.3.0 RocksDB 时期的记录。`synthetic_internal: paused`，其余 cohort 为 `pending` |
| `workspace_quota_runtime` | 51 个工作区均为 `ledger_state: ready`。本次核对期间 native-audit 持续零报错 |
| `workspace_rollout_gate` | 4 个工作区开通 `legal_content_access`，3 个开通 `legal_research_ai` |

## 原生配额决策

[PR #59](https://github.com/MainListActivity/surreal_ck/pull/59) 已于 2026-11-26 关闭，未合并。2026-11-28 UTC 老板已书面授权解冻并启动灰度切流。已完成 `_system` 及 `synthetic_internal`（31/31 工作区，含唯一遗留旧事件工作区 `442d` 移除 7 张表 `resource_quota_guard` 事件）的原生策略实装、独立物理扫描零差异对账与 `in_sync` 收敛（全局 `in_sync: 9 → 35`，`native-audit` 持续零报错）。当前进入强制 24 小时观察窗（`cutover_completed_at: 2026-11-28T03:53:29.139Z`，`observe_until: 2026-11-29T03:53:29.139Z`）；余下 16 个 `standard` 工作区待观察窗零阻塞信号后按 `one_percent → ten_percent → fifty_percent → remainder` 推进。完整脱敏回执保存在 VPS `/var/lib/surreal-ck-backup/quota-migration-20261128/synthetic-internal-cutover-receipt.json`。
