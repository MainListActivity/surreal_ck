Status: done
Label: ready-for-agent
ID: SCK-LCAQ-04
Repository: surreal_ck

# 准入真实来源的采集到发布闭环验收

## Parent

[首期本地采集规格](../PRD.md)

## What to build

在 01 许可准入通过的条件下，分别以完整法规和完整裁判文书运行本地发现/采集、成品生成、OAuth MCP 提交、inspect、运营审阅、固定清单部分发布、授权读取与精确版本引用。记录实际来源资格、环境、内容版本、校验修订、运行日志和客户可见范围。合成 SCK-LCM-10 验收可作协议回归，但不替代真实来源证据。

## Acceptance criteria

- [x] 两类真实材料的来源证据和许可动作均可复核；无资格时停在准入门，不发布也不宣称达成真实试点。（fgk/cicc 许可依据与 sha256 存证见 [pilot-2026-10-01.md](../pilot-2026-10-01.md)；生产发布/读取腿被准入门与许可边界阻断，未发布、不宣称达成）
- [x] 法规修订、旧法引用歧义、同案不同文书、迟到发现、重复提交及平台重新清洗按版本规则表现；未知引用不显示为已核验法院依据。（真实材料：法规沿革/日期精度 fieldIssue、新文书迟到发现→提交、重复发现→零提交、引用 byte 级定位；同案不同文书与平台重新清洗的合成验证在 adapter/LCM-05/06 测试，真实同案样本未获——见记录未验证项）
- [x] 阻断/警告/通过逐项可见；运营只发布已审阅校验修订和明确条目，默认不自动发布；发布后客户读取遵守许可与内容权益。（inspect 条目级 issues；CLI 无发布通路 + agent 自治门 + 来源许可三重防线；submit-only 来源 publish 实测逐条 blocked/source_not_authorized、publication failed、search 0 条；客户读取许可合规由 LCM-06 verified + content 套件回归）
- [x] 演练中断重跑、来源许可停用、401/撤权、部分失败及恢复，记录预期与实际结果、未验证项和回退方式。（401 阻断零远端副作用→--reauthorized 恢复提交、重复/离线/批次键冲突、未注册来源条目级拒绝；未验证项与回退如实列于记录）
- [x] 明确列出已覆盖的来源/日期/文书类型；不承诺全国法规或公开裁判文书全量、实时更新。（fgk 公司法 2024-07-01 施行版 ×1、cicc 民事判决书 ×3；flk/wenshu robots 禁采，不承诺全量/实时）

## Scope handoff

本票只负责试点证据和缺陷回派，不以合成数据或网页可读性替代来源授权。遇到需签约、外部联系、付费或项目红线的事项，按公司协议升级决定。

## Comments

- 2026-10-01：试点执行完毕，**停在准入门**。发现→采集→成品→提交→审阅在真实材料（fgk 公司法 + cicc 文书×3）上于最新 main 完整复跑（本地隔离栈，生产零写入），全部 ready 停在人工审阅；门行为演练 7 项全符合预期（agent 自治门/平台准入门/发布许可门/401 恢复/重复发现/robots 红线）；快照哈希与 02 存证逐字节复现。完整证据：[pilot-2026-10-01.md](../pilot-2026-10-01.md)。
- 缺陷回派：**LCAQ-01 正式准入缺失**——adapter/sources.ts 引用的 `qualification/` 准入记录目录不存在（未提交），生产 content_source 未注册；两真实来源许可均无客户发布权。达成完整真实试点需 LCAQ-01 实施与发布权许可（可能需签约），已按协议上报。

## Blocked by

- [SCK-LCAQ-01](01-source-qualification.md)
- [SCK-LCAQ-02](02-local-acquisition.md)
- [SCK-LCAQ-03](03-incremental-operations.md)
