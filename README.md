# surreal_ck

Web-only collaborative spreadsheet architecture: Bun + Hono server, Svelte web frontend, shared DTO/schema package, and SurrealDB over WSS.

## Local Setup

```bash
pnpm install
cp .env.example .env
pnpm -r run typecheck
pnpm --filter @surreal-ck/server dev
```

Verify the server:

```bash
curl http://localhost:8080/health
```

## Docker

```bash
docker compose up --build
curl http://localhost:8080/health
```

The repository is split into `server/`, `web/`, and `shared/`. Historical desktop code lives under `server/legacy/` and `web/legacy/` while the web-only migration proceeds.

## 参与开发

本项目仅使用 pnpm 管理依赖和运行脚本。
提交前请运行 `pnpm typecheck` 与 `pnpm lint`。
开发约定与项目背景请参阅 [AGENTS.md](AGENTS.md) 和 [CONTEXT.md](CONTEXT.md)。
