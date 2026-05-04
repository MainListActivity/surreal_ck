import { DateTime, RecordId, StringRecordId } from "surrealdb";
import { getLocalDb } from "../db/index";
import { assertCanWriteWorkspace } from "./context";
import { ServiceError } from "./errors";
import { getTemplateDef, listTemplateSummaries, type EntityDef } from "../templates/catalog";
import { createEntityRows, provisionEntityFields, provisionEntityTable, provisionRelationTable } from "./data-table-runtime";
import { ensureWorkbookMetadataSchema } from "./workbooks";
import type {
  ListTemplatesResponse,
  CreateWorkbookFromTemplateRequest,
  CreateWorkbookFromTemplateResponse,
  WorkbookSummaryDTO,
} from "../../shared/rpc.types";

// ─── 列表 ─────────────────────────────────────────────────────────────────────

export function listTemplates(): ListTemplatesResponse {
  return { templates: listTemplateSummaries() };
}

// ─── 从模板创建工作簿 ─────────────────────────────────────────────────────────

export async function createWorkbookFromTemplate({
  workspaceId,
  templateKey,
  name,
}: CreateWorkbookFromTemplateRequest): Promise<CreateWorkbookFromTemplateResponse> {
  await assertCanWriteWorkspace(workspaceId);

  const tpl = getTemplateDef(templateKey);
  if (!tpl) {
    throw new ServiceError("VALIDATION_ERROR", `未知模板: ${templateKey}`);
  }

  const db = getLocalDb();
  const wsId = new StringRecordId(workspaceId);

  // 生成 workspace key（用于动态表名前缀）
  const wsRaw = workspaceId.replace(/^workspace:/, "");
  const wsKey = wsRaw.slice(0, 8);

  // 生成 workbook id
  const wbKey = Bun.hash.wyhash(`${workspaceId}:wb:${templateKey}:${Date.now()}`).toString(16).padStart(16, "0");
  const wbId = new RecordId("workbook", wbKey);

  const workbookName = name?.trim() || tpl.name;

  await ensureWorkbookMetadataSchema();

  // ── Step 1: DDL provisioning（entity + relation 表）────────────────────────
  for (const entity of tpl.entities) {
    const tableName = entityTableName(wsKey, wbKey, entity.key);
    await provisionEntityTable(tableName);
    await provisionEntityFields(tableName, entity.columnDefs.map((col) => ({
      key: col.key,
      label: col.label,
      fieldType: col.field_type,
      required: col.required,
      options: col.options,
    })));
  }
  for (const rel of tpl.relations) {
    const tableName = relationTableName(wsKey, wbKey, rel.key);
    await provisionRelationTable(tableName);
  }

  // ── Step 2: 创建 workbook 和 sheet 记录 ────────────────────────────────────
  const firstEntity = tpl.entities[0];
  const firstSheetId = makeSheetId(wbKey, firstEntity.key);

  await db.query(
    `UPSERT $wbId CONTENT {
      workspace: $ws,
      name: $name,
      template_key: $templateKey,
      last_opened_sheet: $firstSheetId
    }`,
    { wbId, ws: wsId, name: workbookName, templateKey, firstSheetId }
  );

  // 创建每个 sheet 记录
  for (const entity of tpl.entities) {
    await upsertSheetRecord(wsKey, wbKey, wbId, entity);
  }

  // ── Step 3: edge_catalog ─────────────────────────────────────────────────
  for (const rel of tpl.relations) {
    const catalogKey = `${wbKey}_${rel.key}`;
    const relId = new RecordId("edge_catalog", `${catalogKey}_${wsKey}`);
    await db.query(
      `UPSERT $ecId CONTENT {
        workspace: $ws,
        key: $key,
        label: $label,
        rel_table: $relTable,
        from_table: $fromTable,
        to_table: $toTable,
        edge_props: $edgeProps
      }`,
      {
        ecId: relId,
        ws: wsId,
        key: catalogKey,
        label: rel.label,
        relTable: relationTableName(wsKey, wbKey, rel.key),
        fromTable: entityTableName(wsKey, wbKey, rel.fromEntityKey),
        toTable: entityTableName(wsKey, wbKey, rel.toEntityKey),
        edgeProps: rel.edgeProps ?? [],
      }
    );
  }

  // ── Step 4: 样例数据（仅 hasSampleData 模板）──────────────────────────────
  if (tpl.hasSampleData) {
    try {
      await insertSampleData(templateKey, wsKey, wbKey, wsId, db);
    } catch (err) {
      // 样例数据失败不阻止模板创建
      console.warn("[templates] 样例数据插入失败:", err);
    }
  }

  // ── 读取最终 workbook ────────────────────────────────────────────────────
  type WorkbookRow = { id: RecordId; workspace: RecordId; name: string; template_key?: string; updated_at: Date };
  const wbRows = await db.query<[WorkbookRow[]]>(
    `SELECT id, workspace, name, template_key, updated_at FROM workbook WHERE id = $wbId`,
    { wbId }
  );
  const wbRow = wbRows[0]?.[0];
  if (!wbRow) throw new ServiceError("INTERNAL_ERROR", "工作簿创建后读取失败");

  const workbook: WorkbookSummaryDTO = {
    id: String(wbRow.id),
    workspaceId: String(wbRow.workspace),
    name: wbRow.name,
    templateKey: wbRow.template_key,
    updatedAt: wbRow.updated_at instanceof Date ? wbRow.updated_at.toISOString() : String(wbRow.updated_at),
  };

  return { workbook };
}

