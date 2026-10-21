# 发布恢复收口交接（工具收口 / 文档与测试，2026-10-21）

配套 `docs/runbooks/production-release.md`。本文汇总 G5 十七行映射、合入与 CI、准入开关、直接版本读数、未闭合项与回滚/值班。

口径：**本收口链只交付工具、文档与测试**。它不批准 origin 首次激活，不启用自动发布，不执行生产故障注入或真实迁移。G4（主机实跑）与首次激活相关门禁保持未闭合。

## 一、G5 十七行映射（R1–R8、V-a–V-i）

状态取值：允许（有限范围）/ 部分满足 / 已修复并合入 / 未证实 / 不适用。
证据级别分三栏说明：**代码修复**（已合入 main）、**执行级测试/替身**（隔离 harness）、**真实主机**（未验证则明确写）。

| 编号 | 要求 | 当前状态 | 代码与提交 | 测试/证据 | 验证级别与边界 |
| --- | --- | --- | --- | --- | --- |
| R1 上传、校验、准备完成前不停旧服务 | 允许（有限范围） | `origin-release.sh` `run_release`：解包 → previous 预检 → 依赖安装 → 撤销预检 → 静态门禁 → env → 停服（钩子/撤销门禁） | `origin-release-upload.test.ts`（上传步骤只 scp、失败清理）；faults 依赖安装/解包失败零服务变更 | 执行级；主机未跑（G4） |
| R2 连接失败有真实可核结果、已知 previous、回滚路径 | 部分满足（F1 代码已闭合，主机未验） | `f53d080c` 预检与 `rollback_refuse`、`6df8d938` previous 判定、`83071190` 先恢复 env 再拉起；GM v30 第 2 项确认 hold | faults F1 段；gate 整段仿真（ENVSNAP） | 代码+执行级；`rollback-failed` 且服务停止按事故处理 |
| R3 ssh 中断不当作远端成功或回滚 | 允许（有限范围） | `origin-release-ci.sh` state 未知即等待/失败 | `origin-release-ci.test.ts` 断线与截止用例 | 执行级 |
| R4 脱离连接执行的激活、健康、回滚经既有受审 CI 脚本 | 允许（静态） | `deploy-origin.yml` 上传只 scp；`origin-release-ci.sh` 收敛；`nohup` 工作进程 | workflow-contract 与 lifecycle 用例 | 静态+执行级；主机未跑 |
| R5 不改 `surrealdb.service`、root、数据目录 | 允许（窄定义）；钩子 root 为受控例外 | G3 atime/元数据检测（PR #205 `45fd50b3`）；runbook 明示钩子以 root 维护身份连接 | faults G3 11 项；本次新增 `migrate-legacy-cli-boundary.test.ts` | 执行级；**主机级 G3 未证实** |
| R6 主机诊断只经审核的只读白名单 | 不适用 | 条件未触发 | 静态核对 | — |
| R7 并发互斥、幂等、前后 SHA、日志可见 | 已修复；GM v30 第 5 项接受代码与测试层闭合 | `f53d080c` `lock.reclaim` 互斥、互斥内重核、原子移出 | faults F13（5 轮双 `--launch`） | 代码+执行级；主机 `mkdir`/`find -mmin` 归 G4；**不把旧 `6df8d938` 整体 return 写成整体 accept** |
| R8 无法核根因时先做可验证保护、不伪造根因 | 允许（脚本） | 截止未知 `exit 1`，文案不称成功或回滚 | CI 截止用例 | 历史根因 `39153839203` 未证实 |
| V-a 负例：未合入/未过 Quality gate/origin 不匹配 | 允许 | `release-target-gate.sh`、`frontend-recovery-gate.sh`、`origin-verification.py` | 对应单测 | 静态+执行级 |
| V-b origin 失败时前端不无条件发布 | 允许 | `frontend-recovery-gate.sh` health 判定 | degraded/curl 失败用例 | 执行级 |
| V-c frontend-only 无 origin 调用 | 允许 | `release-frontend-recovery.yml` 无 ssh/scp/systemctl | workflow-contract | 静态 |
| V-d 上传失败不停止旧服务 | 允许（执行级） | 上传步骤 trap 先于首个 scp | `origin-release-upload.test.ts` 首/中/末 scp 失败+变异 | 执行级；生产未注入 |
| V-e 失联或健康失败后有界、可核的恢复结果 | 部分满足（F1 闭合，主机未验） | 同 R2；CI 截止 1200s、job 30min | CI 截止 + faults | 执行级 |
| V-f shell/CI 输入校验、并发、幂等 | 允许（并发子项 R7 已闭合） | CI 参数先校验；远端 `printf %q`；sha 40 位小写 | CI 参数校验与转义用例 | 执行级 |
| V-g 原 Quality gate 保持，新 head 全绿 | 允许（本轮） | 工具合入：PR #204 CI `39432760532`、PR #205 CI `39495764215`、main `39509366116` 均成功 | GitHub Actions | 本轮文档/测试 PR 的 CI 与合并 SHA 在合入后补记；绿灯不证明 F1/F4/G4 已闭合 |
| V-h 新增诊断不读秘密 | 允许（静态与运行断言） | state 白名单、env 只打印键名 | faults `expectNoSecrets` | checker 错误文本进日志，未做脱敏专项 |
| V-i CI 固定公司 fork 规则不退回上游 | 未证实（部分） | 工作流静态核对无上游引用 | 静态 rg | 未逐个核对全部手动入口 |

