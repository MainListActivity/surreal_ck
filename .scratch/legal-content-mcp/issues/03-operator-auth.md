Status: done
Label: verified
Assignee: unassigned
ID: SCK-LCM-03
Repository: surreal_ck

# 统一运营身份与数据维护授权

Parent: [实施规格](../PRD.md)

## Dependencies

- [02-content-schema](02-content-schema.md)

## Scope

- 在 server/src/ops/ 集中运营授权入口，复用 platform_operator/capability，增加内容 read/submit/publish 等明确能力。
- 同 issuer 下以可信 sub 绑定运营，ops/MCP 不走客户 workspace db/ac hook；客户登录保持现有行为。
- 新增独立 audience 验证配置，不放宽现有客户 API token 校验；每次操作读取当前运营能力，错误时拒绝。
- 配置初始化、禁用与撤销能力的审计；不用 system_admin 创建开关充当运营 allowlist。

## Acceptance

- [ ] 无 workspace 的有效运营可以访问控制面，普通客户/付款管理员被拒绝。
- [ ] 错误 audience、伪造主体、禁用运营、撤销能力后的旧 token 都不能操作。
- [ ] 读权限不自动包含发布权限；异步执行前重新核验调用者资格。

## Handoff

- 实施前读取仓库 AGENTS.md 和相关技能；SurrealQL、Mastra 等按任务实际涉及加载。
- 完成后记录改动、验证命令与结果及剩余限制；依赖完成后将下游转为 open/ready-for-agent，不提前声明交付。
- 本票只授权自身实现范围，不隐含线上部署、真实来源商用发布或外部账号配置修改。

## Implementation evidence

- `server/src/ops/operator-auth.ts` 将运营 audience 与客户 audience 分离，按请求验证 OIDC issuer/audience，并实时查询 `platform_operator` 与 active capability；禁用运营或撤销能力会立即拒绝旧 token。
- `shared/src/native-quota/control-plane.ts` 与 system migration 014 增加 `content.read/submit/publish/withdraw/restore/source.manage` 能力，未复用 `system_admin` workspace 创建开关。
- `createOpsQuotaRoutes` 默认改用运营身份 middleware；测试注入的 middleware 仍可用于纯路由单测。
- 验证：运营 auth 测试 1 pass；既有 OIDC/ops route 测试 8 pass；server typecheck 通过；migration 014 经 Surreal CLI validate。
- 限制：IdP DCR/resource indicator 和实际 MCP endpoint 由 ma_hono IDP-OM 与 SCK-LCM-07 实施；内容表的细粒度 publisher PERMISSIONS 在 SCK-LCM-05 接收入口时落地。
