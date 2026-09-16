Status: done
Label: verified
Assignee: codex
ID: SCK-LCM-06
Repository: surreal_ck

# 实现部分发布、纠错、撤回和恢复

Parent: [实施规格](../PRD.md)

## Dependencies

- [05-batch-validation](05-batch-validation.md)

## Scope

- 固定审阅修订与 entryKeys，校验 expectedVersionId 和 expectedPublicationRevision，再逐项幂等发布。
- 单项版本/法条与结果/事件一致；跨项失败可继续重试，不把部分成功报告为全成功。
- 结构化索引/客户可服务投影就绪才公开；复用发布事件驱动任务，记录失败和恢复。
- 纠错新版本、撤回停读停搜、恢复重核许可；旧引用保留 tombstone。检索索引接口为后续 AI retrieval 保留边界。

## Acceptance

- [x] 两运营同时发布、撤回与恢复能发现过期前提。
- [x] 进程中断恢复不重复版本/事件，不泄露半成品；未知许可拒绝。
- [x] 客户读取路径实测撤回后拒绝，旧 token/缓存不扩大访问，恢复需重新核验。

## Verification

- `pnpm --filter @surreal-ck/server exec bun test src/content/service.test.ts --preload ./test/setup-env.ts`
- `RUN_LOCAL_PLATFORM_CONTENT_TESTS=1 pnpm --filter @surreal-ck/server exec bun test src/content/store.integration.test.ts`
- 持久化适配器以 `publication_request` 唯一幂等行预留 pending；内容版本、来源关联、citation/法规条款、projection、publication event 和 entry 状态在同一事务内提交。
- `expectedVersionId` / `expectedPublicationRevision` 使用条件更新，过期前提返回 `stale_version`；撤回保留版本和事件，仅将投影置为 withdrawn，恢复必须携带新的状态前提。

## Handoff

- 实施前读取仓库 AGENTS.md 和相关技能；SurrealQL、Mastra 等按任务实际涉及加载。
- 完成后记录改动、验证命令与结果及剩余限制；依赖完成后将下游转为 open/ready-for-agent，不提前声明交付。
- 本票只授权自身实现范围，不隐含线上部署、真实来源商用发布或外部账号配置修改。
