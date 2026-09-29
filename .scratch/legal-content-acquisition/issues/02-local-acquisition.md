Status: ready-for-agent
Label: ready-for-agent
ID: SCK-LCAQ-02
Repository: surreal_ck

# 本地采集、证据定位与成品适配

## Parent

[首期本地采集规格](../PRD.md)

## What to build

在本地 agent/适配器中从 01 准入的来源合法取得完整法规与裁判文书，辨别页面类型，保存许可允许的原始证据、采集时间和处理版本，生成 `shared/src/platform-content` v1 的 `IngestionBatch` 成品文件。复用现有 `scripts/platform-content-runner.ts` 向 MCP 提交，不增加服务端抓取器或第六个 MCP 工具。抽取字段及原文定位先做可测试的确定性步骤；模型建议单列，不能冒充来源事实。

## Acceptance criteria

- [ ] 输出被现有契约校验接受；来源键、URL、记录键、正文、类型、日期精度、未知字段原因与证据定位可回溯到样本。
- [ ] 法规条文和修订关系、文书类型与同案不同文书、引用主体/位置/版本歧义依实际证据表达；摘要、索引与指导案例整理稿不能误作完整原文。
- [ ] 正文规范化后引用定位与正文摘要一致；重复引文、清洗换行及 UTF-8 偏移有测试；服务端校验失败返回到本地可定位的条目。
- [ ] 不内置来源凭证、root、publisher secret；访问限制变化即停止，所存快照不超过许可范围。合成样本与真实样本分开标记。

## Scope handoff

采集适配器只产成品，现有 MCP 负责校验/发布。若 01 尚无可准入真实来源，只可用明确合成数据完成接口测试并记录真实来源验收未完成。

## Blocked by

- [SCK-LCAQ-01](01-source-qualification.md)
