Status: blocked
Label: needs-triage
Assignee: unassigned
ID: SCK-LCM-04
Repository: surreal_ck

# 建立独立 ops 应用并迁移已有配额运营台

Parent: [实施规格](../PRD.md)

## Dependencies

- [03-operator-auth](03-operator-auth.md)

## Scope

- 根目录 ops/ 独立 pnpm workspace、入口、登录、构建和部署配置；默认复用现有 Svelte/Vite 技术以减少迁移，允许经证据调整选型并记录。
- 迁移 QuotaOperationsScreen 与已有运营 API，领域服务继续复用 quota，不复制订阅规则。
- 补全工作区分页和状态筛选含 archived，不依赖本人 membership；客户数据表读取不在本票授权范围。
- 独立 IdP client、回调及无 workspace 登录；旧入口在新端验收后退役，保留明确迁移提示。

## Acceptance

- [ ] 独立 build/typecheck 通过，客户 web 不导入 ops 组件，跨包依赖使用 workspace:*。
- [ ] 已有计划查看/操作结果等行为不退化，普通用户直访被后端拒绝。
- [ ] 分页无漏项/重复并可查归档工作区，登录返回 ops 而非客户 workspace。

## Handoff

- 实施前读取仓库 AGENTS.md 和相关技能；SurrealQL、Mastra 等按任务实际涉及加载。
- 完成后记录改动、验证命令与结果及剩余限制；依赖完成后将下游转为 open/ready-for-agent，不提前声明交付。
- 本票只授权自身实现范围，不隐含线上部署、真实来源商用发布或外部账号配置修改。

