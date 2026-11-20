import { afterEach, expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { loadTemplatePackScripts } from "@surreal-ck/shared/template-packs";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Surreal } from "surrealdb";
import { ClaimsPortalService } from "./service";
import { SESSION_COOKIE_NAME } from "./constants";
import { createClaimsPortalRoutes } from "../routes/claims-portal";
import { handleError } from "../middleware/error";

const binary = process.env.SURREAL_BINARY;
const forkTest = test.skipIf(!binary);
const openClients: Surreal[] = [];
const cleanup: Array<() => void> = [];

afterEach(async () => {
  await Promise.allSettled(openClients.splice(0).map((client) => client.close()));
  for (const stop of cleanup.splice(0)) stop();
});

async function fixture(maxVersion = Number.POSITIVE_INFINITY) {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const key = await exportJWK(publicKey);
  const jwks = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ keys: [{ ...key, kid: "fixture", use: "sig", alg: "ES256" }] }),
  });
  cleanup.push(() => jwks.stop(true));
  const issuer = `http://127.0.0.1:${jwks.port}`;
  const reserve = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = reserve.port;
  reserve.stop(true);
  const password = crypto.randomUUID();
  const processHandle = Bun.spawn(
    [binary!, "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "fixture", "--pass", password, "memory"],
    { stdout: "ignore", stderr: "ignore" },
  );
  cleanup.push(() => processHandle.kill());
  const base = `127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    ready = await fetch(`http://${base}/health`).then((res) => res.ok, () => false);
    if (ready || processHandle.exitCode !== null) break;
    await Bun.sleep(50);
  }
  if (!ready) throw new Error("SurrealDB fork did not start");

  const namespace = "main";
  const database = "ws_claims_progress";
  const url = `ws://${base}/rpc`;
  const root = new Surreal();
  openClients.push(root);
  await root.connect(url, { authentication: { username: "fixture", password }, namespace, database });
  const scripts = await loadTemplateScripts({ oidcJwksUrl: `${issuer}/jwks` });
  for (const script of scripts.filter((entry) => entry.version <= maxVersion)) {
    await root.query(script.sql).collect();
  }
  async function login(access: "admin" | "participant") {
    const token = await new SignJWT({
      ns: namespace,
      db: database,
      ac: access,
      RL: access === "admin" ? ["Owner"] : ["Editor"],
      email: `${access}@example.test`,
    })
      .setSubject(access)
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime("120s")
      .setProtectedHeader({ alg: "ES256", kid: "fixture" })
      .sign(privateKey);
    const client = new Surreal();
    openClients.push(client);
    await client.connect(url);
    await client.authenticate(token);
    return client;
  }
  const service = new ClaimsPortalService({
    getSession: async () => ({ query: (sql, params) => root.query(sql, params).collect() }),
    resolveWorkspace: async () => ({ dbName: database }),
    getPepper: () => "test-claims-portal-pepper-32bytes-min!!",
  });
  return { root, database, login, service, scripts };
}

forkTest("升级已有工作区：保留申报与补正历史，并处理 v1 重复有效链接", async () => {
  const { root, database, service, scripts } = await fixture(63);
  await root.query(`
    CREATE creditor_roster:legacy SET name = "旧名册", identity_code = "LEGACY", subject_type = "enterprise";
    CREATE claim_submission:legacy SET roster_id = creditor_roster:legacy, identity_code = "LEGACY",
      status = "needs_info", submitted_at = d"2025-03-01T00:00:00Z";
    CREATE claim_supplement:legacy SET submission_id = claim_submission:legacy, direction = "manager_request",
      body = "历史补正", actor = "历史管理人", created_at = d"2025-03-02T00:00:00Z";
    CREATE claim_access_token:older SET roster_id = creditor_roster:legacy, token_hash = "older-fixture",
      status = "active", created_at = d"2025-03-01T00:00:00Z";
    CREATE claim_access_token:newer SET roster_id = creditor_roster:legacy, token_hash = "newer-fixture",
      status = "active", created_at = d"2025-03-02T00:00:00Z";
  `).collect();
  for (const script of scripts.filter((entry) => entry.version > 63)) {
    await root.query(script.sql).collect();
  }
  const result = await service.getSubmission({ workspaceDb: database, rosterId: "creditor_roster:legacy" });
  expect(result.progress).toEqual({
    stage: "needs_info",
    events: [{ stage: "submitted", actor: "本人", createdAt: "2025-03-01T00:00:00.000Z" }],
  });
  expect(result.supplements).toMatchObject([{ body: "历史补正", actor: "管理人", dueAt: null }]);
  const tokens = await service.listTokens({ workspaceDb: database });
  expect(tokens.filter((entry) => entry.status === "active").map((entry) => entry.id))
    .toEqual(["claim_access_token:newer"]);
}, 30000);

