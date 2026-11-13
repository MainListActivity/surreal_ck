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

- 本仓库仅使用 pnpm 安装依赖和运行命令。
- 提交前请运行根 `package.json` 中已有的 `typecheck` 与 `lint` 脚本。
- 更多协作约定与项目背景请参阅 [AGENTS.md](AGENTS.md) 和 [CONTEXT.md](CONTEXT.md)。
