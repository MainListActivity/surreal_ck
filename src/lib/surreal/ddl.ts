/**
 * Generates standardised SurrealQL DDL for dynamic entity and relation tables.
 *
 * Every dynamic table gets the same workspace-scoped, owner/member permission
 * pattern used by the static tables in schema/main.surql. This eliminates the
 * security risk of hand-coding DDL in the frontend or templates.
 */

// ─── Reserved names ──────────────────────────────────────────────────────────

const RESERVED_TABLE_NAMES = new Set([
  'app_user', 'workspace', 'workbook', 'workspace_member', 'mutation',
  'snapshot', 'presence', 'field_type', 'entity_type', 'relation_type',
  'form_definition', 'intake_submission', 'client_error', 'workbook_file',
  // edge tables
  'owns_workspace', 'workspace_has_workbook', 'workspace_has_member',
  'member_identifies_user', 'workspace_has_entity_type', 'workspace_has_relation_type',
  'relation_from_type', 'relation_to_type', 'workspace_has_form_definition',
  'form_targets_entity_type', 'workspace_has_submission', 'submission_uses_form',
  'workspace_has_client_error', 'workbook_has_client_error', 'workspace_has_file',
  'file_uploaded_by_user', 'workspace_has_presence', 'workbook_has_presence',
  'presence_user', 'workspace_has_mutation', 'workbook_has_mutation',
  'mutation_actor_user', 'workspace_has_snapshot', 'workbook_has_snapshot',
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
      workspace IN $auth->owns_workspace->workspace
      OR workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      workspace IN $auth->owns_workspace->workspace`;

/**
 * Standard workspace-scoped permissions for a dynamic relation (edge) table.
 * Uses the IN record's workspace field to scope access.
 */
const RELATION_TABLE_PERMISSIONS = `
  PERMISSIONS
    FOR select WHERE
      in.workspace IN $auth->owns_workspace->workspace
      OR in.workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace IN $auth->owns_workspace->workspace`;

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
 * permissions and typed IN/OUT constraints.
 *
 * `fromTable` and `toTable` are the entity table keys that this relation connects.
 */
export function relationTableDDL(
  tableKey: string,
  fromTable: string,
  toTable: string,
): string {
  const lines: string[] = [];

  lines.push(
    `DEFINE TABLE IF NOT EXISTS ${tableKey} TYPE RELATION IN ${fromTable} OUT ${toTable} SCHEMALESS${RELATION_TABLE_PERMISSIONS};`,
  );
  lines.push(
    `DEFINE FIELD IF NOT EXISTS workspace ON TABLE ${tableKey} TYPE record<workspace>;`,
  );
  lines.push(
    `DEFINE FIELD IF NOT EXISTS created_at ON TABLE ${tableKey} TYPE datetime VALUE time::now();`,
  );

  return lines.join('\n');
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