forkTest("安装债权模板包后可编辑补正话术，重新播种保留自定义内容", async () => {
  const { root, login } = await fixture();
  const [pack] = await loadTemplatePackScripts({ selectedPacks: ["bankruptcy-claims"] });
  await root.query(pack!.sql).collect();
  const admin = await login("admin");
  await admin.query(`UPDATE claim_supplement_template SET body = "本案定制问法" WHERE key = "contract";`).collect();
  await root.query(pack!.sql).collect();
  const [rows] = await admin.query<[{ body: string }[]]>(
    `SELECT body FROM claim_supplement_template WHERE key = "contract";`,
  ).collect();
  expect(rows).toEqual([{ body: "本案定制问法" }]);
}, 30000);

forkTest("门户进度和补正：真实 fork 的角色权限、追加记录、附件归属与幂等提交", async () => {
  const { root, database, login, service } = await fixture();
  await root.query(`
    CREATE creditor_roster:own SET name = "测试债权人", identity_code = "OWN", subject_type = "enterprise";
    CREATE creditor_roster:other SET name = "另一债权人", identity_code = "OTHER", subject_type = "enterprise";
    CREATE claim_submission:own SET roster_id = creditor_roster:own, identity_code = "OWN", principal = 500, status = "draft";
    CREATE claim_submission:other SET roster_id = creditor_roster:other, identity_code = "OTHER", status = "submitted";
    CREATE claim_attachment:own SET submission_id = claim_submission:own, attachment_type = "contract",
      file_name = "own.pdf", content_type = "application/pdf", byte_size = 20,
      storage_key = "sample/internal/own.pdf", uploaded_at = time::now();
    CREATE claim_attachment:other SET submission_id = claim_submission:other, attachment_type = "contract",
      file_name = "other.pdf", content_type = "application/pdf", byte_size = 20,
      storage_key = "sample/internal/other.pdf", uploaded_at = time::now();
  `).collect();
  const input = { workspaceDb: database, rosterId: "creditor_roster:own" };
  await service.submit(input);
  await service.submit(input);
  await expect(service.saveDraft({ ...input, draft: { principal: 10 } }))
    .rejects.toMatchObject({ status: 409 });

  const admin = await login("admin");
  const participant = await login("participant");
  await admin.query(`
    CREATE claim_supplement:own SET submission_id = claim_submission:own, direction = "manager_request",
      body = "请补材料", actor = "内部管理人", created_at = time::now(), due_at = d"2027-01-10T12:00:00Z";
    CREATE claim_supplement:other SET submission_id = claim_submission:other, direction = "manager_request",
      body = "其他人材料", actor = "内部管理人", created_at = time::now();
  `).collect();
  const [visible] = await participant.query<[{ stage: string }[]]>(
    "SELECT stage, created_at FROM claim_progress_event WHERE submission_id = claim_submission:own ORDER BY created_at;",
  ).collect();
  expect(visible.map((row) => row.stage)).toEqual(["submitted", "accepted", "needs_info"]);
  const [denied] = await participant.query(`
    CREATE claim_progress_event SET submission_id = claim_submission:own, stage = "final", actor = "participant";
  `).collect().catch(() => [[]]);
  expect(denied).toEqual([]);
  const [deniedSupplement] = await participant.query(`
    CREATE claim_supplement SET submission_id = claim_submission:own, direction = "manager_request",
      body = "不应写入", actor = "participant", created_at = time::now();
  `).collect().catch(() => [[]]);
  expect(deniedSupplement).toEqual([]);

  const reply = { ...input, requestId: "claim_supplement:own", body: "材料随附" };
  await expect(service.addCreditorSupplementReply({ ...reply, attachmentIds: ["claim_attachment:other"] }))
    .rejects.toMatchObject({ status: 400 });
  await expect(service.addCreditorSupplementReply({ ...reply, requestId: "claim_supplement:other" }))
    .rejects.toMatchObject({ status: 400 });
  await service.addCreditorSupplementReply({ ...reply, attachmentIds: ["claim_attachment:own"] });
  const result = await service.getSubmission(input);
  expect(result.progress.stage).toBe("needs_info");
  expect(result.progress.events.map((event) => event.actor)).toEqual(["本人", "管理人", "管理人"]);
  expect(result.supplements).toHaveLength(2);
  expect(result.supplements[0]).toMatchObject({ dueAt: "2027-01-10T12:00:00.000Z", actor: "管理人" });
  expect(result.supplements[1]).toMatchObject({
    requestId: "claim_supplement:own",
    attachmentIds: ["claim_attachment:own"],
  });
  expect(JSON.stringify(result)).not.toContain("内部管理人");
}, 30000);

