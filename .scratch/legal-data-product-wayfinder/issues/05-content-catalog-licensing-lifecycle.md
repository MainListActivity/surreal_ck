Status: done
Label: done
Assignee: product-architecture

# 设计平台法律内容目录、版本与授权生命周期

Parent: [`律师行业订阅与平台法律数据产品决策地图`](../PRD.md)

## Question

平台法规、案例和实务资料如何作为跨工作区的平台内容持续更新、版本化、撤回、勘误和授权，而不被复制成用户可以修改的工作区记录？

## Dependencies

- [`定义 Plus / Pro / Max 的可完成工作与权益矩阵`](02-plan-outcome-entitlement-matrix.md)
- [`拆分内容访问、资源容量、AI 额度与功能能力`](03-entitlement-domain-model.md)

## Expected decision

- 定义内容产品、案例集、内容版本、来源、授权范围和发布状态。
- 确定平台内容与 workspace database 的物理边界及访问路径。
- 定义更新、撤回、勘误、来源追踪和内容授权到期语义。
- 明确平台内容不计入用户自建 table、field、record 配额。

## Source audit

- 当前 `resource_item`、`resource_embedding` 和 `research_session` 都位于各 workspace database，工作区成员可按现有 PERMISSIONS 创建和更新，工作区管理员还拥有 DDL 能力。
- `legal_case`、`legal_article` 目前只是共享类型中的预留 resource type，并没有平台级案例目录、内容授权或不可变版本实现。
- 当前资源检索及引用只认识本工作区的 `resource_item`，因此不能直接承载一份跨工作区授权、平台持续更新且可撤回的案例主库。
- 把平台案例复制到 workspace database 会造成内容可篡改、重复存储、更新扇出、授权撤回困难和引用版本不稳定；该路径不作为候选方案。

## Decision

### 1. 三个数据边界

```text
_system control plane
  商业套餐、内容权益、workspace 内容授权投影状态

platform legal content database
  来源、许可、法规/案例、不可变版本、数据集发布、检索索引

workspace database
  用户上传资料、批注、收藏、研究报告、平台内容引用指针
```

- 平台法律内容放在独立的 SurrealDB content database，不放 `_system`，也不复制到 workspace database。
- `_system` 继续只保存商业权威、权益快照和内容授权投影的同步状态，不保存案例全文或向量。
- workspace 内的 `resource_item` 继续表示用户或团队自己的资料；它与平台内容是两个资源域。
- workspace 可以保存不可变平台内容 ID、精确版本 ID、引用定位、用户批注和派生成果，但不能把平台全文伪装成用户可编辑记录。

### 2. 内容目录模型

| 概念 | 作用 | 可变性 |
|---|---|---|
| `content_source` | 来源机构、渠道、抓取/交付方式和出处信息 | 稳定身份，配置版本化 |
| `source_license_revision` | 许可范围、地域、期限及 search/read/cite/AI/export/API 动作 | 发布后不可变 |
| `content_item` | 一部法规、一份司法文书或一项实务内容的稳定逻辑身份 | 稳定身份，可推进 current version |
| `content_version` | 某一时刻的正文、结构化字段、来源快照和内容哈希 | 不可变 |
| `dataset` | 平台内部的采集、整理或授权供应单元，即后台“案例集” | 稳定身份 |
| `dataset_release` | 某次发布包含的精确内容版本集合与质量报告 | 发布后不可变 |
| `content_collection` | 套餐或专业模块引用的稳定内容范围，例如核心法规、核心案例 | 稳定身份，发布版本化 |
| `publication_event` | 发布、纠错、替代、撤回、恢复和删除要求的事实记录 | 追加写 |

`content_item` 的“现行版本”、法律效力状态和平台发布状态是三个不同概念：法规在法律上失效不等于平台删除；平台撤回也不改写原始法律事实。

### 3. 持续更新与版本语义

