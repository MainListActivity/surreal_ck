Status: ready-for-agent

# 06 · 历史已完成功能簇的生产验收证据补齐与工单对齐

**目标**：按 `EXECUTION_PATH.md` 记录的证据缺口，逐项补齐核心已实现模块在生产环境（`l.maplayer.top`）的独立 QA 实测证据，确保交付给种子律所前没有任何“代码合入但线上未验”的盲区。

## 范围

1. **破产债权垂直簇生产复验（`claims-vertical` 01/05/06）**：在生产测试工作区实测模板建簿、Excel 别名导入校验、数据体检、AI 行分析提案确认写回与失败行重导，补齐缺失的 `CLAIMSE2E` 与生产复测记录。
2. **外部协作者门户生产验收收口（`external-collaborator-portal` / PR `#278`）**：合并或收口生产验收记录，实测批量签发（CSV 防注入）、单人作废立即踢出会话、补正提交、结论发布与只读聚合看板（小分组合并 `<3` 规则）。
3. **虚拟员工与虚拟办公室生产抽检（`VER-06`、`VO-04`、`VO-06`）**：运行 `scripts/verify-employee-runtime.ts` 验证续约与重连，实测工作区 onboarding（`POST /api/workspaces/:slug/office/bootstrap`）与花名册/活动页展示。
4. **平台法律内容运营侧就绪核对**：核实 `legal-content-mcp` 生产运营 bootstrap 配置（OIDC subject 与内容 capability）及 `legal-content-acquisition` 当前真实授权内容覆盖范围，写明对种子律所可承诺与不可承诺边界。
5. **工单簿记一次性纠偏**：仅在取得真实测试或生产证据后，更新对应 `.scratch/` 工单的验收勾与状态头，并在 `TODOS.md` 标明最新核对基线。

## 非目标

- 不凭代码存在或历史旧记录直接勾选验收框；未实测通过项一律标为“失败并另建缺陷工单”或“明确未测及原因”。

## 独立验收标准

- [ ] `claims-vertical` 生产全链路（导入 → 体检 → AI 提案 → 人工确认写回）完成实测并归档脱敏证据（含生产 SHA、测试工作区清理回执）。
- [ ] `external-collaborator-portal` 全模块生产验收完成并收口开放 PR `#278`。
- [ ] `VER-06`、`VO-04`、`VO-06` 产出真实运行/浏览器验收证据，明确区分已验证项与已知限制。
- [ ] 输出一份《种子律所可承诺能力与已知边界清单》（含法律内容授权现状），供老板与 CS 团队对外沟通使用。

**依赖**：无（可与 `meeting-and-collaboration` 并行推进）。  
**验证方式**：独立 QA 生产实测（使用 `ck-test-kit` 专用测试主体，测完清理）+ 脱敏验收记录归档。

## 2026-11-27 / 2026-11-28 UTC 核对记录

- 已归档[生产基线、PR #278 历史证据和对外口径](../../../docs/runbooks/pilot-production-acceptance.md)。
- 2026-11-28 UTC 已通过公司受控 QA 通道派发干净生产复验任务 `17785c49-637e-457e-bd28-a6ebda0a2274`（复用生产已登记测试账号，不调用 D1 建号）；QA 员工 `qa-claude-c4c68d` 已于 `03:49:05Z` 完成生产 `ops_login`（`sck-qa1`）并正在持续执行 `claims-vertical 01/05/06`、外部门户剩余项、`VO-04/VO-06/VER-06` 与法律内容边界实测，结案后补充完整脱敏证据与清理回执。
