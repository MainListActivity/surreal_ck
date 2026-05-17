Status: needs-triage
Label: needs-triage

# WP-D1-01 — Router workflow 物理迁入 + import 更新

## Parent

`.scratch/mastra-router-migration/PRD.md`

## What to build

按下面映射 `git mv`：

```
server/legacy/ai/mastra/agents/*           → server/ai/mastra/agents/*
server/legacy/ai/mastra/tools/*            → server/ai/mastra/tools/*
server/legacy/ai/mastra/workflows/*        → server/ai/mastra/workflows/*
server/legacy/ai/mastra/storage/*          → server/ai/mastra/storage/*
server/legacy/ai/index.ts                  → server/ai/mastra/index.ts   （重命名为更窄）
```

shared 共享类型挪：

```
server/legacy/shared/rpc.types.ts          → 拆：仅 Router workflow 相关的 ResolvedRecord / Candidate / Suspend payload 保留并搬到 shared/src/router-workflow.types.ts
server/legacy/shared/ai-context.ts         → shared/src/ai-context.ts（先原样搬，sidecar 字段保留但标 deprecated）
```

更新 import：

- `@/main/*` 形式的相对 import 改为 `@surreal-ck/shared` 或本 workspace 内相对路径。
- legacy 目录内残留的 import 不动（簇 D1-06 删 legacy 时一并清）。

## Acceptance criteria

- [ ] `pnpm --filter @surreal-ck/server typecheck` 报错可控（剩下都是"找不到 Electrobun RPC bridge"之类已知 legacy 残留），不会因为 import 路径错而炸。
- [ ] `git log --follow server/ai/mastra/workflows/router-workflow.ts` 仍能看到原 src/main 路径下的提交历史。
- [ ] shared/src/router-workflow.types.ts 在 server 与 web workspace 都能 `import` 到。

## Notes

- 这一步不改任何代码逻辑，只动文件位置和 import。
- 把"什么属于 shared 什么属于 server-only"划清楚的最佳时机就是搬运时——后续簇 D2 前端会用到 shared/router-workflow.types。
