/**
 * Record hover preview: given a cell value that looks like a SurrealDB record ID
 * (e.g. "company:acme"), fetch the entity record and return key fields for tooltip display.
 */

// Matches SurrealDB record IDs: table:id where id may be alphanumeric, UUID, etc.
const RECORD_ID_PATTERN = /^[a-z_][a-z0-9_]*:[a-z0-9_\-:]+$/i;

export function isSurrealRecordId(value: string): boolean {
  return RECORD_ID_PATTERN.test(value.trim());
}

export interface RecordPreview {
  recordId: string;
  label: string;
  entityType: string;
  fields: Array<{ key: string; value: string }>;
}

/**
 * Fetches key fields from a SurrealDB record for tooltip display.
 * Returns null if the record does not exist or the fetch fails.
 */
export async function fetchRecordPreview(
  db: import('surrealdb').Surreal,
  recordId: string,
): Promise<RecordPreview | null> {
  try {
    const [rows] = await db.query<[Record<string, unknown>[]]>(
      'SELECT * FROM $id LIMIT 1',
      { id: recordId },
    );
    const record = rows?.[0];
    if (!record) return null;

    const [table] = recordId.split(':');
    const labelField = resolveLabel(record);
    const fields = Object.entries(record)
      .filter(([k]) => k !== 'id' && k !== 'workspace' && k !== 'created_at')
      .slice(0, 4)
      .map(([k, v]) => ({ key: k, value: String(v ?? '') }));

    return { recordId, label: labelField, entityType: table, fields };
  } catch {
    return null;
  }
}

function resolveLabel(record: Record<string, unknown>): string {
  if (typeof record['name'] === 'string') return record['name'];
  if (typeof record['label'] === 'string') return record['label'];
  if (typeof record['title'] === 'string') return record['title'];
  // First alphabetical string field
  const stringField = Object.entries(record)
    .filter(([k, v]) => k !== 'id' && typeof v === 'string')
    .sort(([a], [b]) => a.localeCompare(b))[0];
  return stringField ? String(stringField[1]) : String(record['id'] ?? '');
}

/**
 * Hover state manager with 300ms delay before fetching.
 */
export class RecordHoverManager {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onPreview: (preview: RecordPreview | null) => void;
  private db: Parameters<typeof fetchRecordPreview>[0];

  constructor(
    db: import('surrealdb').Surreal,
    onPreview: (preview: RecordPreview | null) => void,
  ) {
    this.db = db;
    this.onPreview = onPreview;
  }

  hoverStart(cellValue: string) {
    this.cancel();
    if (!isSurrealRecordId(cellValue)) return;
    this.timer = setTimeout(async () => {
      const preview = await fetchRecordPreview(this.db, cellValue.trim());
      this.onPreview(preview ?? { recordId: cellValue, label: 'Record not found', entityType: '', fields: [] });
    }, 300);
  }

  hoverEnd() {
    this.cancel();
    this.onPreview(null);
  }

  cancel() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
