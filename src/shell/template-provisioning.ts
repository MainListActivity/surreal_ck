import type { Surreal } from 'surrealdb';

import type { TemplateKey } from '../features/workbook/mock-data';

export interface ProvisioningResult {
  ok: true;
  workspaceId: string;
  workbookId: string;
}

export interface ProvisioningError {
  ok: false;
  step: string;
  message: string;
}

/**
 * Provisions a workspace + workbook from a template.
 *
 * Strategy (from the plan):
 * 1. Run DDL first (idempotent DEFINE TABLE/FIELD statements) — no transaction needed.
 * 2. Run DML (CREATE/UPSERT/RELATE) in a BEGIN/COMMIT transaction.
 * 3. On any failure, compensating cleanup removes DML records; orphaned DDL is safe
 *    because DEFINE TABLE IF NOT EXISTS is a no-op on retry.
 *
 * The SurrealQL scripts live in schema/templates/ and are inlined at build time
 * via Vite's `?raw` import. This keeps the client bundle self-contained with no
 * separate fetch required.
 */

// Vite raw imports — bundled at build time.
// The `?raw` suffix tells Vite to import the file as a plain string.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — Vite raw import, not a TS module
import legalEntityTrackerSurql from '../../schema/templates/legal-entity-tracker.surql?raw';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import caseManagementSurql from '../../schema/templates/case-management.surql?raw';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import blankWorkspaceSurql from '../../schema/templates/blank-workspace.surql?raw';

const TEMPLATE_SCRIPTS: Record<TemplateKey, string> = {
  'legal-entity-tracker': legalEntityTrackerSurql as string,
  'case-management': caseManagementSurql as string,
  'blank-workspace': blankWorkspaceSurql as string,
};

const TEMPLATE_NAMES: Record<TemplateKey, string> = {
  'legal-entity-tracker': 'Legal Entity Tracker',
  'case-management': 'Case Management',
  'blank-workspace': 'Blank Workspace',
};

export async function provisionTemplate(
  db: Surreal,
  templateKey: TemplateKey,
  workspaceName: string,
  workspaceSlug: string,
  ownerUserId: string,
): Promise<ProvisioningResult | ProvisioningError> {
  let workspaceId: string | undefined;
  let workbookId: string | undefined;

  try {
    // Step 1: Create workspace record.
    const [ws] = await db.query<[string[]]>(
      `LET $workspace = (INSERT INTO workspace { name: $name, slug: $slug } RETURN AFTER)[0];
       RELATE $owner->owns_workspace->$workspace;
       RETURN $workspace.id`,
      { name: workspaceName, slug: workspaceSlug, owner: ownerUserId },
    );
    if (!ws?.[0]) {
      return { ok: false, step: 'workspace-create', message: 'Failed to create workspace record.' };
    }
    workspaceId = ws[0];

    // Step 2: Create workbook record.
    const [wb] = await db.query<[string[]]>(
      `LET $workbook = (INSERT INTO workbook { workspace: $ws, name: $name, template_key: $tk } RETURN AFTER)[0];
       RELATE $ws->workspace_has_workbook->$workbook;
       RETURN $workbook.id`,
      { ws: workspaceId, name: TEMPLATE_NAMES[templateKey], tk: templateKey },
    );
    if (!wb?.[0]) {
      return { ok: false, step: 'workbook-create', message: 'Failed to create workbook record.' };
    }
    workbookId = wb[0];

    // Step 3: Run the template provisioning script.
    // $ws, $wb are record references. $ws_key is the workspace nanoid used in
    // dynamic table name prefixes (e.g. "harbor" → ent_harbor_company).
    const wsKey = workspaceId.split(':')[1] ?? workspaceId;
    const script = TEMPLATE_SCRIPTS[templateKey];
    await db.query(script, { ws: workspaceId, wb: workbookId, ws_key: wsKey });

    return { ok: true, workspaceId, workbookId };
  } catch (err) {
    // Compensating cleanup: remove DML records created before the failure.
    // DDL (DEFINE TABLE etc.) is idempotent and left in place — safe to retry.
    await compensatingCleanup(db, workspaceId, workbookId);

    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, step: 'template-script', message };
  }
}

/**
 * Removes workspace + workbook records created before a provisioning failure.
 * Entity type records and sample data created by the template script are cascade-
 * deleted when the workspace is removed (via workspace field reference).
 *
 * This is best-effort: if cleanup itself fails, the partial records are orphaned
 * but do not affect other workspaces.
 */
async function compensatingCleanup(
  db: Surreal,
  workspaceId: string | undefined,
  workbookId: string | undefined,
): Promise<void> {
  try {
    if (workbookId) {
      // Remove sheets and their workbook edges, then the workbook itself.
      await db.query(
        `DELETE workbook_has_sheet WHERE in = $wb;
         DELETE sheet WHERE workbook = $wb;
         DELETE workspace_has_workbook WHERE out = $wb;
         DELETE $wb`,
        { wb: workbookId },
      );
    }
    if (workspaceId) {
      // Remove workspace-scoped records. Dynamic entity/relation tables (ent_*, rel_*)
      // are DDL and left in place — they are idempotent to re-create on retry.
      await db.query(
        `DELETE edge_catalog WHERE workspace = $ws;
         DELETE form_definition WHERE workspace = $ws;
         DELETE workspace_member WHERE workspace = $ws;
         DELETE workspace_has_member WHERE in = $ws;
         DELETE owns_workspace WHERE out = $ws;
         DELETE $ws`,
        { ws: workspaceId },
      );
    }
  } catch {
    // Cleanup failure is non-fatal — log to client_error in a fire-and-forget manner.
    void db
      .query('CREATE client_error CONTENT { error_code: "CLEANUP_FAILED", message: $msg }', {
        msg: `Compensating cleanup failed for workspace=${workspaceId ?? 'unknown'}`,
      })
      .catch(() => undefined);
  }
}