// ─── 内部：创建 sheet 记录 ─────────────────────────────────────────────────────

function entityTableName(wsKey: string, wbKey: string, entityKey: string): string {
  return `ent_${wsKey}_${wbKey.slice(0, 8)}_${entityKey}`;
}

function relationTableName(wsKey: string, wbKey: string, relKey: string): string {
  return `rel_${wsKey}_${wbKey.slice(0, 8)}_${relKey}`;
}

function makeSheetId(wbKey: string, entityKey: string): RecordId {
  return new RecordId("sheet", `${wbKey}_${entityKey}`);
}

async function upsertSheetRecord(
  wsKey: string,
  wbKey: string,
  wbId: RecordId,
  entity: EntityDef
): Promise<void> {
  const db = getLocalDb();
  const sheetId = makeSheetId(wbKey, entity.key);
  const tableName = entityTableName(wsKey, wbKey, entity.key);

  await db.query(
    `UPSERT $sheetId CONTENT {
      workbook: $wbId,
      univer_id: rand::ulid(),
      table_name: $tableName,
      label: $label,
      position: $position,
      column_defs: $columnDefs
    }`,
    {
      sheetId,
      wbId,
      tableName,
      label: entity.label,
      position: entity.position,
      columnDefs: entity.columnDefs,
    }
  );
}

// ─── 内部：样例数据 ────────────────────────────────────────────────────────────

async function insertSampleData(
  templateKey: string,
  wsKey: string,
  wbKey: string,
  wsId: StringRecordId,
  db: ReturnType<typeof getLocalDb>
): Promise<void> {
  if (templateKey === "case-management") {
    const tblCase     = entityTableName(wsKey, wbKey, "case");
    const tblClient   = entityTableName(wsKey, wbKey, "client");
    const tblDocument = entityTableName(wsKey, wbKey, "document");
    const relAssigned = relationTableName(wsKey, wbKey, "assigned_to");
    const relBelongs  = relationTableName(wsKey, wbKey, "belongs_to");

    const [redwood, triton] = await createEntityRows(tblClient, [
      { workspace: wsId, name: "Redwood Group", email: "legal@redwood.example.com" },
      { workspace: wsId, name: "Triton Corp", email: "counsel@triton.example.com" },
    ]);
    const [case1, case2] = await createEntityRows(tblCase, [
      { workspace: wsId, title: "Redwood v. Triton", matter_id: "2026-001", status: "Open", opened_at: new DateTime() },
      { workspace: wsId, title: "Triton v. Harbor LLC", matter_id: "2026-002", status: "Pending", opened_at: new DateTime() },
    ]);
    const [motion] = await createEntityRows(tblDocument, [
      { workspace: wsId, title: "Motion 42 — Summary Judgment", doc_type: "Motion", filed_at: new DateTime() },
    ]);

    if (redwood && triton && case1 && case2 && motion) {
      await db.query(
        `RELATE $case1->${relAssigned}->$redwood;
         RELATE $case2->${relAssigned}->$triton;
         RELATE $motion->${relBelongs}->$case1;`,
        { case1, case2, motion, redwood, triton }
      );
    }
  } else if (templateKey === "legal-entity-tracker") {
    const tblCompany = entityTableName(wsKey, wbKey, "company");
    const tblPerson  = entityTableName(wsKey, wbKey, "person");
    const relOwns    = relationTableName(wsKey, wbKey, "owns");
    const relControls = relationTableName(wsKey, wbKey, "controls");
    const relFiledBy = relationTableName(wsKey, wbKey, "filed_by");

    const [acme, beta, gamma] = await createEntityRows(tblCompany, [
      { workspace: wsId, name: "Acme Holdings", jurisdiction: "Delaware", status: "Active" },
      { workspace: wsId, name: "Beta LLC", jurisdiction: "Hong Kong", status: "Active" },
      { workspace: wsId, name: "Gamma Inc", jurisdiction: "Singapore", status: "Pending" },
    ]);
    const [chen] = await createEntityRows(tblPerson, [
      { workspace: wsId, name: "Chen Wei", email: "chen@example.com", role: "Director" },
    ]);

    if (acme && beta && gamma && chen) {
      await db.query(
        `RELATE $acme->${relOwns}->$beta;
         RELATE $beta->${relControls}->$gamma;
         RELATE $gamma->${relFiledBy}->$chen;`,
        { acme, beta, gamma, chen }
      );
    }
  }
}
