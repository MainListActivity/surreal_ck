#!/usr/bin/env bash
# surreal_ck backup script
# Runs daily via cron: 0 2 * * * /opt/surreal_ck/backup.sh
# Retains last 30 days of backups.
# On failure: logs error to /var/log/surreal_ck_backup.log and exits non-zero.

set -euo pipefail

BACKUP_DIR="/data/backups"
LOG_FILE="/var/log/surreal_ck_backup.log"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/surreal_ck_${TIMESTAMP}.surql"
RETENTION_DAYS=30

SURREAL_ENDPOINT="${SURREAL_ENDPOINT:-http://localhost:8000}"
SURREAL_USER="${SURREAL_USER:-root}"
SURREAL_PASS="${SURREAL_PASS:-root}"
SURREAL_NS="${SURREAL_NS:-surreal_ck}"
SURREAL_DB="${SURREAL_DB:-app}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG_FILE}"
}

fail() {
  log "ERROR: $*"
  exit 1
}

mkdir -p "${BACKUP_DIR}"

log "Starting backup → ${BACKUP_FILE}"

surreal export \
  --endpoint "${SURREAL_ENDPOINT}" \
  --user "${SURREAL_USER}" \
  --pass "${SURREAL_PASS}" \
  --ns "${SURREAL_NS}" \
  --db "${SURREAL_DB}" \
  "${BACKUP_FILE}" || fail "surreal export failed"

log "Backup complete: ${BACKUP_FILE} ($(du -sh "${BACKUP_FILE}" | cut -f1))"

# Retain last RETENTION_DAYS days; delete older backups.
find "${BACKUP_DIR}" -name "surreal_ck_*.surql" -mtime "+${RETENTION_DAYS}" -delete
log "Old backups (>${RETENTION_DAYS}d) cleaned up"

# Post-backup mutation cleanup: remove mutations older than the oldest snapshot.
# This prevents unbounded growth of the mutation table.
OLDEST_SNAP_TS=$(surreal sql \
  --endpoint "${SURREAL_ENDPOINT}" \
  --user "${SURREAL_USER}" \
  --pass "${SURREAL_PASS}" \
  --ns "${SURREAL_NS}" \
  --db "${SURREAL_DB}" \
  --json \
  "SELECT created_at FROM snapshot ORDER BY created_at ASC LIMIT 1" \
  2>/dev/null | grep -o '"created_at":"[^"]*"' | head -1 | cut -d'"' -f4 || true)

if [ -n "${OLDEST_SNAP_TS}" ]; then
  surreal sql \
    --endpoint "${SURREAL_ENDPOINT}" \
    --user "${SURREAL_USER}" \
    --pass "${SURREAL_PASS}" \
    --ns "${SURREAL_NS}" \
    --db "${SURREAL_DB}" \
    "DELETE mutation WHERE created_at < '${OLDEST_SNAP_TS}'" \
    2>/dev/null || log "WARN: mutation cleanup failed (non-fatal)"
  log "Mutations older than ${OLDEST_SNAP_TS} cleaned up"
fi

log "Backup job complete"