### 其余发现项（不重开、不误当未知）

- **F2（撤销检查器失败关闭）**：PR #204 已修复并在 main：先由 `INFO FOR DB` 判定撤销表是否存在，计数严格解析，错误与超时以退出码 2 结束。**已代码闭合**，不再当作未知；不因前次复核的单项通过而当成整体通过。
- **F1**：GM v30 第 2 项确认 hold 为安全失败关闭策略。
- **F4**：GM v30 第 3 项选定 main 版 `IfNeeded`、root 维护身份为限定受控例外、本轮不批准停服窗口；生产 marker 未核（能力缺口，见下）。
- **F8/F10**：失败后受控读回与交接规则已写在主 runbook。
- **G4**：未执行。GM v30 第 1 项接受收口阶段的残余验证边界，但不满足恢复自动发布条件，也不宣称主机安全。
- **N1**：HTTP/2 framing error（GM v30 第 6 项定义），原因未知、保留 open。
- **H1/H2**：未执行。
- **历史根因 `39153839203`**：未证实。
- **R7/F13**：代码与执行级回归已闭合（GM v30 第 5 项）；主机未验。

## 二、合入、CI 与准入开关（历史读数截至 2026-10-21T06:53Z；PR #206 合入时点 2026-10-21T08:10:30Z 另列于下表）

| 对象 | 值 | 核对方式 |
| --- | --- | --- |
| PR #204 受审头 / 合并提交 | `f9182f4f161ffa8b8c8784ad0e634cbc139587d8` / `03d686728d1b9897583113e7529cd8211f268e85` | GitHub 只读 |
| PR #205 受审头 / 合并提交 | `45fd50b33c74985ae9371dfd1959361dba767ced` / `5db5e18bb4848cb49f100c7ea617731a5830e32a`（合并树 `5ba27ea8…` 与受审头一致） | GitHub 只读 |
| 历史 main 快照（2026-10-21T06:53Z；含 PR #204/#205 工具合并） | `5db5e18bb4848cb49f100c7ea617731a5830e32a` | `gh api git/ref/heads/main`（历史值；其后 PR #206 于 2026-10-21T08:10:30Z 合入 `2e4b8c46…`，CI `39567292377`，见下两行） |
| main Quality gate | run `39509366116`，success（push） | `gh api actions/runs/39509366116` |
| PR #205 Quality gate | run `39495764215`，success（pull_request，ubuntu-24.04） | 同上 |
| `Deploy production` | workflow `362937295`，`disabled_manually` | `gh api actions/workflows/362937295` |
| 收口文档+测试 PR（PR #206） | 受审头 `0b152b14…` / 合并提交 `2e4b8c46aa575d5b7bc2ccd31e2806c2de9e0f59`（2026-10-21T08:10:30Z，合并树与受审头一致） | GitHub 只读 |
| PR #206 合并后 main CI | run `39567292377`（push）success | `gh api actions/runs/39567292377` |
| QA 退回后的文档/测试补修 PR | head/合并 SHA 与 CI 待合入后补记 | 本 PR 描述 |

工具 SHA 与应用 SHA 分记：被批准的工具版本只取 PR #204 合并提交 `03d686728d1b9897583113e7529cd8211f268e85` 与 PR #205 合并提交 `5db5e18bb4848cb49f100c7ea617731a5830e32a`；PR #206 合并提交 `2e4b8c46aa575d5b7bc2ccd31e2806c2de9e0f59`（2026-10-21T08:10:30Z，CI `39567292377`）与 PR #207 未来的 doc/tests 合并属于文档/测试分栏，**不是**新的工具批准，也不得把任意最新 `main` 当作工具版本。生产 origin 的应用版本是 `50663e3a6c89ee9a61a25eddf334a682c445bee1`（见下），不得把新 `main` 当作生产 origin 的应用 SHA。

## 三、直接版本读数（2026-10-21T06:53Z）

来源与过程（如实记录全部登录调用）：本任务有效租约内共 3 次 `ops_operator_login`（`LCA04_OPS`），其中 2 次成功：

