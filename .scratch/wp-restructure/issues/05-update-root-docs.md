Status: done
Label: done

# WP-A-05 — 根 README / AGENTS.md 更新

## Parent

`.scratch/wp-restructure/PRD.md`

## What to build

- 根 `README.md`：写"如何起项目"的最小说明（暂时只到 `pnpm install` + `pnpm -r run typecheck`）。
- `AGENTS.md`（即 `CLAUDE.md`）技术栈章节重写——把 Electrobun / 嵌入式 SurrealDB 的描述替换为：
  - Bun server (Hono)
  - 自部署 / 托管 SurrealDB（公网 WSS + TLS；dev compose 可走内网）
  - Web 前端（Svelte 5 + RevoGrid）
  - pnpm workspaces 三层（server / web / shared）
- `AGENTS.md` "Project Structure" 表格更新：`src/main/ai/mastra/**` → `server/legacy/ai/mastra/**`（在簇 D1 完成迁入后再改一次到 `server/ai/mastra/**`）。

## Acceptance criteria

- [x] 读者 follow 根 README 能成功 install 并 typecheck。
- [x] AGENTS.md 中不再有"Electrobun"或"surrealdb-node embedded"的有效引用。
- [x] 引用的 ADR 路径全部有效（点开能跳）。

## Notes

- 这次更新只动技术栈描述；SurrealDB rules、Skill routing 等业务规则不动。
