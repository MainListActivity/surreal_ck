Status: done
Label: ready-for-agent
ID: SCK-LCAQ-02
Repository: surreal_ck

# 本地采集、证据定位与成品适配

## Parent

[首期本地采集规格](../PRD.md)

## What to build

在本地 agent/适配器中从 01 准入的来源合法取得完整法规与裁判文书，辨别页面类型，保存许可允许的原始证据、采集时间和处理版本，生成 `shared/src/platform-content` v1 的 `IngestionBatch` 成品文件。复用现有 `scripts/platform-content-runner.ts` 向 MCP 提交，不增加服务端抓取器或第六个 MCP 工具。抽取字段及原文定位先做可测试的确定性步骤；模型建议单列，不能冒充来源事实。

## Acceptance criteria

- [x] 输出被现有契约校验接受；来源键、URL、记录键、正文、类型、日期精度、未知字段原因与证据定位可回溯到样本。（批次经 `validatePlatformContentBatch` 本地复核 + 真实 MCP `submit_batch`/`inspect_batch` 服务端校验 status=ready：batch_6f2138b2-8613-4efb-b301-65aaf4f4223b）
- [x] 法规条文和修订关系、文书类型与同案不同文书、引用主体/位置/版本歧义依实际证据表达；摘要、索引与指导案例整理稿不能误作完整原文。（条文按页面沿革/施行条款判版本；speaker 只按可证段落（本院认为=法院/诉辩=当事人/查明=不标）；列表页/摘要页在适配器内直接拒绝）
- [x] 正文规范化后引用定位与正文摘要一致；重复引文、清洗换行及 UTF-8 偏移有测试；服务端校验失败返回到本地可定位的条目。（21 测试全过：`bun test ./.scratch/legal-content-acquisition/adapter/adapter.test.ts`；篡改引文偏移的批次服务端返回 `locator_mismatch`+entryKey+fieldPath，实测条目级定位）
- [x] 不内置来源凭证、root、publisher secret；访问限制变化即停止，所存快照不超过许可范围。合成样本与真实样本分开标记。（适配器零凭证；robots 检查+登录/验证码特征即停（AccessRestrictedError）；快照只落本地 runs/（gitignore，许可范围=内部核验）；测试全部用合成页 fixture，真实样本只在 runs/ 清单里以 sha256 存证）

## Scope handoff

采集适配器只产成品，现有 MCP 负责校验/发布。若 01 尚无可准入真实来源，只可用明确合成数据完成接口测试并记录真实来源验收未完成。

## 实施记录（2026-09-30）

- 适配器：`.scratch/legal-content-acquisition/adapter/{sources,http,extract,legislation,judgment,emit,run,deps}.ts` + `adapter.test.ts`（21 测试全过）+ `test-fixtures/*.html`（合成样本，与真实样本分离）。
- 真实运行（2026-09-30，许可范围内：fgk=官方规章文本内部核验用途、cicc=站点声明仅限学习研究）：
  - `https://fgk.chinatax.gov.cn/zcfgk/c100009/c5233383/content.html` → entryKey `fgk.chinatax.gov.cn--c5233383`，《中华人民共和国公司法》full_text 96,399 字节，266 条（第一条→第二百六十六条），机关=全国人大常委会，类型=法律，施行 2024-07-01，版本沿革=2023-12-29 第二次修订；promulgatedOn 精度以 fieldIssues 标注。
  - `https://cicc.court.gov.cn/html/1/218/180/316/12572.html` → entryKey `cicc.court.gov.cn--12572`，（2022）最高法商初7号 民事判决书 full_text 39,837 字节，落款 2024-01-24，引文 24 条（byte 级 UTF-8 定位+bodyDigest 绑定）；instance/procedure 无证据以 fieldIssues 标注（未杜撰）。
  - 快照 sha256：fgk `13621de9efe0cf144e4bfb4c831c5f27c7bfd62a872ca64f87cc143a008d8eee`、cicc `023cc3f52c66de7cf83981a983716bfae0d2ab199b2124fdf64274ed4a164069`；批次 sha256 `6e85d8a0478f1f11b0dad28b3f96aca288d5ae8cf3424d8b92ace167606ec003`；idempotencyKey `lcaq02-live-20260930-v1`。
- 端到端：批次经仓库现有 `scripts/platform-content-runner.ts` 提交到 MCP（`/api/ops/mcp`）`submit_batch` + `inspect_batch`：batchId `batch_6f2138b2-8613-4efb-b301-65aaf4f4223b`，status=ready，两真实条目均 publishable，**未发布**（许可只允许 submit，停在人工审阅）。**注意：该 MCP 提交实测发生在本地隔离栈**（fixture IdP ops1 + 容器 SurrealDB，刻意不碰生产）——走的是与生产同款的服务端代码路径，非生产服务；生产来源注册按 LCAQ-01 记录需运营 OAuth，尚未执行。
- 失败定位路径实测：篡改引文起始字节的批次 → 服务端该条目 blocked，issue `locator_mismatch`（含 entryKey + fieldPath=locator），合法条目不受影响——服务端校验失败可定位到条目。
- 合规控制：每源 robots 预检（flk/wenshu 红线来源直接拒绝）且 **Disallow 规则强制执行**——目标 URL 与每个重定向目标命中即停（AccessRestrictedError，注入 fetcher 测试证明被禁路径不产生请求）；重定向只允许留在准入来源 origin 内，跨域/出站 3xx 拒绝（cookie 不出域），重定向超限亦拒绝并记入 trail；登录/验证码/无权特征即停（AccessRestrictedError，只扫可见文本避免把脚本里的组件名误判）；CICC WAF 302+cookie 为标准 HTTP 会话（无绕过）；适配器零凭证、零 secret。
- 验收修复（2026-09-30 第二轮）：验收退回指出的两处防线缺陷已修复并各有测试——robots Disallow 此前只解析未应用（`isPathDisallowed` 死代码），现已接入 `politeFetchHtml` 目标检查与 `fetchWithCookies` 重定向检查；重定向此前无同源约束，现要求 location 目标仍在 `config.origin` 之下否则即停。另：`sectionSpeaker` 在文档无任何段落标记时由 party 改为 unknown（与模块注释一致；首个标记之前的诉辩段仍为 party，有测试锁定）。
- 运行产物（快照/批次）只存本地 `adapter/runs/`（.gitignore）；清单摘要与 sha256 存证如上。

## Blocked by

- [SCK-LCAQ-01](01-source-qualification.md)