1. 2026-10-21T06:44:14Z：第一次登录失败，token exchange 连接超时（代理上游错误）。
2. 06:45:16Z：第二次登录成功；但脚本未保住该会话句柄，未用该会话读取版本。该会话在 06:52:56Z 才被补登出（`closed:true`），距登录约 7 分 40 秒。重试发生在失败后约 38 秒，**少于 GM 裁定要求的 ≥60 秒**，属流程偏差。
3. 06:53:24Z：第三次登录成功；06:53:26Z 用同句柄 `GET /api/ops/runtime-version`（HTTP 200），06:53:40Z 读公开 `runtime-version.json`，06:53:44Z 读 canonical `/health`，06:53:45Z `ops_logout` → `{"closed":true}`。

`ops_logout` 只 drop 代理侧会话句柄，不等于全局 IdP 注销；本轮未核全局 IdP 会话。

| 对象 | 读数 |
| --- | --- |
| serverTime | `2026-10-21T06:53:26.508Z` |
| origin | `state=known`，`sha=50663e3a6c89ee9a61a25eddf334a682c445bee1`，`deploymentId=39153379368-1` |
| web | `state=known`，`sha=50663e3a6c89ee9a61a25eddf334a682c445bee1`，`deploymentId=39248415340-1` |
| 公开 `runtime-version.json` | 同一 SHA 与 `deploymentId=39248415340-1`（HTTP 200） |
| canonical `/health` | HTTP 200，`status=ok`，`surrealdb=up`（quotaWorker 各 loop ok） |

这只是版本读数，不是发布，也不是 G4。历史样本（例如 618 QA 的 50663e3a 读数）与本轮分开记录；本轮读数有 UTC 时间与原始脱敏响应。

## 四、未闭合项与能力缺口

1. **G4 主机实跑**：未执行；收口阶段接受残余边界，但不满足恢复自动发布。
2. **首次激活**：保持阻断。原因：生产 `content_migration_state:legacy` marker 未核；停服窗口未批准（GM v30 第 3 项）；需针对准确 head 的另一次上线申请。
3. **marker 能力缺口**：ops 工具面没有 `CONTENT_DATABASE` 中 `content_migration_state:legacy`（字段 `source_database`、`verified_at`、`summary`）与 `platform_content_schema_version:current` 的受控只读读取工具；`ops_query` 客户会话不能进入 `_system`/内容控制面，运营会话不裸查 SQL。需要新增受控只读工具后由运营核对；不得把无能力解释为 marker 不存在。
4. **N1**：HTTP/2 framing error，原因未知，open。
5. **H1/H2**：未执行。
6. **`39153839203` 历史根因**：未证实。
7. **生产 SurrealDB 构建**：未记录；启用前由运营只读记录。
8. **project.release / project.rollback 元数据差异**：以主 runbook 为准；由 GM 通过受控条目更正。
9. **旧 LCA04_OPS 句柄**：已过代理报告 TTL，未执行 logout、未核全局 IdP 会话。
10. **PR #36/#55/#160**：保持未合入。

## 五、回滚与值班

- **本收口 PR 的建议回滚**：受审 revert 本 PR 实际合并的文档与测试变更（`git revert -m 1 <本 PR 合并提交>`；若为 squash/rebase 则 revert 实际合并提交），不 reset、不 force push、不手改 `main`；不重启健康的 origin。
- **生产 origin 回滚**：合法入口是 `Deploy origin (manual)`，带目标 SHA 与 `approval_ref`；或按 runbook 的自动回滚。数据库迁移不随代码回滚。
- **值班**：出现 `rollback-failed` 且服务停止、健康异常或回读不可达时，先只读核对 `--status`/`--log`/`systemctl is-active`/`/health` 并立即报告 GM；不得手工拉起被拒版本、改写 `current`/`server.env` 或删除 `deploy-state`，除非 GM 书面批准并记录。处置过程与输出记入证据包。
- **本轮 ops 会话与句柄**（2026-10-21，供值班对账）：06:44:14Z 登录失败（连接超时）；06:45:16Z 登录成功但句柄未保住，06:52:56Z 补登出 `closed:true`；06:53:24Z 登录成功并完成读数，06:53:45Z 登出 `closed:true`。QA 报告的旧 `LCA04_OPS` 句柄已于 2026-10-20T23:53:47Z 过代理报告 TTL，未执行 logout、未核全局 IdP 会话。`ops_logout` 只 drop 代理句柄，不能视为全局 IdP 注销。

## 六、本收口链的交付顺序

文档与测试 PR（仅 `docs/`、`server/src/content/**` 测试文件）→ 另一工程独立复核 → 运营对新 head 的「仅收口文档/测试合入」批准 → 在 `Deploy production` 仍 `disabled_manually` 时按受审 head 合入 → 等实际合并 SHA 的 main `Quality gate` → 部署 QA 独立核定。本链不触发 origin/前端/hosted probe/SSH/故障注入/停服/自动发布启用。
