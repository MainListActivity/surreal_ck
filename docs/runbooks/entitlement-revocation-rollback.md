# 赠送撤销安全回滚 runbook（LCA13）

适用范围：PR #110（`task/0025dd4c`）合入后运行的 origin。该 PR 引入
`content_grant_revocation`（追加式赠送撤销）与读取端撤销过滤
（`SurrealProductEntitlementStore` 解析读取排除已撤销来源），并在
`scripts/deploy/origin-release.sh` 内置**撤销兼容门禁**。

核心事实：**撤销数据只新增、原 grant 行不可变**；旧代码（不含撤销过滤）
在解析读取时会**把已撤销赠送重新当作有效来源**（撤销复活）。因此任何
发布/回滚目标都必须先通过撤销兼容性判定，不能由「发布顺序上的上一个」
推断兼容——首次 LCA13 发布的 previous（如 5808b26/175ec09）就不含过滤。

## 1. 兼容性判定（由部署脚本强制执行，非人工约定）

`origin-release.sh` 的 `require_revocation_compat` 在**每次切换 current
之前**（新发布激活与自动回滚两条路径共用）执行：

1. **目标含撤销过滤**（目标目录存在
   `server/src/product-entitlement` 下引用 `content_grant_revocation`
   的代码）→ 直接放行；
2. 否则运行受控检查器
   `server/src/db/grant-revocation-check-cli.ts`
   （在发布机本地执行，`bun run --env-file=$ORIGIN_ENV_FILE`，
   只读 `_system`，输出 `grant_revocations=<n>`）：
   - `n=0` → 放行；
   - `n≥1` → **拒绝激活该目标**，脚本非零退出、保持 current 不动；
   - 查询失败 → 按「无法证明安全」同样拒绝；
   - 目标与 current 均为门禁前版本（找不到检查器）→ 写入路径在结构上
     不存在，判定无撤销、放行。

判定紧邻 `point_to` 调用点，覆盖「健康检查失败到实际回退之间」与
「手动回滚前的撤销窗口」两个竞态间隙。门禁不调用 ops_query（生产
ops_query 面向 workspace 库，不保证 `_system` 可达），不依赖操作员
记忆任何命令——失败时日志出现 `revocation gate:` 前缀行。

## 2. 撤销存在后的回滚政策（门禁语义）

- 含撤销过滤的提交（#110 合并提交及其后的 main）永远可回退。
- 不含撤销过滤的提交：仅当 `_system` **无** `content_grant_revocation`
  行时可回退；一旦有撤销行，门禁拒绝，**保持失败发布不动**，按 §4 向前
  部署兼容 SHA 处理。
- **不做**"兼容补丁回退点"（往旧版本补撤销过滤的特制提交）：它会
  制造一条从未在生产运行过的发布线，风险高于向前修复。若未来确有
  需求，另立任务评审后把补丁提交挂到本 runbook。
- 不得以改写/删除 `content_grant` 或撤销记录的方式"修复"兼容问题
  （迁移红线）。

## 3. 常规回滚路径（门禁生效后）

1. **自动回滚**：Deploy origin 健康检查失败时 `origin-release.sh` 走
   `rollback()`——先过 `require_revocation_compat "$previous"`：
   previous 兼容则照常恢复；previous 不含过滤且已有撤销行则拒绝回退，
   发布失败、current 留在新（带病但兼容）版本，按 §4 处置。
   首次 LCA13 发布即受此约束：其 previous（5808b26）不含过滤，
   若健康检查窗口内已有撤销行则自动回退被拒——这是设计行为，
   向前修复而不是复活撤销。
2. **手动回滚**：GitHub Actions `Deploy origin`，sha 填**包含
   撤销过滤且 Quality gate SUCCESS 的提交**（`gh run list --workflow
   'Deploy production'` / `gh api …/check-runs` 核对），前端重跑同一
   sha 的 Deploy production。若误填旧 sha，同一门禁在主机侧拦截。
3. **ops 前端与 origin 的版本组合**：
   - ops 新于 origin：撤销/修复按钮对新端点 404——失败安全（无部分
     写入），读侧不受影响；把 origin 追平即可恢复。
   - origin 新于 ops：新端点/新字段被旧 UI 隐藏——安全降级。
   - 仅允许"同版本或更新 origin"组合长期运行；混合组合只作为过渡。
4. **回滚后验证探针**（只读）：
   - `GET /api/ops/product-entitlements/workspaces/:slug/delivery-preview`
     ——只读预览端点，验证权益视图可解析；
   - `GET /api/ops/product-entitlements/exceptions` ——异常队列可读；
   - `/health` 的 `quotaWorker` 段确认 worker 环路存活（另一修复线）。

## 4. 门禁拒绝激活后的处置

门禁拒绝意味着「该目标会把已撤销赠送复活」。此时：

1. 保持 current 指向当前（兼容）版本不动；若失败发布的进程仍在运行
   且带病，用 `Deploy origin` 部署最新的兼容 SHA 覆盖它（向前修复）；
2. 用 ops 通道读 `content_grant_revocation` 与权益视图，确认撤销语义
   在运行版本上生效；
3. 记录门禁拒绝事件（发布日志 `revocation gate:` 行）到事故说明。

## 5. 能力下发（时点硬约束）

`entitlement.gift` / `entitlement.repair` 通过
`ORIGIN_ENV_PLATFORM_OPERATOR_CAPABILITIES` 追加下发；seed
（`server/src/db/platform-operator-seed.ts`）是 `platform_operator_capability`
的**唯一写源**，只补缺失行、幂等，不静默恢复已禁用/已收回行。

**时点**：必须在**含门禁的本次发布已在生产运行**（门禁生效）之后再
下发这两项能力。逻辑闭环：能力未下发→`/grants`、`/revoke` 一律 403
`operator_capability_denied`→`content_grant_revocation` 结构性为空→
门禁天然放行一切回退；能力下发后→撤销可随时发生→门禁保证不再回退到
会复活撤销的代码。先授权后部署的顺序会使「首次发布失败回退」恰好落进
唯一不受保护的窗口，因此顺序不可颠倒。

**读回验证**（不读密钥，走受控登录）：`ops_operator_login` 后查看
viewer.capabilities 含 `entitlement.gift`、`entitlement.repair`；
`GET /api/ops/product-entitlements/exceptions`（quota.read）可 200。
下发前的基线事实：现有 operator 均无此两项能力（合入前已用
`ops_operator_login` 读回证实）。

**失败处置**：新端点 403 `operator_capability_denied` → 检查该
secret 键与运营账号 `platform_operator` 行 status=active；补授后
无需重启（能力每请求重读）。

只读探针（验收用）：`delivery-preview` 挂 `entitlement.repair`、
零写入；`grants`/`revoke` 挂 `entitlement.gift`；`exceptions` 挂
`quota.read`。
