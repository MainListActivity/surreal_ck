Status: needs-triage
Label: needs-triage

# WP-D1-06 — 删 server/legacy/ai/mastra

## Parent

`.scratch/mastra-router-migration/PRD.md`

## What to build

- 删除 `server/legacy/ai/mastra/` 目录。
- 删除 `server/legacy/` 下任何仅供 Mastra 用的支撑代码（共享类型已搬到 shared）。
- `pnpm --filter @surreal-ck/server typecheck` 必须 0 错误（不再有"legacy known errors"豁免）。
- 更新 AGENTS.md / CLAUDE.md 中"Project Structure"表，把 `server/ai/mastra/**` 写正确，标 `server/legacy/` 已清空。

## Acceptance criteria

- [ ] `server/legacy/ai/mastra/` 不存在。
- [ ] `server/ai/mastra/**` 是唯一 Mastra 代码位置。
- [ ] typecheck 全绿。
- [ ] 既有测试（`*.test.ts`）全部能跑（即便部分需要 update import 路径）。
- [ ] AGENTS.md "Project Structure" 表反映现状。

## Notes

- 这一步要在 D1 全部完成后再做，避免边迁边删导致中间态不可恢复。
- web/legacy/ 与 server/legacy/ 中**前端**部分仍保留，由簇 D2 处理。
