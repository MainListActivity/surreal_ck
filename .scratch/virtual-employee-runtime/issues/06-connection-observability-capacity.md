Status: done
Label: done

# 06 — 连接监督、观测与容量验收

**What to build:** runtime 可以长期维护员工会话：token 到期前安全续约、网络断开后恢复、启动时分批 reconcile、关停时在截止时间内完成或中止窗口，并向运维暴露不含敏感信息的容量和健康指标。

**Blocked by:** 05 — 预算、循环、重试与全局背压。

**Status:** done

- [x] token 续约或连接重建后只有一组有效监听和一个员工 session，不产生重复触发。
- [x] 断线期间已进入持久化队列的 trigger 在恢复后继续执行；LIVE 事件本身不作为唯一持久化来源。
- [x] 启动时按有界并发枚举 active workspace 和 active 员工，并暴露启动进度与失败计数。
- [x] shutdown 首先停止接收 trigger，再等待 in-flight 窗口；达到截止时间后发出 abort 并释放 lease，过程不会无限等待。
- [x] 指标至少覆盖 session、pending trigger、running window、retry、token usage、lease age、reconnect 和 shutdown duration。
- [x] 日志包含 workspace、employee、trigger 和 run 标识，但不包含 secret、raw token、root 凭证或完整敏感 payload。
- [x] 确定性虚拟时钟测试覆盖 24 小时运行、预算换日、token 续约和多次暂时断线。
- [x] 容量测试记录单实例在目标 workspace/employee/trigger 规模下的连接数、吞吐、内存和恢复时间，并给出升级到 leader/sharding 前的阈值。


---

## 实施记录（task/43c16697）

### 架构落点

- `server/ai/office/employee-runtime.ts`：员工会话监督。`connect` 携带 SDK
  reconnect 配置（enabled + attempts=-1 无限重试）；每个 session 订阅一次
  `reconnecting`/`disconnected`/`auth` 事件，`auth(null)` 或到点定时器触发同
  连接 `signin` 续约（默认 45min < access 1h TTL），续约失败走有界退避重试、
  计 `renewalFailures` 不重建连接——续约后仍是一组监听、一个 session。
- `employee-trigger-runtime.ts`：`stop(deadlineMs)` 幂等（单一 stopping
  promise）：先停收（enqueue 拒绝、waiter 结算 failed）→ 等 lane 排空至
  deadline → 到点对活跃窗口发 abort（`driver.abort()`）→ 清回触发 lease →
  再等 `abortGraceMs` 收 cancel 落盘 → 关会话。reconcile/driveRun 全程带
  abort 竞速；canceled snapshot 在下一轮 reconcile 收敛触发为 failed。
- `employee-mastra-runner.ts`：跟踪 active run，`abort()` 调
  `run.cancel()`（snapshot 落 canceled），cancel 失败仅记不含 payload 的日志。
- `employee-supervisor.ts`（新）：启动监督——`warmup` 回装 secret 缓存 →
  `_system` 枚举 active workspace → 每库枚举 active 虚拟员工 → 有界并发
  （默认 4）`reconcile`；进度/失败计数经 `progress()` 暴露，单员工失败不中断，
  枚举失败进入 failed 态，`start()` 并发幂等。
- `employee-service.ts` / `startup.ts`：启动时 `void startEmployeeSupervision()`
  （失败不阻塞服务）；shutdown 顺序：server.stop → dispatcher →
  `stopEmployeeTriggerRuntime(deadline)` → `stopEmployeeRuntime()`（关连接）
  → root。
- `server/src/routes/ops-employee-runtime.ts`：`GET /api/ops/employee-runtime/
  health`（`requirePlatformOperator`），返回 metrics + startup 进度；只有计数、
  时间戳、毫秒数与有界状态枚举，无 secret/token/payload。
- 配置（`.env.example` 已录）：`EMPLOYEE_SESSION_RENEW_AFTER_SEC=2700`、
  `EMPLOYEE_RUNTIME_SHUTDOWN_DEADLINE_MS=30000`、
  `EMPLOYEE_SHUTDOWN_ABORT_GRACE_MS=5000`、
  `EMPLOYEE_STARTUP_RECONCILE_CONCURRENCY=4`。

### 指标字段

`metrics()`：sessions(open/openRetries/openFailures)、windows(running/queued/
completed/crashed/aborted)、triggers(enqueued/coalesced/pendingApprox/
running/completed/failed/waiting)、retries、tokenUsage(provider/estimated×in/
out+calls)、lease(activeWindows/oldestWindowAgeMs)、connections(activeSessions/
connects/reconnects/disconnects/renewals/renewalFailures/invalidated)、
reconcile(runs/scanned/reclaimed/lastRunAt)、shutdown(runs/timedOut/
abortedWindows/durationMs)、signals。

### 容量实测（bun test 单实例，内存 fake session 层）

`VER06 容量` 测试：16 员工 × 3 触发 = 48，`maxConcurrentWindows=4`：

- 连接数：16（每 lane 恰一条员工会话，无重复连接）
- 吞吐：≈2000 triggers/s（handler 1ms 开销，实测 24ms 全量收敛）
- 峰值并发窗口：4（严格 = 上限，无超发）
- RSS 增量：≈9MB / 48 触发
- 恢复：stop(deadline) → abort → 触发 lease 清回后下一次 reconcile 即收敛
  （真实库集成测试验证 cancel 落 canceled → failed，窗口互斥释放）

### 升级到 leader/sharding 前的阈值建议

单实例约束本质是「进程内窗口槽 × 每员工 FIFO 串行」。建议告警/升级线：

- 活跃 employee lane > 500（每 lane 一条 WS 连接 + 定时器，连接数线性增长）
- 待办 trigger 排队时长 P95 > 60s（窗口槽打满的信号：吞吐被
  maxConcurrentWindows×窗口时长 限死，先调限额再分片）
- 续约/重连失败率 > 5%（`connections.renewalFailures / renewals`）
- shutdown timedOut 率 > 0（说明窗口处理时长普遍超过 deadline，需先治任务）

### 验收对照

- [x] 续约/重连后单组监听单 session：续约在同连接 signin，监听仅在注册时
  订阅一次；`employee-runtime.test.ts` 续约用例断言 listeners 仍一组、
  `made` 仅一条连接。
- [x] 断线期间已持久化 trigger 恢复后继续：窗口期查询断线 → 行保留 lease →
  恢复后 reconcile 认领执行（单测 + 真实库集成测试）；触发持久化不依赖
  LIVE（enqueue 即落库）。
- [x] 启动有界并发枚举 + 进度/失败计数：supervisor `progress()` 暴露
  workspacesTotal/Done、employeesTotal/Reconciled/Failed、inFlight。
- [x] shutdown 先停收 → 限时排空 → 到点 abort + 清 lease，幂等且有界。
- [x] 指标覆盖 session/pending trigger/running window/retry/token usage/
  lease age/reconnect/shutdown duration。
- [x] 日志只含 database/employeeId/triggerId/runId 与 error message；
  metrics/路由测试断言无 secret/token/payload 形态。
- [x] 虚拟时钟覆盖 24h 运行、跨预算日换日记账、续约定时、断线重试。
- [x] 容量实测与阈值见上节。