- 内容先进入 staging，经来源校验、许可检查、结构校验、去重、质量检查和哈希固定后才能发布。
- 正文或结构化内容发生任何修订都创建新的 `content_version`；已经发布的版本不原地更新。
- `dataset_release` 固定精确版本成员及其哈希，支持重放、审计和回滚；current pointer 只是发布索引，不替代不可变历史。
- 普通纠错发布新版本并记录 `corrects` 关系；来源新版本记录 `supersedes` 或法定沿革，不能混成平台纠错。
- 撤回通过追加 publication event 和更新可服务投影完成：停止新搜索、全文读取及 AI 使用，但保留受限审计副本。依法必须物理删除时保留最小 tombstone、原因和不可逆删除证明。
- 每个搜索结果和引用都携带内容版本、来源、dataset release、抓取/交付时间和平台发布时间。

### 4. 滚动授权而非逐次向所有工作区发新快照

- `content_entitlement` 授权稳定的 `content_collection` 及允许动作，不直接枚举数百万 content version。
- 默认使用 `release_policy=rolling`：只要工作区授权仍有效，就自动看到 collection 后续合规发布，不需要每次新增案例都重算所有工作区权益。
- 企业固定交付或证据封存可以使用 `release_policy=pinned`，指向具体 collection/dataset release 或截止时间。
- 请求开始时固定工作区 content entitlement revision 和实际查询到的 release/version；全局 collection current release 更新不会改变已返回引用。

### 5. 许可上限与客户授权取交集

来源许可至少分别声明：

- metadata search；
- full-text read；
- quote/cite；
- AI retrieval/context use；
- derived answer/report；
- manual export；
- bulk/API/MCP access；
- retention、attribution、territory 和有效期。

客户的 content entitlement 不能授予超过 `source_license_revision` 的动作。发布编译和请求授权都取“来源许可 ∩ 平台发布状态 ∩ 工作区内容访问权”，任一事实未知或过期时 fail closed。运营 override 不能绕过来源许可。

### 6. 客户读取路径

- 浏览器在保留 workspace database 直连的同时，为平台内容建立第二条短期 `content_reader` 会话；现有 workspace token 不直接获得内容数据库权限。
- Workspace Scope Module 根据当前 workspace 的内容权益换取短期 content token。token 只携带 subject、workspace 和授权 revision 身份，实际允许的 collection/action 由内容数据库内的只读授权投影决定，不把完整授权列表塞进 JWT。
- `content_reader` 使用 RECORD 身份并忽略 workspace admin token 中的 system role；任何工作区管理员都不能获得平台内容 DDL/DML。
- 服务端智能体使用同一调用者对应的短期 content session 查询平台内容，请求路径不得使用 SurrealDB root 读取案例。
- 权益 resolver 将 `_system` 的 content entitlement 以可重试、可核验方式投影到内容数据库；投影延迟或不一致时拒绝扩大访问。

### 7. 内容发布身份

- 平台内容写入使用 content database 内单独的 `content_publisher` RECORD access；它只允许向预定义 staging/ingestion/publish 流程执行 DML，不拥有 DDL。
- publisher 每个批次以受保护 secret SIGNIN 获取短期会话，用完即关闭；它不是 service JWT，也不是 workspace 虚拟员工身份。
- SurrealDB root 只负责 content database schema、迁移、publisher credential 创建/轮换和灾难恢复，不进入日常采集、发布或客户查询路径。
- 发布动作记录 publisher 身份、输入 release、许可 revision、校验结果、时间和 correlation id。

### 8. 工作区保存与配额

- 平台 content item、version、dataset、release、embedding 和授权投影都不计入任何工作区的 table/field/record 配额。
- 用户在 workspace 保存的收藏、批注、案件关联、引用卡片和研究报告属于用户数据，按对应 `ent_` 表规则计入工作区资源配额。
- 保存引用只保存平台 content/version ID、定位和必要展示元数据；全文仍从内容数据库按当前权限读取。
- 用户可以删除自己的引用或批注，但不能删除、修改或伪造平台内容版本。

### 9. 与后续任务的边界

- 智能体如何组合平台内容与用户私有材料、如何排序和生成引文，由 06 号任务决定。
- 试用用户能看到多少元数据、全文和示例，由 07 号任务决定。
- 套餐到期后历史引用与报告如何展示，由 08 号任务决定。
- 本任务不选择具体内容来源，不实施爬取，也不对未经确认的数据许可作法律判断。
