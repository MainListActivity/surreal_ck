Status: needs-triage
Label: needs-triage

# VO-05 — 预算与死循环闸门

## Parent

`.scratch/virtual-office/PRD.md`

## What to build

在 dispatcher 上加三道闸门，防止虚拟员工烧钱或互相派单成环。

### 1. 每窗口步数硬上限

`employeeWorkflow` 在内部 `dountil` 上挂 `maxSteps`（默认 3）。超过即把当前任务标 `stalled`，写一条 `office_report { summary: '本窗口步数超限', blocked_by: 'step-limit' }`。

### 2. Daily token budget

`employee_daily_usage` 作为 workspace database schema seed 的一部分加入：

```surql
DEFINE TABLE employee_daily_usage SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE,        -- 同 workspace 用户都能看
    FOR create, update WHERE employee = $auth OR $auth.is_admin = true,
    FOR delete WHERE $auth.is_admin = true;
DEFINE FIELD employee   ON employee_daily_usage TYPE record<user>;
DEFINE FIELD day        ON employee_daily_usage TYPE string;  -- 'YYYY-MM-DD'
DEFINE FIELD tokens_in  ON employee_daily_usage TYPE int DEFAULT 0;
DEFINE FIELD tokens_out ON employee_daily_usage TYPE int DEFAULT 0;
DEFINE INDEX edu_unique ON employee_daily_usage COLUMNS employee, day UNIQUE;
```

每次拉起窗口前查询当日累计，超过 `office_role.daily_token_budget` 则跳过 + 写一条 `user_notification { severity: 'urgent', body: '员工 X 触达每日预算，已停摆' }`。

**写入身份**：员工自己用 employee 连接 `UPDATE employee_daily_usage WHERE employee = $auth ...` 累加，归因自动正确。

**前端可视化**：用户能在办公室 UI 看到每日 token 使用条（select PERMISSIONS 已开），属 issue 09 范围。

### 3. 任务深度上限

`office_task.depth` 在 assigner 创建子 task 时设为 `parent.depth + 1`。dispatcher 在拉起窗口前若发现 `depth > MAX_DEPTH`（默认 5）：

- 不执行该 task 的窗口
- 把 task 标 `stalled`
- 写 `user_notification`

### 4. 频率闸门（防 LIVE 风暴）

dispatcher 维护 per-employee in-flight 标记：同一员工在前一次窗口未结束时，新的 LIVE 事件不再叠加窗口，只是把"待处理"标记标脏，窗口结束后再跑一次。

## Acceptance criteria

- [ ] 模拟"员工自我派单"循环：写一个测试岗位每次执行都给自己派一条子 task，6 层之后被 depth 闸门拦下，dispatcher 不再扩展
- [ ] mock token 计数 + 把当日额度设为 100，单次窗口跑完后下次拉起被预算闸门拦下
- [ ] 步数硬上限测试：把 `maxSteps=1` 后窗口在 1 步后强制 stalled
- [ ] LIVE 风暴测试：10ms 内连写 50 条 task，dispatcher 实际拉起的窗口次数 ≤ 当时 in-flight + 1

## Blocked by

- `.scratch/virtual-office/issues/04-office-dispatcher-tracer.md`

## Notes

- 三道闸门是独立的——任何一道触发都立即 short-circuit，不依赖其它。
- `employee_daily_usage` 是每个 workspace database 内一张表（不再是全局），跨 workspace 不汇总；MVP 后端单副本，无需考虑跨副本竞争。
- token 计费精度依赖 model provider 回包；若拿不到精确数则用"输入字符数 / 4 估算"。
