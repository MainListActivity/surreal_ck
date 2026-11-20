# 061 成员身份防护回归

2026-11-10，在应用 a39f2e1 基线上追加 061；历史迁移未改动。仅 loopback 内存数据库、本地临时 JWKS 和随机 fixture 凭据，无 `.env`、生产 token、生产连接或部署。使用官方用户 fork `3.3.0-native-quota.1+sha.f30704bce914`，Bun 1.3.12 / surrealdb 2.0.8 / jose 6.1.3。schema 完整加载 001–061（测试明确忽略后续迁移，后续信令需要单独联合验收）。

## 变更

- user 表不再根据 RECORD 主体可变的 is_admin 放宽成员管理权限。JWT Owner / root 的系统 RBAC 保留既有控制面能力。
- email、subject、kind、is_admin、disabled_at、岗位与主管字段的 RECORD update 权限关闭；字段拒绝可能表现为保留旧值而非抛异常。
- UPDATE 事件补充身份不变约束及自身 status 冻结；045 的 PM 激活守卫保留。事件不承担 JWT Owner 授权判断。
- participant/admin 重新认证拒绝已停用或非 human 的既有主体；employee SIGNIN 和 AUTHENTICATE 增加停用检查。
- 保留首次认证创建分支；修复 admin AUTHENTICATE 意外返回 CREATE 记录的问题，末尾显式 RETURN NONE。首次 participant/admin 正例均通过。本变更不重新设计成员引导与索引协调。
- index.ts 自动发现增量，无需手动注册；最终合并应更新 index.test.ts 的最新版本断言。

## 实际结果

`regression.log` 保存最初防护测试结果：CLI validate 通过；2 通过、0 失败、32 断言。

当前完整结果见 `first-authentication-fixed.log`：固定 fork CLI validate 通过；**4 项测试通过、0 失败、36 断言**。首次 participant 创建 human/is_admin=false，首次 admin 创建 human/is_admin=true，均为各自第一次 authenticate 成功，不以重试绕过。

历史失败保留在 `first-authentication.log`：添加首次登录正例时 3 通过、1 失败，admin 返回 NotAllowed/-32002/Auth。核验精确 fork commit 后，在 061 的 admin AUTHENTICATE 末尾加 RETURN NONE，其他认证与角色/停用判断不变。原始防护日志和失败日志是阶段证据，不代表当前最终状态。

### JWT 返回值合同依据

- 固定 commit `f30704bce91412b14a9d4be96809786d83c1a858` 的 `surrealdb/core/src/iam/access.rs:61–76`：authenticate_generic 仅在求值结果为 PublicValue::None 时成功，其他值返回 InvalidAuth；`verify.rs:376` 的 JWT 分支调用此函数。此次直接通过本地 git show 读取该 commit，而非使用工作树的新版本推断。
- [固定 fork 源码](https://github.com/MainListActivity/surrealdb/blob/f30704bce91412b14a9d4be96809786d83c1a858/surrealdb/core/src/iam/access.rs#L61-L76)。
- [官方 DEFINE ACCESS 文档](https://surrealdb.com/docs/reference/query-language/statements/define/access) 对 JWT AUTHENTICATE 要求无返回值；RECORD 的返回记录身份合同不同，不能把 participant 的 RETURN record 套到 admin。
- 最小修复只消除 CREATE 的意外块结果，不改变签名验证、JWKS URL、已有 claim/角色语义或停用拒绝，不增加认证重试。

覆盖：

1. participant 本人逐项修改 subject/email/kind/is_admin/disabled_at 后持久值不变。
2. 本人 MERGE（含嵌套岗位/主管/status）、PATCH、CONTENT 不能改变身份。
3. display_name/avatar 合法更新成功。
4. 控制面停用后既有 participant 会话不能清除 disabled_at、写 is_admin 或修改 display_name；重新认证失败。
5. JWT Owner 创建/角色变更/停用成员、root 恢复成员成功。
6. PM 自身 status 修改抛错并保持 active；PM 创建并激活自己主管的 data-analyst 成功。
7. 停用 employee SIGNIN、停用 admin 重新认证失败。
8. 首次 participant 与首次 admin 创建正例均通过，未预建这两位测试用户，也未在失败后重新登录。

业务断言用独立 JWT/RECORD 会话；root 仅加载 schema、准备/停用/恢复 fixture，以及核验停用后持久值。测试退出关闭所有连接、进程和 JWKS。

第一次测试把 disabled_at 的静默拒绝误判为失败，随后修正为核验持久值；初始日志仅表示当时的防护覆盖通过；首次 admin 的失败及合同修复另有完整日志。最终 4 项通过仍不能扩展为全面安全证明。

## 验证命令

在已安装仓库测试依赖的环境：

```sh
surreal validate shared/sql/workspace-template/061-member-identity-guard.surql
SURREAL_BINARY=/path/to/verified/fork pnpm --filter @surreal-ck/server exec bun test src/db/member-identity-guard.integration.test.ts
```

本次使用隔离 probe 最小依赖运行同一测试文件；迁移与测试副本内容一致。未整仓安装或运行全仓 typecheck/lint。格式化器 `@surrealdb/surql-fmt 0.1.0-beta.3` 已实际尝试：初次不支持权限分隔逗号；去掉等价可选分隔后停在 `DURATION FOR TOKEN 1h, FOR SESSION NONE` 附近（位置 4487）。保留有效 session 语义，不为 formatter 改安全定义；不能声称 formatter 通过，最终以固定 fork CLI 语法验收为准。

## 未覆盖与发布前条件

- 未重试曾被阻断的跨用户越权、DDL 升级或 reconciler 索引复活探测。
- 不是全库会话撤销：旧 JWT Owner 会话仍有系统权限；其他表的历史 is_admin 判断未在此迁移全面重构。旧会话撤销、LIVE、并发竞态、真实 IdP refresh/scope exchange 和成员索引一致性另行验收。
- 上线前需审计既有 user 的 subject/kind/is_admin/disabled_at/岗位字段，与可信控制面/审计依据对齐。不能假定修复会自动清除旧异常身份。
- 需确认所有 workspace 应用增量、schema 版本与引擎契约匹配；受影响字段编辑 UI 应识别静默拒绝，不能误报更新成功。
- 061与062完整模板联合回归已通过；仍需要完整类型检查/lint与部署审批，不能凭此开启生产 native signaling。

## 回滚

优先前向修复。不要修改历史迁移、直接降 schema_version 或删除 061：恢复旧 user 权限会重开已知缺陷。若增量造成兼容问题，应保持相关入口关闭，保存 schema/数据备份和版本证据，评审追加修复迁移；必要的维护回退仅在隔离访问并经审批后恢复此前定义。本次没有实施任何回滚或部署。

## 独立整合复验

2026-11-10：相同固定fork与内容一致的隔离probe副本，身份4测试和模板47测试合计51通过、342断言；见 `independent-integration-final.log`。初轮模板单测旧占位符计数失败保留于 `independent-integration.log`，修正计数后全部复跑。061/062 CLI validate通过。完整001–062信令36项行为及真实121秒到期通过，详见 native-signaling/FORK-RULES-RESULT.md。仍未部署或开放企业认证信令。
