/**
 * Template Provisioning（local-first 版本）
 *
 * 移除了 DDL proxy 和 OIDC auth 依赖。
 * local-first 架构下，Bun 主进程持有 root 权限，
 * 可直接执行 DEFINE TABLE 等 DDL 操作（通过 IPC dbQuery）。
 */
import type { DbAdapter } from '../lib/surreal/db-adapter';
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

// 使用 import attributes 以内联文本，兼容 electrobun 的 Bun.build 和 Vite。
import legalEntityTrackerSurql from '../../schema/templates/legal-entity-tracker.surql' with { type: 'text' };
import caseManagementSurql from '../../schema/templates/case-management.surql' with { type: 'text' };
import blankWorkspaceSurql from '../../schema/templates/blank-workspace.surql' with { type: 'text' };

const TEMPLATE_SCRIPTS: Record<TemplateKey, string> = {
  'legal-entity-tracker': legalEntityTrackerSurql as string,
  'case-management': caseManagementSurql as string,
  'blank-workspace': blankWorkspaceSurql as string,
};

export async function provisionTemplate(
  db: DbAdapter,
  templateKey: TemplateKey,
  workspaceId: string,
  workbookName: string,
): Promise<ProvisioningResult | ProvisioningError> {
  let workbookId: string | undefined;

  try {
    // Step 1: 创建 workbook 记录
    const result = await db.create('workbook', {
      workspace: toRecordId(workspaceId),
      name: workbookName,
      template_key: templateKey,
    });
    const workbook = result as unknown as Workbook;
    if (!workbook?.id) {
      return { ok: false, step: 'workbook-create', message: 'Failed to create workbook record.' };
    }
    workbookId = String(workbook.id);

    // Step 2: 执行模板 SurrealQL（local-first 下主进程有 root 权限，DDL 直接执行）
    const wsKey = workspaceId.split(':')[1] ?? workspaceId;
    const script = TEMPLATE_SCRIPTS[templateKey];
    await db.query(script, {
      ws: toRecordId(workspaceId),
      wb: toRecordId(workbookId),
      ws_key: wsKey,
    });

    return { ok: true, workspaceId, workbookId };
  } catch (err) {
    await compensatingCleanup(db, workspaceId, workbookId);
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, step: 'template-script', message };
  }
}

async function compensatingCleanup(
  db: DbAdapter,
  workspaceId: string,
  workbookId: string | undefined,
): Promise<void> {
  try {
    if (workbookId) {
      const sheets = await db.query<Sheet[]>('SELECT * FROM sheet WHERE workbook = $wb', {
        wb: toRecordId(workbookId),
      });
      const workbookSheets = Array.isArray(sheets) ? sheets : [];

      const forms = await db.query<FormDefinition[]>('SELECT * FROM form_definition WHERE workspace = $ws', {
        ws: toRecordId(workspaceId),
      });
      const workbookSheetIds = workbookSheets.map((s) => String(s.id));
      const workbookForms = (Array.isArray(forms) ? forms : []).filter((f) =>
        workbookSheetIds.includes(String(f.target_sheet)),
      );

      for (const form of workbookForms) await db.delete(String(form.id));
      for (const sheet of workbookSheets) await db.delete(String(sheet.id));
      await db.delete(workbookId);
    }
  } catch {
    void db
      .create('client_error', {
        error_code: 'CLEANUP_FAILED',
        message: `Compensating cleanup failed for workspace=${workspaceId}`,
      })
      .catch(() => undefined);
  }
}
