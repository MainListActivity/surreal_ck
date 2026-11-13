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

## 仓库目录速览

| 目录 | 职责 |
| --- | --- |
| `web/` | Svelte 5 + RevoGrid，浏览器 OIDC / SurrealDB 直连 |
| `server/` | Bun + Hono 后端、Mastra AI、虚拟办公室及平台控制面 |
| `shared/` | 前后端共享类型、数据库 schema 与契约 |
| `marketing/` | Astro 营销站 |
| `ops/` | 独立运营前端 |
