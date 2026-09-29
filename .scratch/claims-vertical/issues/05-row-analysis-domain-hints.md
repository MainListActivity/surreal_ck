Status: ready-for-agent
Label: ready-for-agent

# CV-05 — 行分析领域提示与通用命名收口

## Parent

`.scratch/claims-vertical/PRD.md`

## What to build

行分析按当前工作簿关联的模板记录读取可选领域提示，在每次运行时装配进 Mastra instructions；无模板、模板被删或提示为空时静默回到通用行分析。所有读取通过调用者 `context.surrealSession`。字段补全仍是提案，须用户确认后写回。将 `claim-analysis` 的文件名、agent id、Router 类目、tool 名和用户可见描述统一改为 `row-analysis` 口径，并处理旧会话／存储中的路由兼容。

先加载仓库 `mastra` skill 并核对安装版本 API。复核 OIP-17 及 `server/ai/mastra/agents/claim-analysis-agent.ts`：运行期模板提示与确认卡已有实现，重点补齐通用命名、tool 描述残留、模板删除回退及兼容性，不重新发明提示来源。模板关联当前采用 `workbook.template` 记录引用；若它满足按模板定位，沿用该事实。

## Acceptance criteria

- [ ] 有提示时仅当前工作簿本次运行的 instructions 含对应领域内容；其它工作簿、无提示或模板缺失时只含通用说明且不报错。
- [ ] 平台代码、prompt、Router 分类与 tool 描述不带法律语义；旧 `claim-analysis` 运行记录或客户端请求有明确兼容／迁移验证。
- [ ] 分析建议含依据，字段变更经用户确认才执行；数据库读取始终使用调用者会话。
- [ ] fake session／fake LLM 的行为测试覆盖有提示、无提示、删除模板和确认前零写入，不调用真实模型。
- [ ] 更新 `CONTEXT.md`：模板包是 `workbook_template` 行，并定义行分析的领域提示术语。
- [ ] 最高约束：仓库代码、平台 schema、平台 prompt 不得出现法律领域词汇；法律内容必须能经不 seed／删除模板行整体移除。

## Scope handoff

领域提示文本只由 CV-02 的模板数据提供；本票只负责通用加载、装配与命名迁移。若需改变现有 Router 协议，交接中列出兼容测试和调用方清单。

## Blocked by

- `.scratch/claims-vertical/issues/01-template-package-schema.md`
- `.scratch/claims-vertical/issues/02-claims-pack-and-seeding.md`
