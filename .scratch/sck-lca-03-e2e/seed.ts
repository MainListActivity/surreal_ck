/**
 * SCK-LCA-03 隔离联调种子。真实 API 建工作区在 vanilla SurrealDB 上不可行
 * （provisioning saga 需要 native-quota 的 INFO FOR QUOTA），因此工作区/成员/权益
 * 用 root 种子按 creator 同名字段写入，工作区库应用真实 workspace-template；
 * bob 的成员新增仍走真实 POST /api/workspaces/:slug/members。
 * 前置：boot-e2e.ts 已在运行。用法：bun .scratch/sck-lca-03-e2e/seed.ts
 */

import { Surreal, StringRecordId, DateTime, RecordId } from "surrealdb";
import { loadTemplateScripts } from "../../shared/sql/workspace-template/index";

const cfg = Object.fromEntries(
  (await Bun.file("/tmp/sck-lca-03-e2e.env").text()).split("\n").filter(Boolean).map((l) => l.split("=", 2) as [string, string]),
);
const SERVER = cfg.SERVER ?? "http://127.0.0.1:18080";
const ISSUER = cfg.ISSUER ?? "http://127.0.0.1:19001";
const JWKS = `${ISSUER}/jwks.json`;

async function mint(subject: string, claims: Record<string, unknown> = {}, expiresIn = 3600): Promise<string> {
  const res = await fetch(`${ISSUER}/dev/mint`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa("fixture-web:fixture-secret")}`, "content-type": "application/json" },
    body: JSON.stringify({ subject, claims, expiresIn }),
  });
  if (!res.ok) throw new Error(`mint failed ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function api(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const root = new Surreal();
await root.connect(cfg.SURREAL_URL);
await root.signin({ username: cfg.ROOT_USER, password: cfg.ROOT_PASS });
await root.use({ namespace: cfg.NS, database: "_system" });

console.log("== 清理上轮失败的工作区行（API 建区被 native-quota 挡住）");
await root.query(`DELETE FROM user_workspace_index WHERE workspace.slug IN ['alpha','beta'];
DELETE FROM workspace WHERE slug IN ['alpha','beta'];`);

const templates = await loadTemplateScripts({ oidcJwksUrl: JWKS });

async function seedWorkspace(input: {
  slug: string;
  dbName: string;
  members: { subject: string; email: string; admin: boolean; disabled?: boolean }[];
}) {
  const db = new Surreal();
  await db.connect(cfg.SURREAL_URL);
  await db.signin({ username: cfg.ROOT_USER, password: cfg.ROOT_PASS });
  await db.use({ namespace: cfg.NS });
  await db.query(`REMOVE DATABASE IF EXISTS ${input.dbName};`);
  await db.query(`DEFINE DATABASE ${input.dbName};`);
  await db.use({ namespace: cfg.NS, database: input.dbName });
  for (const script of templates) await db.query(script.sql);
  const wsId = `workspace:${input.slug}`;
  // 控制面行写在 _system；成员 user 行写在 workspace db。
  const wsIdRef = `workspace:${input.slug}`;
  const entRef = `resource_entitlement:${input.slug}_ent`;
  const projRef = `quota_policy_projection:${input.slug}_proj`;
  // resource_entitlement / quota_policy_projection 有 immutable 事件，存在即复用。
  await root.query(
    `LET $hasEnt = (SELECT id FROM ${entRef} LIMIT 1)[0];
     IF $hasEnt = NONE THEN CREATE ${entRef} CONTENT {
      workspace: ${wsIdRef}, revision: 1, source_type: 'trial', plan_revision: quota_plan_revision:trial_v1,
      service_mode: 'standard', rules: [], source_digest: 'e2e', effective_at: time::now(),
      correlation_id: 'e2e-seed' };
     END;
     LET $hasProj = (SELECT id FROM ${projRef} LIMIT 1)[0];
     IF $hasProj = NONE THEN CREATE ${projRef} CONTENT {
      workspace: ${wsIdRef}, entitlement: ${entRef}, revision: 1, compiler_version: 'e2e',
      native_capability: 'e2e', native_contract_major: 1, info_format_version: 1,
      rules: [], rule_labels: [], canonical_digest: 'e2e', created_at: time::now(), correlation_id: 'e2e-seed' };
     END;
     UPDATE workspace_quota_runtime SET workspace = ${wsIdRef}, sync_state = 'in_sync',
      service_mode = 'standard', quota_compliance = 'compliant', capacity_state = 'normal',
      auto_reconcile = false, last_native_audit_at = time::now(), ledger_state = 'ready', usage_trusted = true
      WHERE workspace = ${wsIdRef};
     LET $hasRuntime = (SELECT id FROM workspace_quota_runtime WHERE workspace = ${wsIdRef} LIMIT 1)[0];
     IF $hasRuntime = NONE THEN CREATE workspace_quota_runtime CONTENT {
      workspace: ${wsIdRef}, sync_state: 'in_sync', service_mode: 'standard',
      quota_compliance: 'compliant', capacity_state: 'normal', auto_reconcile: false,
      last_native_audit_at: time::now(), ledger_state: 'ready', usage_trusted: true };
     END;
     CREATE ${wsIdRef} CONTENT {
      db_name: '${input.dbName}', owner_subject: 'alice', slug: '${input.slug}',
      name: '联调工作区 ${input.slug}', status: 'active',
      desired_entitlement: ${entRef}, applied_entitlement: ${entRef},
      desired_quota_projection: ${projRef}, applied_quota_projection: ${projRef},
      quota_migration_state: 'native_applied',
      created_at: time::now(), updated_at: time::now() };`,
  ).catch(async (error) => {
    // workspace 行幂等：已存在则更新为 active。
    if (String(error).includes("already exists")) {
      await root.query(`UPDATE ${wsIdRef} SET status='active', db_name='${input.dbName}',
        desired_entitlement=${entRef}, applied_entitlement=${entRef},
        desired_quota_projection=${projRef}, applied_quota_projection=${projRef},
        quota_migration_state='native_applied', updated_at=time::now();`);
      return;
    }
    throw error;
  });
  for (const m of input.members) {
    await db.query(
      `CREATE user CONTENT { subject: $subject, email: $email, display_name: $name,
        kind: 'human', is_admin: $admin, disabled_at: $disabled };`,
      { subject: m.subject, email: m.email, name: m.subject, admin: m.admin, disabled: m.disabled ? new DateTime() : undefined },
    );
    await root.query(
      `INSERT INTO user_workspace_index { subject: $subject, email: $email, workspace: $ws,
        db_name: $dbName, role: $role, disabled_at: $disabled, joined_at: time::now() };`,
      {
        subject: m.subject, email: m.email, ws: new StringRecordId(wsId), dbName: input.dbName,
        role: m.admin ? "admin" : "participant", disabled: m.disabled ? new DateTime() : undefined,
      },
    );
  }
  await db.close();
}

console.log("== root 种子：alpha（alice admin + bob member + carol 已移除）与 beta（eve member）");
await seedWorkspace({
  slug: "alpha",
  dbName: "ws_alpha",
  members: [
    { subject: "alice", email: "alice@fixture.test", admin: true },
    { subject: "carol", email: "carol@fixture.test", admin: false, disabled: true },
  ],
});
await seedWorkspace({
  slug: "beta",
  dbName: "ws_beta",
  members: [
    { subject: "alice", email: "alice@fixture.test", admin: true },
    { subject: "eve", email: "eve@fixture.test", admin: false },
  ],
});

console.log("== 真实 API：alice 在 alpha 加 bob（admin 校验走 ws db user 表）");
const aliceAlpha = await mint("alice", { db: "ws_alpha", ac: "admin", RL: ["Owner"] });
const added = await api("/api/workspaces/alpha/members", aliceAlpha, {
  method: "POST",
  body: JSON.stringify({ email: "bob@fixture.test", displayName: "bob", isAdmin: false }),
});
console.log("  add bob:", added.status, JSON.stringify(added.body).slice(0, 160));
// bob 首次 switch 前 ws-db user.subject=NONE；按真实流程补 switch 绑定或直接 seed subject。
await root.query(
  `UPDATE user_workspace_index SET subject = 'bob' WHERE db_name = 'ws_alpha' AND email = 'bob@fixture.test';`,
);
const alphaDb = new Surreal();
await alphaDb.connect(cfg.SURREAL_URL);
await alphaDb.signin({ username: cfg.ROOT_USER, password: cfg.ROOT_PASS });
await alphaDb.use({ namespace: cfg.NS, database: "ws_alpha" });
await alphaDb.query(`UPDATE user SET subject = 'bob' WHERE email = 'bob@fixture.test';`);

console.log("== root 种子：平台内容库");
const content = new Surreal();
await content.connect(cfg.SURREAL_URL);
await content.signin({ username: cfg.ROOT_USER, password: cfg.ROOT_PASS });
await content.use({ namespace: cfg.NS, database: "platform_content" });
const haveContent = ((await content.query("SELECT id FROM content_version:demo1;"))[0] as unknown[]).length > 0;
if (!haveContent) await content.query(`
  CREATE content_source:demo SET
    source_key = 'demo.synthetic', label = '联调合成来源', jurisdiction = 'CN',
    base_url = 'https://synthetic.invalid', status = 'active',
    allowed_actions = ['publish'], created_at = time::now(), updated_at = time::now();
  CREATE source_license_revision:demo SET
    source = content_source:demo, revision = 1, license_kind = 'synthetic-permit',
    allowed_actions = ['browse','search','read','cite','export','research','generate'],
    effective_from = time::now() - 1d, effective_until = NONE,
    evidence_url = 'https://synthetic.invalid/license', evidence_text = NONE,
    created_by_subject = 'e2e-seed', created_at = time::now();
  CREATE content_item:demo1 SET
    public_id = 'law-demo-1', kind = 'legislation',
    current_version = NONE, publication_status = 'published', publication_revision = 1,
    created_at = time::now(), updated_at = time::now();
  CREATE content_version:demo1 SET
    public_id = 'law-demo-1', item = content_item:demo1, revision = 3,
    version_label = '2026 联调修订', source = content_source:demo,
    source_url = 'https://synthetic.invalid/law-demo-1', source_record_key = 'rec-1',
    fetched_at = time::now(), published_at = time::now(), updated_at_source = NONE,
    published_on = '2026-09-20', updated_on = NONE, source_date_text = NONE,
    title = '联调合成法条（示例）',
    body_text = '第一条　本法适用于联调验证范围内的合成事项。\n第二条　本正文由隔离环境种子生成，用于验证获授权成员读取。',
    body_sha256 = 'synthetic-sha256', source_form = 'full_text',
    evidence = [], field_issues = [], processing = {}, content_kind_payload = {},
    received_at = time::now(), created_by_subject = 'e2e-seed', created_at = time::now();
  UPDATE content_item:demo1 SET current_version = content_version:demo1, publication_status = 'published', publication_revision = 1, updated_at = time::now();
  CREATE content_collection_binding:demo1 SET item = content_item:demo1, collections = ['core'];
  CREATE legal_article_version:demo1 SET
    regulation_version = content_version:demo1, local_key = 'art-2', label = '第二条',
    hierarchy_path = ['联调合成法条'], body_text = '第二条　本正文由隔离环境种子生成。',
    locator = {}, source_locator = { key: 'synthetic:art-2' }, effective_on = '2026-09-20', created_at = time::now();
  CREATE content_citation:demo1 SET
    document_version = content_version:demo1, local_citation_key = 'c1',
    relation_kind = 'explicit_citation', speaker = 'other',
    quoted_text = '第二条　本正文由隔离环境种子生成。', locator = {},
    raw_law_name = '联调合成法条', raw_article_label = '第二条', resolution = 'verified',
    candidates = [], treatment_evidence = 'synthetic:hidden', created_at = time::now();
  CREATE content_item:gone SET
    public_id = 'law-withdrawn', kind = 'legislation',
    current_version = NONE, publication_status = 'withdrawn', publication_revision = 2,
    created_at = time::now(), updated_at = time::now();
  CREATE content_version:gone SET
    public_id = 'law-withdrawn', item = content_item:gone, revision = 1,
    version_label = '已撤回示例', source = content_source:demo,
    source_url = 'https://synthetic.invalid/law-withdrawn', source_record_key = 'rec-2',
    fetched_at = time::now(), published_at = time::now(), updated_at_source = NONE,
    published_on = '2026-09-01', updated_on = NONE, source_date_text = NONE,
    title = '已撤回合成法条', body_text = '已撤回正文，不应可读。',
    body_sha256 = 'withdrawn-sha256', source_form = 'full_text',
    evidence = [], field_issues = [], processing = {}, content_kind_payload = {},
    received_at = time::now(), created_by_subject = 'e2e-seed', created_at = time::now();
  CREATE content_collection_binding:gone SET item = content_item:gone, collections = ['core'];
`);

console.log("== root 种子：权益快照（alpha 有效 / beta 过期）");
async function seedEntitlement(wsSlug: string, actions: string[], aiActions: string[], untilSecondsOffset: number | null) {
  const until = untilSecondsOffset === null ? undefined : new DateTime(new Date(Date.now() + untilSecondsOffset * 1000));
  const existing = await root.query(
    `SELECT id FROM workspace_product_entitlement WHERE workspace = $ws AND digest = 'sha256:e2e-demo' LIMIT 1;`,
    { ws: new RecordId("workspace", wsSlug) },
  );
  const existingId = (existing[0] as Record<string, unknown>[] | undefined)?.[0]?.id;
  if (existingId) {
    await root.query(`UPDATE $ws SET current_product_entitlement = $snap;`, {
      ws: new RecordId("workspace", wsSlug), snap: existingId,
    });
    return;
  }
  const result = await root.query(
    `CREATE workspace_product_entitlement CONTENT {
      workspace: $ws, revision: 1, digest: 'sha256:e2e-demo',
      summary: 'e2e synthetic entitlement', resolver_version: 'product-entitlement-v1',
      base_source_kind: 'subscription', base_source_id: NONE,
      product_plan_revision: NONE, product_plan_key: 'e2e', product_plan_name: '联调套餐',
      product_revision_number: 1,
      effective_from: time::now() - 1d, effective_until: $until,
      content_collections: [{ collection_key: 'core', display_name: '核心内容' }],
      content_actions: $actions,
      content_sources: [{ kind: 'base', source_id: 'e2e', label: '联调', effective_from: time::now() - 1d, effective_until: $until }],
      ai_actions: $aiActions,
      features: [],
      correlation_id: 'e2e-seed'
    };`,
    { ws: new StringRecordId(`workspace:${wsSlug}`), until, actions, aiActions },
  );
  const snap = (result[0] as Record<string, unknown>[] | undefined)?.[0];
  await root.query(`UPDATE $ws SET current_product_entitlement = $snap;`, {
    ws: new RecordId("workspace", wsSlug), snap: snap?.id ? new StringRecordId(String(snap.id)) : undefined,
  });
}
await seedEntitlement("alpha", ["browse", "read", "cite"], ["research"], null);
await seedEntitlement("beta", ["browse", "read"], [], -3600);

console.log("== 完成：ws_alpha(alice admin, bob member, carol removed) / ws_beta(eve member, 权益过期)");
await root.close(); await alphaDb.close(); await content.close();
