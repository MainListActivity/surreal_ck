Status: done
Label: ready-for-agent
ID: SCK-LCAQ-01
Repository: surreal_ck

# 来源准入与真实样本证据

## Parent

[首期本地采集规格](../PRD.md)

## What to build

为至少一个中国大陆法规来源、一个完整裁判文书来源建立可复核的准入记录：官方入口与发布者、文档实质/完整性、稳定记录键、增量发现方式、访问限制、可保存证据、采集/提交/发布/客户读取/AI 使用等动作的许可依据、有效期及未知项。对照已有 `legal-content-samples.md`，补足真实完整文本的可重复取得方式；研究页可读或合成 fixture 不算商用许可。符合资格后通过现有 `/api/content/sources` 建立/修订来源与不可变许可版本。

## Acceptance criteria

- [x] 每个候选有来源 URL、获取日期、文件形态与完整性证据、可访问方式、限制和许可原文/出处；无法验证的权利明确为未知并拒绝进入相应生产动作。（`../qualification/source-qualification-records.md`）
- [x] 不绕过登录、验证码、反自动化或访问限制；需要外部联系、签约或专业法律判断时先按公司授权链升级，不代行。（flk.npc.gov.cn / wenshu.court.gov.cn robots 全站禁采 → 不采集不注册；商用/AI/客户读取授权未知 → 拒绝，列入交接升级）
- [x] 已准入来源写入现有许可修订机制，历史修订可追溯；批次在提交时固化 `sourceLicenseSnapshot`，权限与发布前再次检查。（fgk.chinatax.gov.cn rev1、cicc.court.gov.cn rev1→rev2 经真实 `POST /api/content/sources` 建立；`platform_content.source_license_revision` 直查可见 append-only 历史；publish 门由 `PlatformContentService` 以 allowedActions 复查）
- [x] 样本只保存许可允许留存的证据，全文、摘要、指导案例整理稿与裁判原件不混称；记录真实样本与合成 fixture 的差别。（记录只存 URL/完整性核验/许可原文引用，未存全文；真实 URL 样本与 fixture.synthetic.cn 合成 fixture 严格区分）

## Scope handoff

本票只确认来源资格和样本，不承诺全量覆盖或默认开启周期采集。若无满足资格的来源，交接阻断原因与证据，02–04 保持合成/离线验证，不把未知权利改判为允许。许可修订复用现有 LCM-02/08；LCA-03 的客户读取仍取许可交集。

## Blocked by

None - can start immediately

## 实现记录（2026-09-30，task ea2c110c）

- 准入记录：`.scratch/legal-content-acquisition/qualification/source-qualification-records.md`（结论、逐项证据表、不合格候选、证据纪律、交接升级）。
- 注册载荷（可复用工件）：`qualification/register-fgk.chinatax.gov.cn.json`、`qualification/register-cicc.court.gov.cn.json`、`qualification/register-cicc-rev2.json`。
- 注册方式：本地隔离栈真实调用 `POST /api/content/sources`（native-quota SurrealDB 引擎容器 + Bun server 真实路由/校验/存储 + fixture IdP ops1 运营身份）。生产端点已上线（GET 实测 401），生产注册需运营真人 OAuth 登录后用同批载荷执行（runbook：`docs/runbooks/platform-content-local-runner.md`）。
- 关键证据：fgk 样本（公司法 2023 全文至第 266 条）当日 HTTP 200；CICC 判决书（（2022）最高法商初7号）当日全文结构完整；CICC 免责声明原文「仅限用于学习和研究目的」→ 两来源 allowedActions 均仅 `submit`；flk/wenshu robots 全站禁采 → 不合格不注册。
- 未验证/未知项已在记录中显式列出（批量采集接口、汇编权利、商用/AI 授权、文书原件一致性）。