forkTest("留存 PDF 只允许本人用仍有效的令牌会话下载", async () => {
  const { root, database, service } = await fixture();
  await root.query(`
    CREATE creditor_roster:own SET name = "张三", identity_code = "OWN", subject_type = "enterprise";
    CREATE creditor_roster:other SET name = "李四", identity_code = "OTHER", subject_type = "enterprise";
    CREATE claim_submission:own SET roster_id = creditor_roster:own, identity_code = "OWN",
      status = "submitted", principal = 100, statement = "本人申报材料", manager_note = "内部笔记";
    CREATE claim_submission:other SET roster_id = creditor_roster:other, identity_code = "OTHER",
      status = "submitted", statement = "他人申报材料";
  `).collect();
  const mint = (rosterId: string) => service.mintToken({ workspaceDb: database, slug: "case-a", createdBy: "admin", rosterId });
  const own = await mint("creditor_roster:own");
  const other = await mint("creditor_roster:other");
  const opened = await service.openSession({
    workspaceDb: database, slug: "case-a", tokenPlaintext: own.tokenPlaintext, name: "张三", identityCode: "OWN",
  });
  const app = createClaimsPortalRoutes({ service }).onError(handleError);
  const path = (token: string) => `/api/claims-portal/case-a/${token}/submission.pdf`;
  const request = { headers: { Cookie: `${SESSION_COOKIE_NAME}=${opened.cookieValue}` } };
  expect((await app.request(path(own.tokenPlaintext))).status).toBe(401);
  expect((await app.request(path(other.tokenPlaintext), request)).status).toBe(401);
  const pdf = await app.request(path(own.tokenPlaintext), request);
  expect(pdf.status).toBe(200);
  expect(pdf.headers.get("content-type")).toBe("application/pdf");
  expect(pdf.headers.get("cache-control")).toContain("no-store");
  expect(new TextDecoder().decode((await pdf.bytes()).subarray(0, 5))).toBe("%PDF-");
  await service.revokeToken({ workspaceDb: database, tokenId: own.tokenId, actor: "admin" });
  expect((await app.request(path(own.tokenPlaintext), request)).status).toBe(401);
}, 30000);

