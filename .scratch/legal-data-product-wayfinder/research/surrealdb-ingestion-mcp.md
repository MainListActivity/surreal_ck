# SurrealDB 原生采集与 MCP 能力核验

研究日期：2026-09-04。本文核验官方在线文档；不是当前部署版本的实测报告。文档同时包含 3.1、3.2、3.3 的能力说明，落地前必须与本地 fork 的实际版本核对。

## 结论

首期适合采用「本地 Agent 采集与清洗 → 运营内容 MCP 接收标准成品 → 校验与发布」。新增网站的解析可以在本地完成，只要产物仍符合固定数据契约，就不需要重新发布平台服务。这是项目设计建议，并非 SurrealDB 已有的法律内容流水线。

SurrealDB 能通过 HTTP 请求取得 JSON/文本，能用 SurrealQL 做确定性清洗和写入，也有官方 MCP；但官方文档没有提供通用网页浏览、站点自动适配、动态网页执行和法律内容审核的一体化工具。不能由「AI 上下文数据库」推出「任意站点自动采集器」。此结论根据下面工具清单与接口语义作出，属于能力边界判断。

## 已有能力与边界

| 能力 | 已核实事实 | 对本项目的意义 |
| --- | --- | --- |
| 自托管 MCP | 3.1 起内置 MCP；HTTP `/mcp` 面向现有实例，提供 query、数据读写、函数调用、schema 等工具；沿用数据库授权与 capability。 | 可作为通用数据库操作入口，但未提供法律数据批次审核、版本匹配或成品接收工具。生产远程连接应评估 HTTP 模式，不能把本地 stdio 的 owner 语义误认为受限发布者。见 [Embedded MCP](https://surrealdb.com/docs/build/ai-agents/mcp/embedded)。 |
| 云端 MCP | 托管服务面向 SurrealDB Cloud，增加云组织与实例管理。 | 当前自部署项目不应把 Cloud MCP 当作现成的自托管运营后端。见 [官方 MCP](https://surrealdb.com/docs/build/ai-agents/mcp)。 |
| HTTP 获取 | `http::get` 对 JSON 响应解析为值，其余按文本返回；非 2XX 失败，支持请求头。 | 适合直接 API 和可取得的静态正文。返回 HTML 文本不等于浏览器渲染后的 DOM。见 [HTTP 函数](https://surrealdb.com/docs/reference/query-language/functions/database-functions/http)。 |
| 内嵌 JavaScript | 支持 ES2020 脚本，需启用 scripting；提供 fetch 与数据库调用辅助能力。 | 能执行数据处理逻辑，但文档未提供浏览器 DOM、页面导航、点击、JS 网页渲染能力，不能替代浏览器采集。见 [脚本概览](https://surrealdb.com/docs/reference/query-language/scripting/overview)、[脚本内置函数](https://surrealdb.com/docs/reference/query-language/scripting/built-in-functions)。 |
| 确定性清洗 | 字符串替换/裁剪/拆分、数组去重、类型转换均有内建函数。 | 适合字段标准化、日期转换、固定规则处理；案例引用法规的歧义、适用版本判断仍要业务规则和复核。见 [字符串](https://surrealdb.com/docs/reference/query-language/functions/database-functions/string)、[数组](https://surrealdb.com/docs/reference/query-language/functions/database-functions/array)、[类型](https://surrealdb.com/docs/reference/query-language/functions/database-functions/type)。 |
| 导入 | 支持批量写入、SurrealQL 文件导入、Studio CSV；Surreal Sync 支持结构化来源和 JSONL。 | 这是把已取得的数据搬入库，不负责替任意网站生成解析规则。导入模式可能跳过 events/live 等副作用，不宜默认用它实现审核发布。见 [批量操作与导入](https://surrealdb.com/docs/learn/querying/concepts-and-guides/bulk-operations-and-data-import)、[JSONL 导入](https://surrealdb.com/docs/build/migrating/from-files-and-streams/json-lines)。 |

## 新站点是否可以免发布

有三种不同含义，不能混用：

1. **本地 Agent 获取新网站，输出既定成品格式**：服务端不改代码，成立。站点工作仍存在，只是由本地 Agent 的工具、提示或脚本承担。浏览器、下载、PDF/OCR 等能力属于本地运行环境，不能假定每个 MCP 客户端都具备。
2. **在数据库执行新的 HTTP 与清洗逻辑**：已允许的网络目标、已支持的响应格式可以不改应用服务代码；新域名可能仍需更新实例网络配置。脚本本身也是逻辑变更，仍应记录版本和结果，不能称为无适配。
3. **任意站点自动长期增量采集，无人维护**：没有从本次官方能力资料得到支持。分页、登录态、页面变化、断点、调度等还需外部执行者或专用实现。

后两项的网络前提见 [Capabilities](https://surrealdb.com/docs/learn/security/authorization/capabilities)。官方明确网络默认拒绝，可以按目标允许，配置作用在实例；远程客户端不能靠本地 CLI 参数替远端放开执行能力。因此，不宜为了新增站点方便而给共享租户数据库开放任意出站访问。

## 建议的首期边界（待规格采纳）

- 本地 Agent 负责找来源、取得资料、清洗和法条关联候选；MCP 只接收标准成品，不接收任意服务器执行脚本。
- 服务器提供少量业务工具：获取数据契约、提交批次、查看校验结果、查询已有版本/去重信息、发布已核验批次。
- 成品保留来源 URL、抓取时间、来源版本/标识、原文依据、内容摘要哈希、结构化正文、关联候选及不确定状态；不要求把任意网站解析器部署到平台。
- 幂等重试、版本冲突和发布状态由服务端掌握；上传成功不自动等于客户可见。运营本人可在本地复核后调用发布工具，不必首期建设复杂审核网页。
- 运营 MCP 的身份只授权内容维护范围。不要把 root 凭证交给本地 Agent，也不要把通用数据库写权限当作自动具备发布业务规则。
- 持续更新仍需要一个定时执行者；首期可以由本地定时任务/Agent 作业重复采集后提交。运营电脑离线时无法保证持续更新，此部署边界应明确展示。

以上建议不要求首期提供站点配置平台、通用爬虫编辑器或托管浏览器集群。若后来需要服务端无人值守采集，可复用相同成品契约再加入独立采集执行器。
