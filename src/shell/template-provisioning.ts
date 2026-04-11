import { Table, type Surreal } from 'surrealdb';

import { toRecordId } from '../lib/surreal/record-id';
import type { FormDefinition, Sheet, Workbook } from '../lib/surreal/types';

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
 * Provisions a workbook inside the current workspace from a template.
 *
 * Strategy (from the plan):
 * 1. Insert the workbook record into the target workspace.
 * 2. Run template DDL/DML initialization.
 * 3. On any failure, compensating cleanup removes the workbook and any sheet/form data
 *    created for that workbook; orphaned DDL is safe because DEFINE TABLE IF NOT EXISTS
 *    is a no-op on retry.
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

export async function provisionTemplate(
  db: Surreal,
  templateKey: TemplateKey,
  workspaceId: string,
  workbookName: string,
): Promise<ProvisioningResult | ProvisioningError> {
  let workbookId: string | undefined;

  try {
    // Step 1: Insert workbook into the existing workspace table.
    const insertedWorkbook = (await db.insert(new Table('workbook'), {
      workspace: toRecordId(workspaceId),
      name: workbookName,
      template_key: templateKey,
    })) as Workbook[];
    const workbook = Array.isArray(insertedWorkbook) ? insertedWorkbook[0] : insertedWorkbook;
    if (!workbook?.id) {
      return { ok: false, step: 'workbook-create', message: 'Failed to create workbook record.' };
    }
    workbookId = String(workbook.id);

    // Step 2: Run the template provisioning script.
    // $ws, $wb are record references. $ws_key is the workspace nanoid used in
    // dynamic table name prefixes (e.g. "harbor" → ent_harbor_company).
    const wsKey = workspaceId.split(':')[1] ?? workspaceId;
    const script = TEMPLATE_SCRIPTS[templateKey];
    await db.query(script, { ws: toRecordId(workspaceId), wb: toRecordId(workbookId), ws_key: wsKey });

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
  workspaceId: string,
  workbookId: string | undefined,
): Promise<void> {
  try {
    if (workbookId) {
      const sheets = await db.select<Sheet>(new Table('sheet'));
      const workbookSheetIds = (Array.isArray(sheets) ? sheets : [])
        .filter((sheet) => String(sheet.workbook) === workbookId)
        .map((sheet) => String(sheet.id));

      const forms = await db.select<FormDefinition>(new Table('form_definition'));
      const workbookForms = (Array.isArray(forms) ? forms : [])
        .filter((form) => String(form.workspace) === workspaceId && workbookSheetIds.includes(String(form.target_sheet)));

      for (const form of workbookForms) {
        await db.delete(toRecordId(String(form.id)));
      }

      for (const sheetId of workbookSheetIds) {
        await db.delete(toRecordId(sheetId));
      }

      await db.delete(toRecordId(workbookId));
    }
  } catch {
    // Cleanup failure is non-fatal — log to client_error in a fire-and-forget manner.
    void db
      .insert(new Table('client_error'), {
        error_code: 'CLEANUP_FAILED',
        message: `Compensating cleanup failed for workspace=${workspaceId}`,
      })
      .catch(() => undefined);
  }
}
