import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { Surreal } from "surrealdb";
import { Hono } from "hono";
import { shareActivationSummarySchema } from "@surreal-ck/shared";
import { buildActivationSummaryV2 } from "./activation-outcomes";
import { createDataCheckService } from "./data-check-runtime";
import { openDataTableRuntime } from "./data-table-runtime";
import { createFindingAssignment, reviewFindingAssignment, submitFindingAssignment } from "./finding-assignment";
import { markFindingNotApplicable } from "./finding-repair";
import { createImportBatchService } from "./import-batch";
import { createImportBatchUndoService } from "./import-batch-undo";
import { createBrowserConn, type SurrealConn } from "./surreal";
import type { TemplateImportMapping } from "./template-sheet-import";

const enabled = process.env.RUN_LOCAL_SURREALDB_JOINT_ACCEPTANCE === "1";
const localTest = test.skipIf(!enabled);
const namespace = "main";
const sessions: Surreal[] = [];
let endpoint = "";
let surrealProcess: ReturnType<typeof Bun.spawn> | null = null;
let jwksServer: ReturnType<typeof Bun.serve> | null = null;
let privateKey: KeyLike | null = null;

async function loadHarness() {
  process.env.NODE_ENV ??= "test";
  process.env.HOST ??= "127.0.0.1";
  process.env.PORT ??= "18080";
  process.env.SURREAL_URL ??= "ws://127.0.0.1:65535/rpc";
  process.env.SURREAL_NS ??= "main";
  process.env.SURREAL_ROOT_USER ??= "root";
  process.env.SURREAL_ROOT_PASS ??= "test-root-pass";
  process.env.OIDC_ISSUER ??= "http://127.0.0.1:18081/issuer";
  process.env.OIDC_JWKS_URL ??= "http://127.0.0.1:18081/jwks";
  process.env.OIDC_AUDIENCE ??= "surreal-ck-test";
  process.env.IDP_HOOK_SECRET ??= "test-hook-secret";
  return await import("@surreal-ck/server/acceptance-harness");
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("port unavailable"));
      server.close(() => resolve(address.port));
    });
  });
}

async function rootSession(database: string): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(`${endpoint}/rpc`);
  await db.signin({ username: "root", password: "root" });
  await db.use({ namespace, database });
  sessions.push(db);
  return db;
}

async function signToken(issuer: string, subject: string, claims: Record<string, unknown>, audience?: string): Promise<string> {
  if (!privateKey) throw new Error("jwks key missing");
  let token = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "joint-acceptance" })
    .setSubject(subject)
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime("1h");
  if (audience) token = token.setAudience(audience);
  return await token.sign(privateKey);
}

async function openCaller(database: string, token: string): Promise<SurrealConn> {
  const db = new Surreal();
  sessions.push(db);
  await db.connect(`${endpoint}/rpc`);
  await db.use({ namespace, database });
  await db.authenticate(token);
  return createBrowserConn(db as never);
}