forkTest("批量 CSV、换发、独立作废和真实配额回滚", async () => {
  const { root, database, service } = await fixture();
  const primary = "creditor_roster:own";
  const other = "creditor_roster:other";
  await root.query(`
    CREATE creditor_roster:own SET name = "=样本", identity_code = "OWN", subject_type = "enterprise";
    CREATE creditor_roster:other SET name = "其他", identity_code = "OTHER", subject_type = "enterprise";
  `).collect();
  const app = createClaimsPortalRoutes({
    service,
    requireUser: () => async (c, next) => {
      c.set("user", { subject: "fixture-admin", email: "admin@example.test", raw: { db: database, ac: "admin" }, rawToken: "fixture" });
      await next();
    },
  }).onError(handleError);
  const base = "https://fixture.test/api/workspaces/case-a/claims-portal/tokens";
  const batch = (rosterIds: string[]) => app.request(`${base}:batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rosterIds }),
  });
  expect((await batch([primary, primary])).status).toBe(400);
  expect((await batch([primary, "creditor_roster:missing"])).status).toBe(404);
  expect(await service.listTokens({ workspaceDb: database })).toHaveLength(0);

  const response = await batch([primary, other]);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("content-type")).toContain("text/csv");
  const csv = await response.text();
  expect(csv).toContain("'=样本,OWN,https://fixture.test/claims/case-a/");
  const firstPlain = /'=样本,OWN,https:\/\/fixture\.test\/claims\/case-a\/([\w-]+)/.exec(csv)?.[1];
  expect(firstPlain).toBeDefined();
  const open = await service.openSession({
    workspaceDb: database, slug: "case-a", tokenPlaintext: firstPlain!, name: "=样本", identityCode: "OWN",
  });
  expect(JSON.stringify(await root.query("SELECT * FROM claim_access_token;").collect())).not.toContain(firstPlain!);
  const assertSession = () => service.assertTokenMatchesSession({
    workspaceDb: database, tokenPlaintext: firstPlain!, tokenId: open.tokenId, rosterId: open.rosterId,
  });
  await assertSession();

  await root.query(`DEFINE QUOTA ON DATABASE ${database}
    RULE audit_cap FOR RECORD MATCH EXACT claim_portal_audit LIMIT 3;`).collect();
  const rolledBack = await batch([primary, other]);
  expect(rolledBack.status).toBe(409);
  await assertSession();
  expect(await service.listTokens({ workspaceDb: database })).toHaveLength(2);

  await root.query(`DEFINE QUOTA OVERWRITE ON DATABASE ${database} EXPECT GENERATION 1
    RULE token_cap FOR RECORD MATCH EXACT claim_access_token LIMIT 3;`).collect();
  expect((await batch([primary, other])).status).toBe(409);
  await assertSession();
  expect(await service.listTokens({ workspaceDb: database })).toHaveLength(2);
  expect((await batch([primary])).status).toBe(200);
  await expect(assertSession()).rejects.toMatchObject({ status: 401 });

  const current = (await service.listTokens({ workspaceDb: database }))
    .find((row) => row.status === "active" && row.rosterId === primary)!;
  const revoked = await app.request(`${base}/${encodeURIComponent(current.id)}`, { method: "DELETE" });
  expect(revoked.status).toBe(200);
  const rows = await service.listTokens({ workspaceDb: database });
  expect(rows.filter((row) => row.rosterId === primary).map((row) => row.status)).toEqual(["revoked", "revoked"]);
  const [audit] = await root.query<[{ action: string }[]]>("SELECT action FROM claim_portal_audit;").collect();
  expect(audit.filter((entry) => entry.action === "token_issued")).toHaveLength(3);
  expect(audit.filter((entry) => entry.action === "token_revoked")).toHaveLength(2);
  await root.query(`DEFINE QUOTA OVERWRITE ON DATABASE ${database} EXPECT GENERATION 2
    RULE token_cap FOR RECORD MATCH EXACT claim_access_token LIMIT 4;`).collect();
  const numericPrefixed = "claim_access_token:⟨1fixture⟩";
  await root.query(`CREATE claim_access_token:⟨1fixture⟩
    SET roster_id = creditor_roster:own, token_hash = "numeric-fixture", status = "active";`).collect();
  expect((await app.request(`${base}/${encodeURIComponent(numericPrefixed)}`, { method: "DELETE" })).status).toBe(200);
  expect((await service.listTokens({ workspaceDb: database })).find((row) => row.id === numericPrefixed)?.status).toBe("revoked");
}, 30000);

forkTest("发布结论追加版本与审计，门户只返回本人的公开字段", async () => {
  const { root, database, login, service } = await fixture();
  await root.query(`
    CREATE creditor_roster:own SET name = "债权人", identity_code = "OWN", subject_type = "enterprise";
    CREATE creditor_roster:other SET name = "其他债权人", identity_code = "OTHER", subject_type = "enterprise";
    CREATE claim_submission:own SET roster_id = creditor_roster:own, identity_code = "OWN", status = "submitted",
      portal_stage = "under_review", manager_note = "仅供内部查阅";
    CREATE claim_submission:other SET roster_id = creditor_roster:other, identity_code = "OTHER", status = "submitted",
      portal_stage = "under_review";
  `).collect();
  const admin = await login("admin");
  const participant = await login("participant");
  const publish = (db: Surreal, target: "own" | "other", version: number, reason: string) => db.query(`
    CREATE claim_decision SET submission_id = type::record("claim_submission", $target),
      version = $version, confirmed_principal = 400, confirmed_interest = 10, confirmed_penalty = 0,
      unconfirmed_amount = 100, reason = $reason, published_by = "内部管理人";
  `, { target, version, reason }).collect();
  const [denied] = await publish(participant, "own", 1, "不应发布").catch(() => [[]]);
  expect(denied).toEqual([]);
  await publish(admin, "own", 1, "核对合同");
  const race = await Promise.allSettled([
    publish(admin, "own", 2, "材料已核验"),
    publish(admin, "own", 2, "材料已核验"),
  ]);
  expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  await publish(admin, "other", 1, "其他债权人结论");
  await expect(admin.query("UPDATE claim_decision SET reason = '不应覆盖';").collect()).rejects.toThrow();
  await expect(admin.query("DELETE claim_decision;").collect()).rejects.toThrow();

  const [audit] = await root.query<[{ action: string }[]]>(
    "SELECT action FROM claim_portal_audit WHERE action = 'decision_published';",
  ).collect();
  expect(audit).toHaveLength(3);
  const result = await service.getSubmission({ workspaceDb: database, rosterId: "creditor_roster:own" });
  expect(result.progress.stage).toBe("decision_published");
  expect(result.progress.events.map((event) => event.stage)).toEqual(["decision_published", "decision_published"]);
  expect(result.decisions.map(({ version, reason }) => ({ version, reason })))
    .toEqual([{ version: 2, reason: "材料已核验" }, { version: 1, reason: "核对合同" }]);
  expect(JSON.stringify(result)).not.toMatch(/仅供内部查阅|内部管理人|其他债权人结论/);
}, 30000);
