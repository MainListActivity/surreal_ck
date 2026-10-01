# 人类请求续跑的中间态恢复与本地 JWT fixture

VO03 续跑不能仅在 `office_task.status = blocked` 时进入效果链：`resume-task` 已提交后状态变为 `in_progress`，Mastra restart 会重读该状态。如果据此跳过分支，触发被标 completed，报告和 `finish-task` 永远不会执行。

读取持久的 `result.waiting_on`，仅允许请求发送员工与派单 assignee 一致、等待同一 notification 的 blocked/in_progress 派单继续。`done + result.requestId` 允许补记最后一个 effect，但不会重开终态。效果链各步仍由 employee_effect 去重。

`server/ai/office/office-request.integration.test.ts` 在真实公司 fork、员工 RECORD 会话、Mastra snapshot 与 effect 账本上，分别悬停 resume effect 提交后、报告写入后、finish 前、finish 写入后的旧窗口，再用新 runtime 回收过期租约。断言唯一触发、唯一答复消息/报告、4 个 committed effect 和 done 派单。额外验证其他请求、其他 assignee、取消终态不被收尾。

运行（仓库 server 目录）：

```sh
rtk proxy bun test ai/office/office-request.integration.test.ts --preload ./test/setup-env.ts
```

只使用公司 fork，缺省 `~/.surrealdb/surreal`；可以用 `SURREAL_BINARY` 指向公司 fork 的另一构建，不使用官方发行版。

本机该 fork（3.3.0-nightly）使用 JWKS URL 的原 fixture 在 JWT authenticate 阶段报 `The access method cannot be used in the requested operation`。同一模板只将 fixture 的 `JWT URL` 改为同一 ES256 公钥的 `JWT ALGORITHM ES256 KEY` 后纵切通过；fork `iam/verify.rs` 在未编译 jwks feature 时对 JWKS 来源返回 AccessMethodMismatch，与此结果一致。测试保留真实签名、admin JWT system role、participant RECORD access 和 AUTHENTICATE 块，只移除对 JWKS 构建能力及网络取钥的依赖。生产 schema 未改动，测试不证明生产 JWKS 获取可用。