async function applyWorkspaceTemplate(
  database: string,
  loadTemplateScripts: Awaited<ReturnType<typeof loadHarness>>["loadTemplateScripts"],
  workspaceTemplateVersion: number,
  jwksUrl: string,
): Promise<void> {
  const root = await rootSession(database);
  const scripts = await loadTemplateScripts({ oidcJwksUrl: jwksUrl });
  expect(scripts.at(-1)?.version).toBe(workspaceTemplateVersion);
  for (const script of scripts) {
    try {
      await root.query(script.sql).collect();
    } catch (error) {
      throw new Error(`${script.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

describe("律师团队与主动运营联合验收", () => {
  afterAll(async () => {
    await Promise.all(sessions.map((db) => db.close()));
    jwksServer?.stop(true);
    surrealProcess?.kill();
    if (surrealProcess) await surrealProcess.exited;
  });

  localTest("隔离库里完成导入、体检、复核、摘要共享和 agent 接管", async () => {
    const {
      loadTemplateScripts,
      WORKSPACE_TEMPLATE_VERSION,
      ActivationSummaryService,
      createActivationSummaryRoutes,
      createContentMcpRoutes,
      createPlatformOperatorCapabilityReader,
      ensureSystemSchema,
      env,
      ExternalOpsAgentRunner,
      handleError,
      InMemoryPlatformContentStore,
      OpsAutonomyService,
      OpsFollowUpService,
      OpsProposalService,
      OpsRunService,
      PlatformContentService,
      requirePlatformOperator,
      SurrealActivationSummaryStore,
      SurrealOpsAutonomyStore,
      SurrealOpsFollowUpStore,
      SurrealOpsProposalStore,
      SurrealOpsRunStore,
    } = await loadHarness();
    const port = await freePort();
    endpoint = `ws://127.0.0.1:${port}`;
    surrealProcess = Bun.spawn(["surreal", "start", "--no-banner", "--log", "none", "--allow-net", "127.0.0.1", "--bind", `127.0.0.1:${port}`, "--user", "root", "--pass", "root", "memory"], { stdout: "ignore", stderr: "ignore" });
    for (let attempt = 0; attempt < 50; attempt++) {
      const ready = Bun.spawn(["surreal", "is-ready", "--endpoint", endpoint], { stdout: "ignore", stderr: "ignore" });
      if (await ready.exited === 0) break;
      await Bun.sleep(100);
    }
    const keys = await generateKeyPair("RS256", { extractable: true });
    privateKey = keys.privateKey;
    const jwk = await exportJWK(keys.publicKey);
    jwk.kid = "joint-acceptance";
    jwk.alg = "RS256";
    jwk.use = "sig";
    const jwksUrl = new URL(env.OIDC_JWKS_URL);
    jwksServer = Bun.serve({
      hostname: "127.0.0.1",
      port: Number(jwksUrl.port),
      fetch(request) {
        return new URL(request.url).pathname === jwksUrl.pathname
          ? Response.json({ keys: [jwk] })
          : new Response("not found", { status: 404 });
      },
    });

    const system = await rootSession("_system");
    const migrated = await ensureSystemSchema(system, { namespace });
    expect(migrated.toVersion).toBeGreaterThanOrEqual(20);
    await applyWorkspaceTemplate("ws_joint", loadTemplateScripts, WORKSPACE_TEMPLATE_VERSION, env.OIDC_JWKS_URL);
    await applyWorkspaceTemplate("ws_other", loadTemplateScripts, WORKSPACE_TEMPLATE_VERSION, env.OIDC_JWKS_URL);

    const systemRoot = await rootSession("_system");
    await systemRoot.query(`
      CREATE workspace:joint SET db_name = "ws_joint", owner_subject = "admin-joint", slug = "team-joint", name = "联合验收", status = "active";
      CREATE workspace:other SET db_name = "ws_other", owner_subject = "admin-other", slug = "team-other", name = "另一工作区", status = "active";
      CREATE user_workspace_index:joint SET subject = "admin-joint", email = "admin@joint.test", workspace = workspace:joint, db_name = "ws_joint", role = "admin";
      CREATE user_workspace_index:other SET subject = "admin-other", email = "admin@other.test", workspace = workspace:other, db_name = "ws_other", role = "admin";
      CREATE platform_operator:human SET subject = "ops-human", kind = "human", status = "active";
      CREATE platform_operator:agent SET subject = "ops-agent", kind = "agent", status = "active";
      CREATE platform_operator_capability:human_summary SET operator = platform_operator:human, capability = "activation.summary.read", status = "active", granted_by_subject = "admin-joint";
      CREATE platform_operator_capability:human_content SET operator = platform_operator:human, capability = "content.read", status = "active", granted_by_subject = "admin-joint";
      CREATE platform_operator_capability:human_autonomy_read SET operator = platform_operator:human, capability = "activation.autonomy.read", status = "active", granted_by_subject = "admin-joint";
      CREATE platform_operator_capability:human_autonomy_manage SET operator = platform_operator:human, capability = "activation.autonomy.manage", status = "active", granted_by_subject = "admin-joint";
      CREATE platform_operator_capability:human_takeover SET operator = platform_operator:human, capability = "activation.proposal.takeover", status = "active", granted_by_subject = "admin-joint";
      CREATE platform_operator_capability:human_review SET operator = platform_operator:human, capability = "activation.proposal.review", status = "active", granted_by_subject = "admin-joint";
      CREATE platform_operator_capability:human_proposal_read SET operator = platform_operator:human, capability = "activation.proposal.read", status = "active", granted_by_subject = "admin-joint";
      CREATE platform_operator_capability:human_follow_read SET operator = platform_operator:human, capability = "activation.followup.read", status = "active", granted_by_subject = "admin-joint";
      CREATE platform_operator_capability:human_follow_write SET operator = platform_operator:human, capability = "activation.followup.write", status = "active", granted_by_subject = "admin-joint";
      CREATE platform_operator_capability:human_proposal_submit SET operator = platform_operator:human, capability = "activation.proposal.submit", status = "active", granted_by_subject = "admin-joint";
      CREATE platform_operator_capability:agent_follow_read SET operator = platform_operator:agent, capability = "activation.followup.read", status = "active", granted_by_subject = "admin-joint";
      CREATE platform_operator_capability:agent_follow_write SET operator = platform_operator:agent, capability = "activation.followup.write", status = "active", granted_by_subject = "admin-joint";
      CREATE platform_operator_capability:agent_proposal_read SET operator = platform_operator:agent, capability = "activation.proposal.read", status = "active", granted_by_subject = "admin-joint";
      CREATE platform_operator_capability:agent_proposal_submit SET operator = platform_operator:agent, capability = "activation.proposal.submit", status = "active", granted_by_subject = "admin-joint";
    `).collect();

    const workspace = await rootSession("ws_joint");
    await workspace.query(`
      CREATE user:admin SET subject = "admin-joint", email = "admin@joint.test", display_name = "管理员", kind = "human", is_admin = true;
      CREATE user:member SET subject = "member-joint", email = "member@joint.test", display_name = "律师", kind = "human", is_admin = false;
      CREATE user:reviewer SET subject = "reviewer-joint", email = "reviewer@joint.test", display_name = "复核人", kind = "human", is_admin = false;
      CREATE workbook_template:joint SET key = "joint", label = "联合验收模板", sheet_defs = [
        { key: "claims", label: "债权", column_defs: [
          { key: "name", label: "名称", field_type: "text" },
          { key: "amount", label: "金额", field_type: "decimal" },
          { key: "case_no", label: "案号", field_type: "text" },
          { key: "creditor", label: "债权人", field_type: "reference" }
        ] },
        { key: "creditors", label: "债权人", column_defs: [
          { key: "name", label: "名称", field_type: "text" }
        ] }
      ], check_rules = { version: "joint-v1", rules: [
        { key: "same_name", type: "duplicate", sheet_key: "claims", fields: ["name"], minimum_group_size: 2, explanation: "名称规范化后相同，仅供核验，不自动合并" },
        { key: "creditor_exists", type: "reference_exists", sheet_key: "claims", field: "creditor", target_sheet_key: "creditors", explanation: "债权人引用不存在" }
      ] };
      DEFINE TABLE ent_claim SCHEMALESS PERMISSIONS FOR select, create, update WHERE $auth != NONE, FOR delete WHERE $auth.is_admin = true;
      DEFINE FIELD updated_at ON ent_claim TYPE datetime VALUE time::now();
      DEFINE TABLE ent_creditor SCHEMALESS PERMISSIONS FOR select, create, update WHERE $auth != NONE, FOR delete WHERE $auth.is_admin = true;
      DEFINE FIELD updated_at ON ent_creditor TYPE datetime VALUE time::now();
      DEFINE TABLE ent_clean SCHEMALESS PERMISSIONS FOR select, create, update WHERE $auth != NONE, FOR delete WHERE $auth.is_admin = true;
      DEFINE FIELD updated_at ON ent_clean TYPE datetime VALUE time::now();
      UPDATE workspace_resource_quota:current SET plan = resource_quota_plan:max, sheet_count = 0;
      CREATE workbook:claims SET name = "债权台账", template = workbook_template:joint;
      CREATE sheet:claims SET workbook = workbook:claims, label = "债权", table_name = "ent_claim", template_sheet_key = "claims", column_defs = [
        { key: "name", label: "名称", field_type: "text", required: true },
        { key: "amount", label: "金额", field_type: "decimal" },
        { key: "case_no", label: "案号", field_type: "text" },
        { key: "creditor", label: "债权人", field_type: "reference", reference_table: "ent_creditor", reference_display_key: "name", reference_multiple: false }
      ];
      CREATE sheet:creditors SET workbook = workbook:claims, label = "债权人", table_name = "ent_creditor", template_sheet_key = "creditors", column_defs = [
        { key: "name", label: "名称", field_type: "text", required: true }
      ];
      CREATE workbook:clean SET name = "零问题台账";
      CREATE sheet:clean SET workbook = workbook:clean, label = "完整", table_name = "ent_clean", column_defs = [
        { key: "name", label: "名称", field_type: "text", required: true }
      ];
    `).collect();

    const adminToken = await signToken(env.OIDC_ISSUER, "admin-joint", { email: "admin@joint.test", ns: namespace, db: "ws_joint", ac: "admin", rl: ["Owner"] });
    const memberToken = await signToken(env.OIDC_ISSUER, "member-joint", { email: "member@joint.test", ns: namespace, db: "ws_joint", ac: "participant" });
    const reviewerToken = await signToken(env.OIDC_ISSUER, "reviewer-joint", { email: "reviewer@joint.test", ns: namespace, db: "ws_joint", ac: "participant" });
    const admin = await openCaller("ws_joint", adminToken);
    const member = await openCaller("ws_joint", memberToken);
    await openCaller("ws_joint", reviewerToken);
    await expect(member.query("DEFINE TABLE forbidden_by_participant SCHEMALESS")).rejects.toThrow();

    const mappings: TemplateImportMapping[] = [
      { sourceIndex: 0, sourceLabel: "名称", targetKey: "name", matchedBy: "field-name" },
      { sourceIndex: 1, sourceLabel: "金额", targetKey: "amount", matchedBy: "field-name" },
      { sourceIndex: 2, sourceLabel: "案号", targetKey: "case_no", matchedBy: "field-name" },
    ];
    const storedRows = Array.from({ length: 501 }, (_, index) => [
      index === 0 || index === 500 ? "甲公司" : `债权人 ${index + 1}`,
      "100.00",
      `案号-${index + 1}`,
    ]);
    const sourceRows = [...storedRows, ["", "100.00", "案号-缺"], ["坏格式", "不是金额", "案号-坏"], ["待恢复", "还不是金额", "案号-恢复"]];
    const rowNumbers = sourceRows.map((_, index) => index + 2);
    const batches = createImportBatchService(member);
    const batch = await batches.start({
      fileName: "脱敏台账.csv", fileDigest: "joint-ledger", mappingVersion: "joint-v1", mode: "existing_tables",
      workbookId: "workbook:claims",
      sheets: [
        { sheetName: "债权", targetSheetId: "sheet:claims", mappings },
        { sheetName: "债权人", targetSheetId: "sheet:creditors", mappings: [mappings[0]!] },
      ],
    });
    const runtime = await openDataTableRuntime({
      conn: member, workbookId: "workbook:claims", dataTableId: "sheet:claims",
      query: { filters: [], filterMode: "and", sorts: [], hiddenFields: [], groupBy: null },
    });
    const firstImport = await runtime.importCsvRows({ rows: sourceRows, rowNumbers, mappings, batch: { id: batch.id, sheetName: "债权" } });
    expect(firstImport.importedCount).toBe(501);
    expect(firstImport.rejected.map((row) => row.field).sort()).toEqual(["名称", "金额", "金额"]);
    const recovered = await runtime.importCsvRows({
      rows: [["待恢复", "80.00", "案号-恢复"]],
      rowNumbers: [rowNumbers.at(-1)!],
      mappings,
      batch: { id: batch.id, sheetName: "债权" },
    });
    expect(recovered).toMatchObject({ importedCount: 1, replayedCount: 0, rejected: [] });
    const replay = await runtime.importCsvRows({ rows: storedRows, rowNumbers: rowNumbers.slice(0, 501), mappings, batch: { id: batch.id, sheetName: "债权" } });
    expect(replay.replayedCount).toBe(501);
    const creditorRuntime = await openDataTableRuntime({
      conn: member, workbookId: "workbook:claims", dataTableId: "sheet:creditors",
      query: { filters: [], filterMode: "and", sorts: [], hiddenFields: [], groupBy: null },
    });
    expect(await creditorRuntime.importCsvRows({
      rows: [["乙公司"]], rowNumbers: [2], mappings: [mappings[0]!], batch: { id: batch.id, sheetName: "债权人" },
    })).toMatchObject({ importedCount: 1, rejected: [] });
    await creditorRuntime.close();
    await batches.finishSheet(batch.id, "债权", { status: "completed", importedCount: 502, rejectedCount: 2 });
    await batches.finishSheet(batch.id, "债权人", { status: "completed", importedCount: 1, rejectedCount: 0 });
    await batches.finish(batch.id, "partial_failure");
    expect((await batches.load(batch.id))?.status).toBe("partial_failure");
    expect(await member.query("SELECT * FROM ent_claim")).toHaveLength(502);
    await (await rootSession("ws_other")).query(`CREATE workbook:otheronly SET name = "另一工作区台账"`).collect();
    const crossed = await openCaller("ws_other", memberToken);
    const sawOther = await crossed.query("SELECT name FROM workbook:otheronly");
    const sawJoint = await crossed.query<{ count?: number }>("SELECT count() AS count FROM ent_claim GROUP ALL");
    expect(sawOther).toHaveLength(0);
    expect(sawJoint[0]?.count).toBe(502);
    await runtime.close();

    const named = await member.query<{ id: unknown }>("SELECT id FROM ent_claim WHERE name = '甲公司' LIMIT 1");
    expect(named[0]?.id).toBeTruthy();
    await member.updateRecord(String(named[0]!.id), { creditor: "ent_creditor:missing" });

    const checks = createDataCheckService(member);
    const checked = await checks.start({ workbookId: "workbook:claims" });
    expect(checked.scannedCount).toBeGreaterThanOrEqual(501);
    expect(checked.status).toBe("completed");
    const duplicates = checked.findings.filter((finding) => finding.category === "duplicate_candidate");
    const missingRefs = checked.findings.filter((finding) => finding.category === "reference_missing");
    expect(duplicates).toHaveLength(2);
    expect(missingRefs.length).toBeGreaterThan(0);
    const duplicate = duplicates[0]!;
    await markFindingNotApplicable(member, {
      findingId: duplicate.id, reason: "不同案号的合法重复申报，不合并", idempotencyKey: "joint-not-applicable",
    });
    expect(await member.query("SELECT count() AS count FROM ent_claim GROUP ALL")).toEqual([expect.objectContaining({ count: 502 })]);

    const cleanBatch = await batches.start({
      fileName: "零问题.csv", fileDigest: "joint-clean", mappingVersion: "joint-v1", mode: "existing_tables",
      workbookId: "workbook:clean",
      sheets: [{ sheetName: "完整", targetSheetId: "sheet:clean", mappings: [mappings[0]!] }],
    });
    const cleanRuntime = await openDataTableRuntime({
      conn: member, workbookId: "workbook:clean", dataTableId: "sheet:clean",
      query: { filters: [], filterMode: "and", sorts: [], hiddenFields: [], groupBy: null },
    });
    expect(await cleanRuntime.importCsvRows({
      rows: [["完整记录"]], rowNumbers: [2], mappings: [mappings[0]!], batch: { id: cleanBatch.id, sheetName: "完整" },
    })).toMatchObject({ importedCount: 1, rejected: [] });
    await batches.finish(cleanBatch.id, "completed");
    await cleanRuntime.close();
    expect(await checks.start({ workbookId: "workbook:clean" })).toMatchObject({ status: "completed", scannedCount: 1, findingCount: 0 });

    const repairTarget = missingRefs[0]!;
    const repairRuntime = await openDataTableRuntime({
      conn: member, workbookId: "workbook:claims", dataTableId: "sheet:claims",
      query: { filters: [], filterMode: "and", sorts: [], hiddenFields: [], groupBy: null },
    });
    const preview = await repairRuntime.planRecordFieldRepair({ recordId: repairTarget.recordId, fieldKey: "creditor", value: null });
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error("修正预览失败");
    expect(await repairRuntime.confirmRecordFieldRepair({
      token: preview.value.token, findingId: repairTarget.id, idempotencyKey: "joint-repair",
    })).toMatchObject({ ok: true, value: { alreadyConfirmed: false } });
    await repairRuntime.close();

    const assignment = await createFindingAssignment(member, {
      findingIds: [duplicates[1]!.id], assigneeId: "user:member", reviewerId: "user:admin",
      dueAt: "2026-10-01T00:00:00.000Z", completionCondition: "确认是否为不同申报", idempotencyKey: "joint-assignment",
    });
    const submitted = await submitFindingAssignment(member, {
      assignmentId: assignment.id, expectedVersion: assignment.version, note: "已核对案号，待另一律师复核",
      resourceIds: [], idempotencyKey: "joint-submit",
    });
    await expect(reviewFindingAssignment(admin, {
      assignmentId: assignment.id, expectedVersion: submitted.version - 1, decision: "approve",
      idempotencyKey: "joint-stale-review",
    })).rejects.toThrow("派单已被他人更新");
    await Bun.sleep(1100);
    const freshCheck = await checks.start({ workbookId: "workbook:claims" });
    expect(freshCheck).toMatchObject({ status: "completed", stale: false });
    const approved = await reviewFindingAssignment(admin, {
      assignmentId: assignment.id, expectedVersion: submitted.version, decision: "approve",
      reason: "不同案号，确认为例外", idempotencyKey: "joint-approve",
    });
    expect(approved.status).toBe("completed");

    const undo = createImportBatchUndoService(admin);
    const memberUndo = await createImportBatchUndoService(member).preview(cleanBatch.id);
    expect(memberUndo.blockers.some((blocker) => blocker.kind === "permission_denied")).toBe(true);
    const cleanPreview = await undo.preview(cleanBatch.id);
    expect(cleanPreview.status).toBe("ready");
    expect(await undo.undo(cleanBatch.id, cleanPreview.token)).toMatchObject({ status: "undone", deletedCount: 1 });

    const summary = await buildActivationSummaryV2(admin, new Date("2026-09-23T00:00:00.000Z"), "UTC");
    expect(summary.contractVersion).toBe("2");
    expect(summary.progress.imports.completed).toBeGreaterThan(0);
    const reader = createPlatformOperatorCapabilityReader(systemRoot);
    const app = new Hono();
    app.onError(handleError);
    const summaries = new ActivationSummaryService(new SurrealActivationSummaryStore(rootSession, namespace));
    const autonomy = new OpsAutonomyService(new SurrealOpsAutonomyStore(rootSession, namespace));
    const followUps = new OpsFollowUpService(new SurrealOpsFollowUpStore(rootSession, namespace), undefined, autonomy);
    const proposals = new OpsProposalService(new SurrealOpsProposalStore(rootSession, namespace), followUps, autonomy);
    const runs = new OpsRunService(new SurrealOpsRunStore(rootSession, namespace), autonomy);
    const operatorAuth = requirePlatformOperator(undefined, { reader });
    app.route("/", createActivationSummaryRoutes({ service: summaries, requireOperator: () => operatorAuth }));
    app.route("/", createContentMcpRoutes({
      service: new PlatformContentService({ store: new InMemoryPlatformContentStore(), sources: [] }),
      activationSummaryService: summaries, opsFollowUpService: followUps, opsProposalService: proposals,
      opsAutonomyService: autonomy, opsRunService: runs, authorizationServer: env.OIDC_ISSUER,
      requireOperator: operatorAuth,
    }));
    const parsedSummary = shareActivationSummarySchema.safeParse({ summary, idempotencyKey: "joint-share-001" });
    if (!parsedSummary.success) throw new Error(JSON.stringify(parsedSummary.error.issues.slice(0, 8)));
    const adminApiToken = await signToken(env.OIDC_ISSUER, "admin-joint", { email: "admin@joint.test" }, env.OIDC_AUDIENCE);
    const shared = await app.request("/api/workspaces/team-joint/activation-summary", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${adminApiToken}` },
      body: JSON.stringify({ summary, idempotencyKey: "joint-share-001" }),
    });
    expect(shared.status).toBe(200);
    const sharedBody = await shared.json() as { workspaceSlug: string; status: string; updatedAt: string };
    const opsToken = await signToken(env.OIDC_ISSUER, "ops-human", { scope: "activation.summary.read content.read" }, env.OIDC_AUDIENCE);
    const listed = await app.request("/api/ops/activation-summaries", { headers: { authorization: `Bearer ${opsToken}` } });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as { items: Array<{ workspaceSlug: string; status: string; updatedAt: string }> };
    expect(listedBody.items[0]).toMatchObject({ workspaceSlug: sharedBody.workspaceSlug, status: "active", updatedAt: sharedBody.updatedAt });

    async function callTool<T>(token: string, tool: string, args: Record<string, unknown>): Promise<T> {
      const response = await app.request("/api/ops/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
      });
      const body = await response.json() as { result?: { structuredContent?: T & { error?: { code: string } } } };
      const result = body.result?.structuredContent;
      if (!response.ok || !result || result.error) throw Object.assign(new Error("MCP tool failed"), { code: result?.error?.code ?? "mcp_error", status: response.status });
      return result;
    }
    const contract = await callTool<{ contractVersion: string }>(opsToken, "get_data_contract", {});
    expect(contract.contractVersion).toBe("1");
    const mcpSummaries = await callTool<{ items: Array<{ workspaceSlug: string; status: string; updatedAt: string }> }>(opsToken, "list_activation_summaries", {});
    expect(mcpSummaries.items[0]).toMatchObject({ workspaceSlug: sharedBody.workspaceSlug, status: "active", updatedAt: sharedBody.updatedAt });
    const agentToken = await signToken(env.OIDC_ISSUER, "ops-agent", {
      scope: "activation.followup.read activation.followup.write activation.proposal.read activation.proposal.submit",
    }, env.OIDC_AUDIENCE);
    const narrowed = await signToken(env.OIDC_ISSUER, "ops-agent", { scope: "activation.followup.read" }, env.OIDC_AUDIENCE);
    await expect(callTool(narrowed, "create_follow_up", { opportunityId: "x", dueCheckAt: null, idempotencyKey: "joint-narrow" })).rejects.toMatchObject({ code: "capability_missing" });
    let sequence = 0;
    const portAdapter = { async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
      const response = await app.request("/api/ops/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name: tool, arguments: args } }),
      });
      const body = await response.json() as { result?: { structuredContent?: T & { error?: { code: string; message: string } } } };
      const result = body.result?.structuredContent;
      if (!response.ok || !result || result.error) throw Object.assign(new Error(result?.error?.message ?? "MCP tool failed"), { code: result?.error?.code ?? "mcp_error" });
      return result;
    } };
    const humanActor = { subject: "ops-human", kind: "human" as const, capabilities: [
      "activation.autonomy.read", "activation.autonomy.manage", "activation.followup.read", "activation.followup.write",
      "activation.proposal.read", "activation.proposal.submit", "activation.summary.read",
    ] };
    const policy = await autonomy.configure(humanActor, {
      agentSubject: "ops-agent", workspaceSlug: "team-joint", expectedVersion: null,
      actions: ["opportunity.read", "follow_up.read", "follow_up.create", "follow_up.claim", "proposal.read", "proposal.submit"],
      idempotencyKey: "joint-policy-001",
    });
    const runner = new ExternalOpsAgentRunner(portAdapter, () => new Date("2026-09-23T00:00:00.000Z"));
    const resumed = await runner.run({ runKey: "joint-run-001", workspaceSlug: "team-joint" });
    expect(resumed.status).toBe("waiting");
    expect(resumed.actionsCompleted).toBe(3);
    expect((await runner.run({ runKey: "joint-run-001", workspaceSlug: "team-joint" })).actionsCompleted).toBe(3);
    const followPage = await followUps.listFollowUps({ subject: "ops-agent", kind: "agent", capabilities: ["activation.followup.read", "activation.followup.write"] }, {});
    expect(followPage.items).toHaveLength(1);
    const humanToken = await signToken(env.OIDC_ISSUER, "ops-human", {
      scope: "activation.proposal.takeover activation.proposal.read activation.followup.read activation.followup.write",
    }, env.OIDC_AUDIENCE);
    const taken = await callTool<{ version: number }>(humanToken, "takeover_follow_up", {
      followUpId: followPage.items[0]!.followUpId, expectedVersion: followPage.items[0]!.version,
      leaseSeconds: 900, reason: "人工接管联合验收事项", idempotencyKey: "joint-takeover",
    });
    expect(taken.version).toBeGreaterThan(followPage.items[0]!.version);
    await autonomy.changeStatus(humanActor, {
      policyId: policy.policyId, expectedVersion: policy.version, status: "paused", reason: "联合验收暂停后续动作", idempotencyKey: "joint-pause-001",
    });
    await expect(runner.run({ runKey: "joint-run-002", workspaceSlug: "team-joint" })).rejects.toMatchObject({ code: "paused" });
    await systemRoot.query(`UPDATE platform_operator:agent SET status = "disabled", disabled_at = time::now()`).collect();
    await expect(runner.run({ runKey: "joint-run-003", workspaceSlug: "team-joint" })).rejects.toThrow();
    const withdrawn = await app.request("/api/workspaces/team-joint/activation-summary", {
      method: "DELETE", headers: { "content-type": "application/json", authorization: `Bearer ${adminApiToken}` },
      body: JSON.stringify({ idempotencyKey: "joint-withdraw-001" }),
    });
    expect(withdrawn.status).toBe(200);
    const afterWithdraw = await app.request("/api/ops/activation-summaries", { headers: { authorization: `Bearer ${opsToken}` } });
    expect(afterWithdraw.status).toBe(200);
    const afterBody = await afterWithdraw.json() as { items: Array<{ workspaceSlug: string }> };
    expect(afterBody.items.some((item) => item.workspaceSlug === "team-joint")).toBe(false);
  }, 180_000);
});
