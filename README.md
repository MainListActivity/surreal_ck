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

## 常用命令速查

以下命令均在仓库根目录执行，与根 `package.json` 的 `scripts` 一一对应。

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动后端开发服务，读取根目录 `.env`，文件变更后自动重启 |
| `pnpm dev:server` | 与 `pnpm dev` 相同，启动后端开发服务 |
| `pnpm dev:marketing` | 启动营销站（Astro）开发服务器 |
| `pnpm dev:ops` | 启动运营前端（Vite）开发服务器 |
| `pnpm build:marketing` | 构建营销站（Astro） |
| `pnpm build:ops` | 构建运营前端（Vite） |
| `pnpm content:runner` | 通过 MCP 提交并检查平台内容批次，默认停在人工审阅；加 `--publish` 时还需设置 `CONTENT_PUBLISH_CONFIRM=YES` |
| `pnpm test` | 依次运行各包的 test 脚本，未定义 test 的包会跳过 |
| `pnpm test:quota:local` | 运行 shared 包的本地配额集成测试，需要本地 SurrealDB |
| `pnpm test:quota:cross-repo` | 运行 server 包的原生配额跨仓库端到端测试 |
| `pnpm test:quota:integration` | 依次运行 shared 与 server 包的配额集成测试，需要本地 SurrealDB |
| `pnpm quota:migration` | 运行原生配额旧数据迁移 CLI，会改写数据，须按 `docs/runbooks/native-quota-legacy-migration.md` 执行 |
| `pnpm lint` | 用 oxlint 检查 server、shared、web、marketing 与 scripts，警告也会导致失败 |
| `pnpm typecheck` | 依次运行各包的类型检查，CI 也会执行 |
| `pnpm icon:generate` | 用 macOS 的 sips 从 `assets/app-icon.svg` 重新生成图标，仅 macOS 可用，会覆盖 `assets/` 下的图标 |
