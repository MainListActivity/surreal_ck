Status: ready-for-agent
Label: ready-for-agent

# 首期本地法律内容采集实施簇

## Parent 与边界

来源：[wayfinder-12 首期定稿](../legal-data-product-wayfinder/issues/12-legal-content-ingestion.md)。目标是把**已准入的真实来源**转成本地可追溯 `IngestionBatch`，用现有 OAuth MCP 提交、校验，由运营逐批决定发布。平台内容库、五工具、ops 来源许可修订、成品文件 runner 已由 SCK-LCM 簇交付，实施前复核其现状，缺口才改代码。

首期只采中国大陆法规和可取得完整公开文本的裁判文书；实际覆盖范围随准入来源明确展示。不得绕过登录、验证码或访问限制。公开网页可读不等于具有采集、商用或 AI 使用许可，未知权利拒绝。许可版本沿用 `content_source` / `source_license_revision` 和现有来源管理接口，不建立平行权限台账。

## 实施顺序

| ID | 票 | 依赖 |
|---|---|---|
| SCK-LCAQ-01 | [来源准入与样本证据](issues/01-source-qualification.md) | 现有 SCK-LCM 来源管理 |
| SCK-LCAQ-02 | [本地采集与成品适配](issues/02-local-acquisition.md) | 01 |
| SCK-LCAQ-03 | [增量检查点与恢复](issues/03-incremental-operations.md) | 02 |
| SCK-LCAQ-04 | [真实来源闭环验收](issues/04-real-source-pilot.md) | 01–03 |

每票完成时记录实际变更、测试、来源许可证据与限制；真实来源获许可前只用合成或获准样本联调，不向客户发布。经理可按来源准入结果安排实施链；资格不足不以技术绕过替代。
