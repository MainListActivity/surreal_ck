# 种子律所生产验真与对外交付边界

## 2026-11-27 UTC 核对

生产应用读回 `a06046e1a16e7752acc48e274fe9af83e20e080f`，部署 ID `45838340844-1`。[部署运行](https://github.com/MainListActivity/surreal_ck/actions/runs/45838340844) 的 origin 与 Cloudflare 作业均成功。公开 `/health` 返回 200，数据库状态为 `up`。配额 worker 各循环上报 `ok: true`，其中 native-audit 保留了 `lastError: QueryError`。源站精确运行版本仍需通过运营只读接口核验。

生产日志确认，native-audit 的 `quota_sweep_cursor` 认领事务提交时遇到 RocksDB 的 `!qm` 键并发冲突。原实现只立即重试一次，连续冲突仍会结束该轮。修复复用 [PR #301](https://github.com/MainListActivity/surreal_ck/pull/301) 的事务重试策略，仅在确认事务已回滚的冲突上退避重跑整笔事务，最多执行 24 次（含首次）。耗尽后保留原始错误。发布后复核 native-audit 最近成功时间与新增冲突日志。

| 验收项 | 已有证据 | 待核验 |
| --- | --- | --- |
| 破产债权模板 01/05/06 | 历史工单有实现和本地回归引用。 | 生产测试工作区用别名 Excel 建簿，核对失败行重导、数据体检、AI 提案及人工确认后的回读，留 SHA 与清理回执。 |
| 外部协作者门户 | 开放的 [PR #278](https://github.com/MainListActivity/surreal_ck/pull/278) 将 [部署 44754592691](https://github.com/MainListActivity/surreal_ck/actions/runs/44754592691) 与历史生产验收关联。PR 报告批量下载与即时作废、申报与补正、催办与结论发布、中文 PDF/CSV 导出通过，并记录测试工作区已清理。 | 独立复核原记录中的 CSV 公式防护。补测只读聚合及小于 3 的分组合并、异议流程；按本次 SHA 复测。PR 保持开放。 |
| VER-06 | 存在运行验证工具与[观察手册](employee-runtime-observation.md)。 | 运营会话下实测续约、重连和容量，记录工具输出与生产健康读回。 |
| VO-04 / VO-06 | 花名册、活动页与 onboarding 实现已合入。 | 实测首个 Bootstrap 和重试，以及花名册、活动页跨成员更新。 |
| 法律内容 bootstrap 与收录范围 | 产品提供运营配置和独立开关。[法律内容门禁](legal-rollout-gates.md) | 用运营只读会话核对主体、capability 和已授权可见来源。 |

写入类核验使用[测试物料](test-kit.md)开通的隔离工作区与合成数据。每条证据记录测试 UTC、应用与 origin SHA、操作和读回、截图或回执索引、清理结果。此次公开读回未覆盖需登录的业务验收。

## 对外沟通口径

- 可以介绍独立工作区、破产债权建簿与表格流程、外部协作者入口和浏览器参会的试点范围。正式交付以通过生产复验的能力为准。
- 试用经人工审核。期限、容量与 AI 使用范围以获批方案为准。AI 分析由审查人确认，法律内容仅承诺该工作区已获授权且已核定可访问的来源。
- 日常会议默认关闭云端音视频录制。全程存证会议按入场告知、知情确认和工作区权限处理。
- 上线承诺需具备生产异地备份回执、公开入口实测及法律文案审核记录。商业容量按已核定实测状态沟通。

## 原生配额决策

[PR #59](https://github.com/MainListActivity/surreal_ck/pull/59) 已于 2026-11-26 关闭，未合并。历史冻结仍需负责人书面裁决。由授权运营会话只读核对各 cohort 的状态、可信用量和差异，附成功异地备份回执及异常诊断。获准解冻后按[切流手册](native-quota-release-cutover.md)核定候选与回滚点，再从 synthetic 开始。每阶段观察时间从该阶段真实启动后计，记录晋级或暂停结果。
