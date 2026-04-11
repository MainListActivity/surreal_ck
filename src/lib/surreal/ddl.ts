/**
 * Generates standardised SurrealQL DDL for dynamic entity and relation tables.
 *
 * Every dynamic table gets the same workspace-scoped, owner/member permission
 * pattern used by the static tables in schema/main.surql. This eliminates the
 * security risk of hand-coding DDL in the frontend or templates.
 */

// ─── Reserved names ──────────────────────────────────────────────────────────

const RESERVED_TABLE_NAMES = new Set([
  // core tables
  'app_user', 'workspace', 'workbook', 'sheet', 'folder',
  'pending_workspace_member',
  'mutation', 'snapshot', 'presence', 'edge_catalog',
  'form_definition', 'intake_submission', 'client_error', 'workbook_file',
  // edge tables
  'has_workspace_member',
]);

// ─── Validation ──────────────────────────────────────────────────────────────

const TABLE_KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;

export function validateTableKey(key: string): string | null {
  if (!TABLE_KEY_RE.test(key)) {
    return 'Table key must start with a lowercase letter and contain only a-z, 0-9, underscore (max 63 chars).';
  }
  if (RESERVED_TABLE_NAMES.has(key)) {
    return `"${key}" is a reserved table name.`;
  }
  return null;
}

// ─── Permission snippets ─────────────────────────────────────────────────────

/**
 * Standard workspace-scoped permissions for a dynamic entity table.
 * Members can read; only the workspace owner can write.
 * The `workspace` field on each row is the link back to the workspace.
 */
const ENTITY_TABLE_PERMISSIONS = `
  PERMISSIONS
    FOR select WHERE
      workspace.owner = $auth
      OR workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      workspace.owner = $auth`;


// ─── Field type mapping ──────────────────────────────────────────────────────

interface FieldDef {
  key: string;
  type: string; // field_type key: text, number, date, single_select, multi_select, file
  required: boolean;
}

function surqlType(fieldType: string, required: boolean): string {
  let base: string;
  switch (fieldType) {
    case 'number':
      base = 'float';
      break;
    case 'date':
      base = 'datetime';
      break;
    case 'text':
    case 'single_select':
    case 'file':
      base = 'string';
      break;
    case 'multi_select':
      base = 'array<string>';
      break;
    default:
      base = 'string';
  }
  return required ? base : `option<${base}>`;
}

// ─── DDL generators ──────────────────────────────────────────────────────────

/**
 * Generate DDL for a dynamic entity table with proper workspace-scoped permissions.
 *
 * Produces:
 * - DEFINE TABLE ... SCHEMALESS with owner/member permissions
 * - DEFINE FIELD workspace (record<workspace>)
 * - DEFINE FIELD for each user-defined field
 * - DEFINE FIELD created_at, updated_at
 * - DEFINE INDEX on workspace column
 */
export function entityTableDDL(tableKey: string, fields: FieldDef[]): string {
  const lines: string[] = [];

  lines.push(
    `DEFINE TABLE IF NOT EXISTS ${tableKey} SCHEMALESS${ENTITY_TABLE_PERMISSIONS};`,
  );
  lines.push(
    `DEFINE FIELD IF NOT EXISTS workspace ON TABLE ${tableKey} TYPE record<workspace>;`,
  );

  for (const f of fields) {
    const keyErr = validateFieldKey(f.key);
    if (keyErr) continue; // skip invalid field keys silently — they were already validated upstream
    lines.push(
      `DEFINE FIELD IF NOT EXISTS ${f.key} ON TABLE ${tableKey} TYPE ${surqlType(f.type, f.required)};`,
    );
  }

  lines.push(
    `DEFINE FIELD IF NOT EXISTS created_at ON TABLE ${tableKey} TYPE datetime VALUE time::now();`,
  );
  lines.push(
    `DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ${tableKey} TYPE datetime VALUE time::now();`,
  );
  lines.push(
    `DEFINE INDEX IF NOT EXISTS ${tableKey}_workspace ON TABLE ${tableKey} COLUMNS workspace;`,
  );

  return lines.join('\n');
}

/**
 * Generate DDL for a dynamic relation (edge) table with proper workspace-scoped
 * permissions. Cross-workspace RELATE is blocked by the in.workspace = out.workspace
 * constraint in the permission clause.
 *
 * No `workspace` field on the relation table — access is derived from in.workspace.
 */
export function relationTableDDL(tableKey: string): string {
  return [
    `DEFINE TABLE IF NOT EXISTS ${tableKey} TYPE RELATION SCHEMALESS`,
    `  PERMISSIONS`,
    `    FOR select WHERE`,
    `      in.workspace.owner = $auth`,
    `      OR in.workspace IN $auth<-has_workspace_member<-workspace,`,
    `    FOR create, update, delete WHERE`,
    `      in.workspace.owner = $auth`,
    `      AND in.workspace = out.workspace;`,
    `DEFINE FIELD IF NOT EXISTS created_at ON TABLE ${tableKey} TYPE datetime VALUE time::now();`,
  ].join('\n');
}

// ─── Field key validation ────────────────────────────────────────────────────

const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;
const RESERVED_FIELD_NAMES = new Set(['id', 'in', 'out', 'workspace', 'created_at', 'updated_at']);

function validateFieldKey(key: string): string | null {
  if (!FIELD_KEY_RE.test(key)) {
    return 'Field key must start with a lowercase letter and contain only a-z, 0-9, underscore.';
  }
  if (RESERVED_FIELD_NAMES.has(key)) {
    return `"${key}" is a reserved field name.`;
  }
  return null;
}

export { RESERVED_TABLE_NAMES, type FieldDef, validateFieldKey };
