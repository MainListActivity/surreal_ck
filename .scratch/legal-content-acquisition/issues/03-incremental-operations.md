Status: done
Label: ready-for-agent
ID: SCK-LCAQ-03
Repository: surreal_ck

# 本地增量检查点、重试与运行可见性

## Parent

[首期本地采集规格](../PRD.md)

## What to build

在本地采集器上增加每来源持久化发现游标、重叠窗口、失败候选和重试状态。进程可中断恢复；取得原始证据、成品落盘、MCP 提交与检查点推进各有可重放边界。继续复用 LCM-09 runner 的批次幂等键/提交检查点。运营显式配置本地 scheduler 前不启动周期运行，自动运行默认只提交和 inspect。

## Acceptance criteria

- [ ] 同来源重复发现、进程在各阶段中断和离线恢复不遗漏失败项、不重复发布版本；同键同内容复用批次，同键不同内容报冲突。
- [ ] 迟到文书可由有界重叠扫描发现；无可靠游标时记录扫描范围，不宣称全量。单条失败不阻止其它候选处理，也不使失败条目从待办中消失。
- [ ] 每来源展示最近成功检查时间、扫描范围、候选/重复/更新/失败/待核验数、停用原因；空结果与请求或解析失败区分。
- [ ] 401、OAuth 刷新失败、许可失效或访问限制变化停止后续远端操作；重试遵守来源预算与已准入方式，恢复需重新授权/准入。
- [ ] 不创建默认定时器，不将 OAuth 同意视为未来批次的发布批准；日志不含 token 或原始敏感正文。

## Scope handoff

本票处理本地发现/恢复，与服务端既有批次校验和发布幂等相衔接。实际生产调度频率由 01 的来源能力和运营批准确定。

## Blocked by

- [SCK-LCAQ-02](02-local-acquisition.md)

## 实施记录（2026-09-30）

- 新增 `adapter/incremental.ts`（增量引擎）+ `adapter/incremental-run.ts`（单次 CLI）+ `adapter/incremental.test.ts`（16 测试）。
- **每来源持久化状态**（`runs/incremental-state.json`，tmp+rename 原子写）：发现游标（seen：recordKey → 快照摘要/路径/fetchedAt/已提交摘要）、失败重试状态（attempts/错误类别）、预算顺延队列、最近成功检查时间、待提交批次、停用与授权停止标记。状态只含键/URL/摘要/计数，不含 token 或正文。
- **可重放边界**：证据获取（快照按内容寻址落盘，恢复不重抓）→ 成品落盘（确定性重建，同键同内容复用）→ MCP 提交（复用 LCM-09 runner：`scripts/platform-content-runner.ts` export 化 `submitAndInspectBatch`，CLI 行为不变，401/网络失败类型化为 `McpHttpError`）→ 检查点推进（每阶段边界后原子持久化）。提交边界后中断 → 恢复 pass 原样重放同一幂等键（服务端幂等，不重复出版本）；证据边界后中断 → 从快照重建批次，零抓取。
- **冲突语义**：同幂等键 + 磁盘内容变化 → `BatchKeyConflictError`（pass 前预检，全停待运营处置），运营确认后 `--new-batch-key` 开新批次。
- **有界重叠窗口**：每 pass 复查最近 N 条（默认 5）已提交记录，内容变化判「更新」重新提交（迟到文书/修订由此发现）；无游标时报告 `provided-candidates` 模式并注明「不宣称全量覆盖」。
- **失败重试**：单条失败记 request/parse 类别与 attempts，不阻塞其它候选；重试遵守每来源抓取预算（默认 12/pass，超限顺延入队不丢失）；耗尽（默认 3 次）后保留待办可见。
- **停止条件**：来源访问限制/许可边界变化（robots/登录/验证码/403，AccessRestrictedError）→ 来源停用、未处理候选保留排队，恢复需 `--readmit <sourceKey>`；MCP 401/403 → 全局授权停止（后续 pass 拒绝远端，批次保留），恢复需运营重新完成 OAuth 后 `--reauthorized`。
- **可见性**：每来源报告 outcome（ok/empty/request_failure/parse_failure/blocked/conflict，空结果与失败区分）、最近成功检查时间、扫描范围与诚实说明、候选/重复/更新/失败/重试/顺延/待核验/暂存/失败活跃/耗尽计数、停用原因；报告落盘 `runs/last-pass-report.json` 并输出 JSON。
- **无调度**：本工具单次运行，不创建任何默认定时器；周期运行须运营显式配置本地 scheduler 调用。自动运行只 submit+inspect，代码中无发布通路（`publish_batch` 仅存在于 runner CLI 的显式 `--publish` + `CONTENT_PUBLISH_CONFIRM=YES` 分支）；OAuth 同意不构成任何批次的发布批准。
- **验证**：`bun test ./.scratch/legal-content-acquisition/adapter/` → 37 pass（16 增量 + 21 既有适配器无回归）；`bunx tsc --noEmit --strict`（适配器与 runner，仅环境缺 Bun 全局类型的既有告警）；`bun build scripts/platform-content-runner.ts --target bun`（LCM-09 验证命令）通过；`pnpm typecheck` / `pnpm lint` 全 workspace 干净。
- **限制**：真实来源的列表页发现（自动发现新详情页 URL）仍不在适配器内——候选 URL 由运营/上游清单提供，重叠复查只覆盖已见记录；DB 迁移：无；新环境变量：无（沿用 CONTENT_MCP_URL/CONTENT_ACCESS_TOKEN/CONTENT_BATCH 既有约定）。
