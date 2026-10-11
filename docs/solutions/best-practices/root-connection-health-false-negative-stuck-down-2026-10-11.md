---
title: Root 连接健康状态机假阴性卡死——/health 持续 degraded 而服务实际可用
date: 2026-10-11
category: best-practices
module: server
problem_type: false_negative_health_probe
component: db
symptoms:
  - 生产 https://l.maplayer.top/health 持续 status=degraded、surrealdb=down（HTTP 200）≥45min 未恢复。
  - 同期反证服务可用：客户 ops_login 成功（间歇 30s 超时）、ops_query INFO FOR DB 全量返回、ops_member_list 经 root session pool 返回成员、quotaWorker 5 loops ticks ~0.2s consecutiveErrors=0。
  - runtime 锚点未变（非部署回归）。
root_cause: health_probe_early_return_without_reverify
resolution_type: code_fix
severity: high
related_components:
  - db
  - quota
  - health-endpoint
tags:
  - surrealdb
  - root-connection
  - health
  - reconnect
  - half-open
---

# Root 连接健康状态机假阴性卡死

## Problem

`server/src/db/root-connection.ts` 旧实现用模块级 `connected` 布尔标志 +
`checkRootConnection` 早退：

```ts
function isRootConnected(): boolean {
  return connected && rootConnection?.isConnected === true;
}
export async function checkRootConnection(timeoutMs = 5000): Promise<boolean> {
  if (!isRootConnected()) return false;   // ← 标志为 false 时不再实测
  ...query("RETURN 1") 失败 → connected = false → scheduleReconnect()
}
```

故障链（本地行为级复现，见任务证据 behavior-proof-old-vs-new.txt）：

1. 一次探测失败（5s 超时/F4 间歇 stall）或一次 disconnected 事件 → `connected=false`；
2. 此后 /health **早退不再实测**，恢复完全依赖 `connectRootOnce()` 新建连接成功；
3. 若新 WSS 连接持续失败（握手/auth/连接上限），即使**旧连接对象仍存活**并服务
   root session pool 与 quotaWorker（生产证据：成员列表、worker ticks 均正常），
   标志也永远卡 down——端点失去「当前真实状态」语义；
4. 附带缺陷放大风暴：`connectRootOnce` 失败路径无条件写模块级 `connected=false`
   （可重叠尝试中后失败的陈旧尝试会翻转已健康的新连接）；旧实例的
   disconnected/error 事件处理器无实例身份校验，陈旧事件误翻健康标志；
   退避上限 10s、每次成功都 closeAll 池+换连接，重连循环加剧 ops/login 间歇超时。

生产网络、认证或连接容量导致首次瞬断的具体触发原因尚未证实。以上是代码侧可复现的
假阴性机制与放大条件，不代表已经从生产日志查明网络根因。

## Fix

重写为显式三态状态机（`RootConnectionManager`，可注入连接工厂便于测试）：

1. **探测先实测现有连接**（半开探测）：SDK 对静默断链不发事件，只有真实往返
   才暴露；探测成功即把状态修回 `connected`——瞬断/旧连接仍存活时直接恢复，
   不换连接、不清池（消除假阴性卡死）；
2. **单飞重连**：同一时刻至多一个连接尝试（`inFlight`），失败按
   `[1s,2s,5s,10s,15s] ±20% jitter` 退避，并有 1s 尝试最小间隔（gate，
   防 /health 高频轮询变成连接风暴）；gate 挡住的失败也会安排剩余窗口的
   重试定时器，自治恢复不依赖轮询节奏；
3. **事件处理器按实例身份隔离**：只有当前连接实例的 disconnected/error
   才允许改状态；成功路径先切换引用再关闭旧连接，旧实例 close() 发布的
   disconnected 被身份检查忽略；
4. **异步探测同样按实例隔离**：成功和失败都要核对当前实例；旧连接的迟到结果
   不能修改新连接状态，实例变化时重新实测当前连接；
5. **关闭使旧生命周期失效**：取消在途连接尝试，发布前核对生命周期；SDK 握手
   在超时或关闭后迟到完成时再次清理候选，禁止重新发布。清理 root session pool
   的 detach RPC 必须先于关闭 socket，避免请求悬挂；
6. 失败如实报 down、绝不常 ok；`/health` 响应形状不变。

## Verification

- 单元测试（假连接工厂）：瞬断恢复不卡死不 churn、陈旧事件不翻转、并发检查
  单飞、真实不可达如实 down 且恢复后转 ok、gate 防轮询风暴、close 后停止重连；
- 并发回归：旧探测迟到失败不再触发第三条连接/关闭健康新实例，迟到成功不掩盖
  当前实例不可达；关闭与重新 init 的代际隔离、握手超时/关闭后的迟到清理；
- 行为级新旧对比（mock.module 注入可控假连接）：旧实现同场景 STUCK DOWN
  （instances churn 增长、originalClosed=false），新实现恢复 up 且零 churn；
- 集成测试（真实公司 fork，`RUN_LOCAL_SURREALDB_ROOT_CONNECTION_TESTS=1`）：
  杀引擎 → 连续 3 次检查如实 false；引擎重启 → 自治重连恢复，root session
  pool 读写路径随新连接恢复；
- 全量 server 测试、typecheck、分目录 lint 通过（12 个失败为本底环境问题，
  干净 HEAD 同样失败，与本次改动无关）。

## Lesson

健康端点不能只读缓存标志：标志可能因一次瞬断过期，而恢复路径（新建连接）
可能比旧连接更脆弱。正确语义是「探测即实测当前连接，失败才走重建」，
并且所有状态写入都必须能回答「这个事件/失败属于哪个连接实例」。
