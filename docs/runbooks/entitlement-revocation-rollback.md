# 赠送撤销安全回滚 runbook（LCA13）

适用范围：PR #110（`task/0025dd4c`）合入后运行的 origin。该 PR 引入
`content_grant_revocation`（追加式赠送撤销）与读取端撤销过滤
（`SurrealProductEntitlementStore` 解析读取排除已撤销来源）。

核心事实：**撤销数据只新增、原 grant 行不可变**；旧代码（不含撤销过滤）
在解析读取时会**把已撤销赠送重新当作有效来源**（撤销复活）。因此回滚
策略以「是否存在撤销记录」为分界。

## 1. 回滚分界（merge-base）

- **兼容基线（merge-base）**：PR #110 的合并提交（合入 main 后由
  `git merge-base main task/0025dd4c` 之外的**第一个包含撤销过滤的主线
  提交**，即 #110 自身）。任何包含 `content_grant_revocation` 过滤的
  提交都属于"兼容集"。
- **判定命令**（对生产 `_system` 只读）：

  ```bash
  # ops_query（_system）或发布前检查：
  SELECT count() FROM content_grant_revocation GROUP ALL;
  ```

  结果为 0 → 尚无撤销记录，可按常规回滚（见 §3）。
  结果 ≥ 1 → 进入"撤销存在"状态，适用 §2 的禁止条款。

## 2. 撤销存在后的回滚政策（硬性）

- **禁止**回退到不含撤销过滤的任何提交（即 #110 合并前的全部主线
  SHA，含 5808b26、175ec09 等）。该类回退会使已撤销赠送**静默复活**，
  属越权访问事故。
- 允许的回退目标**只有**：包含撤销过滤的已过 Quality gate 提交
  （#110 合并提交及其后的 main 提交），即"只允许回退到保留撤销语义
  的已验证提交"。向前修复优先于回退。
- **不做**"兼容补丁回退点"（往旧版本补撤销过滤的特制提交）：它会
  制造一条从未在生产运行过的发布线，风险高于向前修复。若未来确有
  需求，另立任务评审后把补丁提交挂到本 runbook。
- 不得以改写/删除 `content_grant` 或撤销记录的方式"修复"兼容问题
  （迁移红线）。

## 3. 常规回滚路径（遵守 §2）

1. **自动回滚**：Deploy origin 健康检查失败时由 `origin-release.sh`
   自动恢复上一个 current——该"上一个"同为本次发布线上的过闸提交，
   满足撤销过滤前提；无需额外动作。
2. **手动回滚**：GitHub Actions `Deploy origin`，sha 填**上一个包含
   撤销过滤且 Quality gate SUCCESS 的提交**（`gh run list --workflow
   'Deploy production'` / `gh api …/check-runs` 核对），前端重跑同一
   sha 的 Deploy production。
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

## 4. 撤销复活应急（若 §2 被违反）

若生产意外运行了不含过滤的旧代码：

1. 立即按 §3.2 部署最新兼容 SHA（向前恢复过滤）；
2. 用 ops 通道对受影响 workspace 读 `content_grant_revocation` 与权益
   视图，确认已撤销来源不再生效；
3. 若复活发生在旧代码窗口内，按事故流程补审计说明（撤销记录本身
   无需改动——过滤恢复后语义自动收敛）。

## 5. 能力下发（发布准备）

- `ORIGIN_ENV_PLATFORM_OPERATOR_CAPABILITIES` 追加
  `entitlement.gift`、`entitlement.repair`（seed 启动只补缺失行，
  幂等）。合入前后执行皆可，但**先于**运营使用新端点。
- **读回验证**（不读密钥，走受控登录）：`ops_operator_login` 后查看
  viewer.capabilities 含 `entitlement.gift`、`entitlement.repair`；
  `GET /api/ops/product-entitlements/exceptions`（quota.read）可 200。
- **失败处置**：新端点 403 `operator_capability_denied` → 检查该
  secret 键与运营账号 `platform_operator` 行 status=active；补授后
  无需重启（能力每请求重读）。
- 只读探针（验收用）：`delivery-preview` 挂 `entitlement.repair`、
  零写入；`grants`/`revoke` 挂 `entitlement.gift`；`exceptions` 挂
  `quota.read`。
