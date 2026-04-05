# Deployment Runbook — surreal_ck

## Architecture

```
Internet → nginx (port 80/443)
             ├── /assets/*         → /dist/assets (static, 1y cache)
             ├── /surreal/*        → http://surreal:8000 (WebSocket proxy)
             └── /*                → /dist/index.html (SPA fallback)

surreal:8000  → SurrealDB 3.0.5 (RocksDB, internal Docker network only)
```

SurrealDB is **not** exposed on a public port. All browser connections reach it
via the nginx WebSocket proxy at `/surreal/`.

## Prerequisites

- Docker + Docker Compose
- `surreal` CLI installed on the host (for schema init and backup)
- `.env` file with production values (copy from `.env.example`)

## First Deploy

```bash
# 1. Clone the repo
git clone <repo-url> surreal_ck && cd surreal_ck

# 2. Set production credentials
cp .env.example .env
$EDITOR .env  # set SURREAL_ROOT_PASS, VITE_SURREAL_URL etc.

# 3. Build the frontend
pnpm install
pnpm build

# 4. Start SurrealDB
docker compose up -d surreal

# 5. Apply schema (idempotent)
SURREAL_PASS=$(grep SURREAL_ROOT_PASS .env | cut -d= -f2) \
  bash scripts/init-schema.sh

# 6. Start nginx (serves dist/ + proxies SurrealDB)
docker compose up -d nginx
```

## Subsequent Deploys

```bash
pnpm build
docker compose restart nginx  # nginx re-reads /dist without restarting SurrealDB
bash scripts/init-schema.sh   # safe to re-run; idempotent DDL
```

Schema changes (new DEFINE TABLE / DEFINE FIELD statements in `schema/main.surql`
or `schema/templates/*.surql`) are applied by re-running `init-schema.sh`.

## Backup

### Cron setup (host crontab)

```cron
0 2 * * * /opt/surreal_ck/backup.sh >> /var/log/surreal_ck_backup.log 2>&1
```

Backups land in `/data/backups/` inside the `surreal-backups` Docker volume.
Files older than 30 days are automatically deleted.

### Manual backup

```bash
bash backup.sh
```

### Restore from backup

```bash
surreal import \
  --endpoint http://localhost:8000 \
  --user root --pass "$SURREAL_ROOT_PASS" \
  --ns surreal_ck --db app \
  /data/backups/surreal_ck_20260401_020000.surql
```

**Maximum data loss on restore:** 24 hours (daily backup cadence).
**Estimated restore time:** < 5 minutes for a typical workspace.

## Post-Deploy Smoke Checks

Run these manually after every deploy:

1. **Spreadsheet loads without error**
   - Open the app URL in a browser.
   - Verify no console errors; workbook grid renders.

2. **Cell edit → mutation in DB**
   - Edit a cell in the workbook.
   - Query `SELECT * FROM mutation ORDER BY created_at DESC LIMIT 1` in Surrealist.
   - Verify a mutation record was inserted with the correct `command_id`.

3. **Two-tab real-time sync**
   - Open the same workbook in two browser tabs.
   - Edit a cell in Tab A.
   - Verify the change appears in Tab B within 2 seconds.

4. **GRAPH_TRAVERSE formula**
   - In a cell, enter `=GRAPH_TRAVERSE("company:acme_holdings", "owns", 2)`.
   - Verify the cell resolves to display labels (not an error token).

5. **Public form → workbook row**
   - Open `/form/new-client-intake` (Legal Entity Tracker workspace).
   - Submit the form.
   - Verify a new row appears in the lawyer's workbook grid within 2 seconds.

## Operational Runbook

### Sync issues ("Reconnecting" banner stuck)

1. Check SurrealDB health: `docker compose logs surreal --tail 50`
2. Check nginx proxy: `docker compose logs nginx --tail 20`
3. Verify WebSocket proxy works: `curl -i -N -H "Upgrade: websocket" http://localhost/surreal/`
4. Restart SurrealDB if needed: `docker compose restart surreal`
   - Clients will auto-reconnect within 30s; LIVE SELECT subscriptions resume.

### Disk space (SurrealDB data growth)

```bash
# Check Docker volume usage
docker system df -v | grep surreal

# Check backup volume
docker run --rm -v surreal-backups:/data alpine du -sh /data
```

Mutation cleanup runs automatically as part of the daily backup. If disk grows
unexpectedly, check for stale presence records:

```bash
surreal sql --endpoint http://localhost:8000 ... \
  "DELETE presence WHERE expires_at < time::now()"
```

### Schema rollback

There is no automated DDL rollback. To revert a schema change:

1. Remove the offending DEFINE statement from `schema/main.surql`.
2. If the change added a table/field, drop it manually via Surrealist or CLI:
   ```sql
   REMOVE TABLE <table_name>;
   REMOVE FIELD <field_name> ON TABLE <table_name>;
   ```
3. Re-run `scripts/init-schema.sh` to verify the corrected schema applies cleanly.

### Emergency: full data restore

```bash
# Stop nginx (prevent new writes during restore)
docker compose stop nginx

# Restore from backup
surreal import --endpoint http://localhost:8000 \
  --user root --pass "$SURREAL_ROOT_PASS" \
  --ns surreal_ck --db app \
  /path/to/backup.surql

# Restart nginx
docker compose start nginx
```

Estimated downtime: 2–5 minutes.
