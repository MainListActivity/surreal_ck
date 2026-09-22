import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Surreal } from "surrealdb";
import { createBrowserConn, type SurrealConn } from "./surreal";
import { createDataCheckService } from "./data-check-runtime";
import { openDataTableRuntime } from "./data-table-runtime";
import { markFindingNotApplicable } from "./finding-repair";
import { toRecordId } from "./record-id";
import { createFindingAssignment, reviewFindingAssignment, submitFindingAssignment } from "./finding-assignment";

const localSurrealTest = test.skipIf(process.env.RUN_LOCAL_SURREALDB_IMPORT_TESTS !== "1");
const opened: Surreal[] = [];
afterEach(async () => { await Promise.allSettled(opened.splice(0).map((db) => db.close())); });

describe("数据体检真实 SurrealDB 契约", () => {
  localSurrealTest("RECORD 成员完整扫描 501 条并把运行与末尾问题保存在当前 workspace", async () => {
    const root = new Surreal();
    opened.push(root);
    const database = `data_check_${Date.now().toString(36)}`;
    const url = process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:18080/rpc";
    const namespace = process.env.LOCAL_SURREAL_NS ?? "main";
    await root.connect(url, { authentication: { username: "root", password: "root" } });
    await root.query(`DEFINE NAMESPACE IF NOT EXISTS ${namespace}; USE NS ${namespace}; DEFINE DATABASE ${database};`).collect();
    await root.use({ namespace, database });
    const migration = await readFile(new URL("../../../shared/sql/workspace-template/025-data-check-findings.surql", import.meta.url), "utf8");
    const repairMigration = await readFile(new URL("../../../shared/sql/workspace-template/027-finding-repair.surql", import.meta.url), "utf8");
    const assignmentMigration = await readFile(new URL("../../../shared/sql/workspace-template/028-finding-assignment-review.surql", import.meta.url), "utf8");
    await root.query(`
      DEFINE TABLE user SCHEMAFULL PERMISSIONS FULL;
      DEFINE FIELD subject ON user TYPE string;
      DEFINE FIELD kind ON user TYPE string;
      DEFINE FIELD is_admin ON user TYPE bool DEFAULT false;
      DEFINE TABLE employee_credential SCHEMAFULL PERMISSIONS NONE;
      DEFINE FIELD employee ON employee_credential TYPE record<user>;
      DEFINE FIELD secret ON employee_credential TYPE string;
      DEFINE FUNCTION fn::current_user() { RETURN $auth.id; } PERMISSIONS FULL;
      DEFINE ACCESS employee_test ON DATABASE TYPE RECORD SIGNIN (
        SELECT * FROM user WHERE subject = $subject AND id = (SELECT VALUE employee FROM employee_credential WHERE secret = $pass LIMIT 1)[0]
      );
      CREATE user:member CONTENT { subject: "member", kind: "human", is_admin: false };
      CREATE user:reviewer CONTENT { subject: "reviewer", kind: "human", is_admin: false };
      CREATE employee_credential:member CONTENT { employee: user:member, secret: "pass" };
      CREATE employee_credential:reviewer CONTENT { employee: user:reviewer, secret: "pass2" };
      DEFINE TABLE workbook SCHEMAFULL PERMISSIONS FOR select WHERE $auth != NONE;
      DEFINE FIELD name ON workbook TYPE string;
      DEFINE TABLE sheet SCHEMAFULL PERMISSIONS FOR select WHERE $auth != NONE;
      DEFINE FIELD workbook ON sheet TYPE record<workbook>;
      DEFINE FIELD label ON sheet TYPE string;
      DEFINE FIELD table_name ON sheet TYPE string;
      DEFINE FIELD column_defs ON sheet TYPE any;
      DEFINE TABLE ent_check SCHEMALESS PERMISSIONS FOR select, update WHERE $auth != NONE;
      DEFINE FIELD updated_at ON ent_check TYPE datetime VALUE time::now();
      CREATE workbook:w SET name = "体检台账";
      CREATE sheet:s SET workbook = workbook:w, label = "记录", table_name = "ent_check", column_defs = [
        { key: "name", label: "名称", field_type: "text", required: true }
      ];
      ${migration}
      ${repairMigration}
      ${assignmentMigration}
    `).collect();
    const rows = Array.from({ length: 501 }, (_, index) => index === 500 ? {} : { name: `记录 ${index + 1}` });
    await root.query("INSERT INTO ent_check $rows", { rows }).collect();

    const member = new Surreal();
    opened.push(member);
    await member.connect(url, { namespace, database });
    await member.signin({ namespace, database, access: "employee_test", variables: { subject: "member", pass: "pass" } });
    const conn = createBrowserConn(member as never) as SurrealConn;
    const service = createDataCheckService(conn);
    const result = await service.start({ workbookId: "workbook:w" });

    expect(result).toMatchObject({ status: "completed", scannedCount: 501, findingCount: 1, stale: false });
    expect(result.findings[0]).toMatchObject({ category: "required", field: "name" });
    expect(await conn.query("SELECT * FROM data_check_run")).toHaveLength(1);
    expect(await conn.query("SELECT * FROM data_check_finding")).toHaveLength(1);
    expect(await service.load(result.id)).toMatchObject({ id: result.id, findingCount: 1 });

    const finding = result.findings[0]!;
    const runtime = await openDataTableRuntime({
      conn, workbookId: "workbook:w", dataTableId: "sheet:s",
      query: { filters: [], filterMode: "and", sorts: [], hiddenFields: [], groupBy: null },
    });
    const preview = await runtime.planRecordFieldRepair({ recordId: finding.recordId as never, fieldKey: "name", value: "补全名称" });
    expect(preview).toMatchObject({ ok: true, value: { before: undefined, after: "补全名称" } });
    if (!preview.ok) throw new Error("真实库修正预览失败");
    expect(await runtime.confirmRecordFieldRepair({
      token: preview.value.token, findingId: finding.id, idempotencyKey: "repair-real-1",
    })).toMatchObject({ ok: true, value: { alreadyConfirmed: false } });
    expect(await runtime.confirmRecordFieldRepair({
      token: preview.value.token, findingId: finding.id, idempotencyKey: "repair-real-1",
    })).toMatchObject({ ok: true, value: { alreadyConfirmed: true } });
    expect(await conn.query("SELECT * FROM data_check_finding_event")).toHaveLength(1);
    expect(await conn.query("SELECT status FROM data_check_finding")).toEqual([expect.objectContaining({ status: "pending_review" })]);

    await markFindingNotApplicable(conn, {
      findingId: finding.id, reason: "经律师确认属于合法例外", idempotencyKey: "not-applicable-real-1",
    });
    expect(await conn.query("SELECT status, resolution_reason FROM data_check_finding")).toEqual([
      expect.objectContaining({ status: "not_applicable", resolution_reason: "经律师确认属于合法例外" }),
    ]);
    expect(await conn.query("SELECT * FROM data_check_finding_event")).toHaveLength(2);
    await runtime.close();

    await conn.query("UPDATE type::table($tb) UNSET name WHERE id = $record", {
      tb: "ent_check", record: toRecordId(finding.recordId),
    });
    const reopened = await service.start({ workbookId: "workbook:w" });
    expect(reopened).toMatchObject({ status: "completed", findingCount: 1 });
    expect(await conn.query("SELECT status, resolution_reason FROM data_check_finding")).toEqual([
      expect.objectContaining({ status: "pending", resolution_reason: undefined }),
    ]);

    const assignment = await createFindingAssignment(conn, {
      findingIds: [finding.id], assigneeId: "user:member", reviewerId: "user:reviewer",
      dueAt: "2026-10-01T00:00:00Z", completionCondition: "补齐名称并完成体检", idempotencyKey: "assignment-real-1",
    });
    const submitted = await submitFindingAssignment(conn, {
      assignmentId: assignment.id, expectedVersion: assignment.version, note: "已处理，待复核",
      resourceIds: [], idempotencyKey: "assignment-submit-real-1",
    });
    expect(await conn.query("SELECT handlers, active_assignment FROM data_check_finding")).toEqual([
      expect.objectContaining({ handlers: expect.any(Array), active_assignment: expect.anything() }),
    ]);
    const reviewer = new Surreal();
    opened.push(reviewer);
    await reviewer.connect(url, { namespace, database });
    await reviewer.signin({ namespace, database, access: "employee_test", variables: { subject: "reviewer", pass: "pass2" } });
    const reviewerConn = createBrowserConn(reviewer as never) as SurrealConn;
    const returned = await reviewFindingAssignment(reviewerConn, {
      assignmentId: assignment.id, expectedVersion: submitted.version, decision: "return",
      reason: "请补充最新体检", idempotencyKey: "assignment-return-real-1",
    });
    const resubmitted = await submitFindingAssignment(conn, {
      assignmentId: assignment.id, expectedVersion: returned.version, note: "已补充并再次提交",
      resourceIds: [], idempotencyKey: "assignment-submit-real-2",
    });
    await conn.updateRecord(finding.recordId, { name: "复核完成名称" });
    await service.start({ workbookId: "workbook:w" });
    const approved = await reviewFindingAssignment(reviewerConn, {
      assignmentId: assignment.id, expectedVersion: resubmitted.version, decision: "approve",
      idempotencyKey: "assignment-approve-real-1",
    });
    expect(approved.status).toBe("completed");
    expect(await reviewerConn.query("SELECT status FROM data_check_finding")).toEqual([expect.objectContaining({ status: "closed" })]);
  }, 20_000);
});
