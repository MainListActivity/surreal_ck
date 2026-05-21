# Server

```bash
pnpm install
cp .env.example .env
pnpm --filter @surreal-ck/server dev
```

Docker:

```bash
docker compose up --build
```

Verify:

```bash
curl http://localhost:8080/health
```
