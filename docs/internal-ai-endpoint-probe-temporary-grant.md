# FV06 探针临时授权（单主体、≤30 分钟、可撤回）

只服务 `internal-ai.endpoint-probe`。不改 `PLATFORM_OPERATOR_CAPABILITIES` CSV，不给全体种子主体授能，不改永久 `platform_operator_capability` 行。

## 为什么需要

`seedPlatformOperators` 只补缺失；回退 CSV 不会撤回已落库能力，且 CSV 对全部种子主体全局生效。经理不批准不可撤回的 CSV 授能，因此探针能力走独立临时授权表。

## 部署配置

| 变量 | 含义 |
| --- | --- |
| `ENDPOINT_PROBE_TEMPORARY_GRANTOR_SUBJECT` | 可授予/撤回的运营 OIDC subject |
| `ENDPOINT_PROBE_TEMPORARY_GRANTEE_SUBJECT` | 唯一被授权主体（优先既有 LCA04_OPS） |
| `INTERNAL_AI_ENDPOINT_PROBE_ENABLED` | 探针开关，默认 `0`；与临时授权独立 |

两者必须同时配置且不能相同；未配置时控制面返回 503。生产值经 `ORIGIN_ENV_*` 下发，本仓库默认留空。

## 接口

均需有效运营会话（门槛能力 `quota.read`）；真正的 grantor/grantee 约束在服务内再校验。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/ops/internal-ai/endpoint-probe/temporary-grant` | 只读状态（grantor 或被授权主体） |
| POST | `/api/ops/internal-ai/endpoint-probe/temporary-grant` | 授予（≤30 分钟，幂等不续期） |
| POST | `/api/ops/internal-ai/endpoint-probe/temporary-grant/revoke` | 立即撤回 |

状态字段（脱敏）：`capability`、`subjectHash`、`status`（`active|revoked|expired|absent`）、`grantedAt`、`notAfter`、`revokedAt`、`version`、`permanentActive`。

### 请求语义

- 授予必须携带 `idempotencyKey`（1–128 字符）；撤回可选携带。
- 首次授予可省略 `expectedVersion`（等价 0）。
- 已有临时行（active/revoked/expired）时，重新授予必须携带当前 `expectedVersion`；版本不匹配返回 409。
- 有效期内的授予请求只登记请求标识，不改变 `notAfter`；同键重放在撤回、过期、重启后只返回当前状态，不重新授能。
- 同一 `idempotencyKey` 不能跨 grant/revoke 复用，否则 409。
- 重新授予必须有新的 `idempotencyKey`，并形成新的 `version`；旧键之后重放仍不会续期。
- 撤回携带 `expectedVersion` 时做条件更新；不携带时只撤回当前 active 行，但版本仍递增，因此并发旧授予无法覆盖撤回。

## 不变量

- 到期在权限检查时即时失效（`not_after <= now`），不依赖 sweep。
- 撤回/到期后，持有旧 token 的下一次请求即 403；与探针路由共用 `requirePlatformOperator` 读面。
- 读路径同时要求主体仍是 active `platform_operator`：主体被禁用或移除后，即使临时行仍 active 也 fail closed。
- 读路径只认当前配置的 grantee：配置改为 B 或清空后，旧主体 A 立即失效；同一时刻最多一个配置主体有效。旧行保留为审计记录，并受原始 `notAfter` 上限约束。
- 授予/撤回写入是数据库原子 CAS：`UPDATE ... WHERE version = $expectedVersion`（撤回还可带 `status = "active"`），并在同一事务内写入幂等请求记录；版本不匹配或唯一索引冲突会回滚并返回 409。
- `seedPlatformOperators` 拒绝 CSV 含 `internal-ai.endpoint-probe`；临时表不被 seed 写成永久能力。
- 若主体已有永久同名能力，`permanentActive=true`，临时撤回不会删它。**此时不能承诺临时撤回后探针一定 403**；永久能力仍可让主体通过能力检查（开关打开时）。
- 迁移 046（临时授权表）与 047（幂等请求表）都是只新增结构，不改写既有数据。

## 发布边界

实现与部署腿默认不授予生产临时权限、不启用探针开关、不发真实上游。实际授予/一次目录探针/立即撤回由既有执行任务在独立批准后进行。
