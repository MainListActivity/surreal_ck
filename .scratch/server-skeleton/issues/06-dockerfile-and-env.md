Status: needs-triage
Label: needs-triage

# WP-B-06 — Dockerfile + .env.example + 启动文档

## Parent

`.scratch/server-skeleton/PRD.md`

## What to build

### Dockerfile（仓库根）

多阶段：

1. `oven/bun:1-alpine` builder：`pnpm install --frozen-lockfile`、`pnpm --filter @surreal-ck/server typecheck`。
2. `oven/bun:1-alpine` runtime：仅 copy `server/src` + `shared/src` + `node_modules`，`CMD ["bun", "run", "server/src/index.ts"]`。

镜像目标 < 200MB。

### .env.example（仓库根）

```bash
# Bun server
PORT=8080
NODE_ENV=development

# SurrealDB（dev compose 用内网；prod 用公网 WSS）
SURREAL_URL=ws://surrealdb:8000/rpc
SURREAL_NS=main
SURREAL_ROOT_USER=root
SURREAL_ROOT_PASS=change_me

# OIDC
OIDC_ISSUER=https://o.maplayer.top/t/ck
OIDC_JWKS_URL=https://o.maplayer.top/t/ck/jwks.json
OIDC_AUDIENCE=https://auth.maplayer.top

# IdP token scope adapter / hook
IDP_SCOPE_API_URL=https://o.maplayer.top/t/ck/scope
IDP_SCOPE_API_TOKEN=change_me
IDP_HOOK_SECRET=change_me
```

### docker-compose.yml（仓库根，开发用）

两服务：`surrealdb`（官方 image）+ `server`（本仓库 build），同网段。

### 启动文档

更新 `server/README.md`：

- 本地开发：`bun install && cp .env.example .env && pnpm --filter @surreal-ck/server dev`。
- Docker：`docker compose up -d`。
- 验证：`curl localhost:8080/health`。

## Acceptance criteria

- [ ] `docker build .` 成功，镜像 < 200MB。
- [ ] `docker compose up` 后 `curl localhost:8080/health` 返回 `{ status: 'ok' }`。
- [ ] `.env.example` 不含任何真实 secret / 占位 secret 看就知道是占位。
- [ ] `server/README.md` 三句话能让新人跑起来。

## Notes

- 镜像里不要装 pnpm（runtime 阶段直接用 Bun 跑 src，不需要 pnpm）。
- 生产部署的 secret 管理（k8s secrets / Vault / 1Password）超出本 issue，下放到运维章节。
