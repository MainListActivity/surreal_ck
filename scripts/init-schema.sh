#!/usr/bin/env bash
# Applies schema/main.surql to the running SurrealDB instance.
# Idempotent: safe to re-run on an existing database.
# Run on every deploy before serving traffic.

set -euo pipefail

SURREAL_ENDPOINT="${SURREAL_ENDPOINT:-http://localhost:8000}"
SURREAL_USER="${SURREAL_USER:-root}"
SURREAL_PASS="${SURREAL_PASS:-root}"
SURREAL_NS="${SURREAL_NS:-surreal_ck}"
SURREAL_DB="${SURREAL_DB:-app}"
SCHEMA_FILE="${SCHEMA_FILE:-$(dirname "$0")/../schema/main.surql}"

echo "Applying schema from ${SCHEMA_FILE}..."

surreal import \
  --endpoint "${SURREAL_ENDPOINT}" \
  --user "${SURREAL_USER}" \
  --pass "${SURREAL_PASS}" \
  --ns "${SURREAL_NS}" \
  --db "${SURREAL_DB}" \
  "${SCHEMA_FILE}"

echo "Schema applied successfully."
