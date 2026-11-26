# 种子律所生产就绪与商业闭环规划（PRD）

> 更新时间：2026-11-25  
> 核对基线：`surreal_ck` `origin/main`（PR `#301`）、`surreal-ck-operations` `landscape/company-landscape.json`（`v0.13.85`）

## 1. 背景与问题清单

代码能力（Workspace-as-DB、SurrealDB 4.0.1 原生配额、VER/VO、破产债权模板、外部协作者门户）已大量合入 `main`，但在正式交付 3 家种子律所并承载保密案件数据前，存在六项明确的规划与生产短板：

1. **单主机无异地备份**：生产 `_system`、全部客户 workspace 库、平台内容库与公司库均集中在唯一 VPS（`vps-data`），一旦磁盘故障或误操作将面临不可逆丢数据风险。
2. **VPS 未受控端口与退役服务残留**：实机核对发现 Grafana `*:3000`、Prometheus `*:9090`、Exporter、TiKV `*:20160`、PD `*:2379` 处于通配监听状态，且旧版 `sck-company-mcp.service` 与 Caddy `/sck-mcp` 尚未下线。
3. **官网对外转化与合规壳缺失**：`marketing/src/data/bankruptcy.ts` 页脚《隐私政策》《用户协议》链接仍为 `null`，正文仍保留“当前试用配置为内部验收用途（fixture）、不代表正式商业承诺”的劝退文案，且缺少协同保密会议卖点与半自助试用申请入口。
4. **外部公开入口缺防滥用保护**：外部协作者门户、外部会议访客入口与官网试用表单尚未接入服务端 Turnstile 校验与边缘限流。
5. **原生配额生产切流状态悬空**：`main` 与生产引擎已升至 `4.0.1-native-quota.1`，但未合并 PR `#59` 曾记录冻结生产收口，需老板明确是否解冻并按 runbook 完成切流，使商业套餐限额真正生效。
6. **历史 `done` 工单缺生产验收证据**：`EXECUTION_PATH.md` 标出 VER-06、VO-04、VO-06、claims-vertical、external-collaborator-portal（PR `#278`）等存在“代码 done 但生产验收未记录”的缺口。

## 2. 任务拆分与执行顺序

6 项任务均可独立验证，建议按安全底线优先顺序推进：

- **并行止血（立即可开工）**：`01`（SurrealDB 异地备份与恢复演练）、`02`（VPS 端口收口与退役清理）、`03`（官网商业化文案与隐私/协议上线）、`04`（公开入口 Turnstile 与限流）
- **决策与证据收口**：`05`（原生配额切流解冻决策与灰度执行）、`06`（历史已完成簇生产证据补齐与工单对齐）
