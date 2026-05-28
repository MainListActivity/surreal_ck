Status: done
Label: done

# WP-D1-06 — 删 server/legacy/ai/mastra

## Parent

`.scratch/mastra-router-migration/PRD.md`

## What to build

- 删除 `server/legacy/ai/mastra/` 目录。
- 删除 `server/legacy/` 下任何仅供 Mastra 用的支撑代码（共享类型已搬到 shared）。
- `pnpm --filter @surreal-ck/server typecheck` 必须 0 错误（不再有"legacy known errors"豁免）。
- 更新 AGENTS.md / CLAUDE.md 中"Project Structure"表，把 `server/ai/mastra/**` 写正确，标 `server/legacy/` 已清空。

## Acceptance criteria

- [x] `server/legacy/ai/mastra/` 不存在。
- [x] `server/ai/mastra/**` 是唯一 Mastra 代码位置。
- [x] typecheck 全绿。
- [x] 既有测试（`*.test.ts`）全部能跑（即便部分需要 update import 路径）。
- [x] AGENTS.md "Project Structure" 表反映现状。

## 落地记录（2026-05-28）

- 物理删除：`server/legacy/ai/`（含已为空的 `mastra/` 子目录与孤儿 `navigation-agent.test.ts`）。
- 新增卫兵测试 `server/src/legacy-retired.test.ts`：断言上述路径都不存在，防回归。
- 验收：`pnpm --filter @surreal-ck/server typecheck` 0 错误；`pnpm --filter @surreal-ck/server test` 116 pass / 0 fail。
- `server/tsconfig.json` 的 `exclude: ["legacy", ...]` 保留——`server/legacy/` 其余子目录（auth / db / rpc / services / sync / templates / logging）仍在，由后续簇负责；D1 自己不再依赖任何"legacy known errors"豁免。

## Notes

- 这一步要在 D1 全部完成后再做，避免边迁边删导致中间态不可恢复。
- web/legacy/ 与 server/legacy/ 中**前端**部分仍保留，由簇 D2 处理。
