/**
 * SCK-LCA-03 数据库层联调矩阵（配合浏览器证据）。
 * 覆盖：换票正例、真实 content_reader token 认证读正文、隐藏字段空、DDL/DML 拒绝、
 * 错误 workspace/revision/subject、投影中断、1s 过期、重复并发收敛、成员移除/非成员、
 * 过期权益、已撤回内容。全部在隔离环境 + 合成数据。
 * 用法：export $(cat /tmp/sck-lca-03-e2e.env); bun .scratch/sck-lca-03-e2e/db-matrix.ts
 */

import { Surreal } from "surrealdb";

const cfg = Object.fromEntries(
  (await Bun.file("/tmp/sck-lca-03-e2e.env").text()).split("\n").filter(Boolean).map((l) => l.split("=", 2) as [string, string]),
);
const SERVER = cfg.SERVER;
const ISSUER = cfg.ISSUER;
const log = (name: string, detail: string) => console.log(`[${name}] ${detail}`);

async function mint(subject: string, claims: Record<string, unknown> = {}, expiresIn = 3600): Promise<string> {
  const res = await fetch(`${ISSUER}/dev/mint`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa("fixture-web:fixture-secret")}`, "content-type": "application/json" },
    body: JSON.stringify({ subject, claims, expiresIn }),
  });
  if (!res.ok) throw new Error(`mint ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function exchange(subject: string, db: string, publicId = "law-demo-1") {
  const token = await mint(subject, { ns: "main", db, ac: "admin", RL: ["Owner"] });
  const res = await fetch(`${SERVER}/api/session/content-reader`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ contentPublicId: publicId }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function readerDb(token: string): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(cfg.SURREAL_URL);
  await db.use({ namespace: cfg.NS, database: "platform_content" });
  await db.authenticate(token);
  return db;
}

const root = new Surreal();
await root.connect(cfg.SURREAL_URL);
await root.signin({ username: cfg.ROOT_USER, password: cfg.ROOT_PASS });
await root.use({ namespace: cfg.NS, database: "platform_content" });

// 1. alice 换票
const ex = await exchange("alice", "ws_alpha");
log("exchange alice", `http=${ex.status} ok=${ex.body?.ok === undefined ? "?" : ex.body.ok} expiresIn=${ex.body?.expiresInSeconds}`);
const readerToken: string = ex.body.accessToken;

// 2. 真实 content_reader token：认证 + 正文可读 + 隐藏字段空
const rdb = await readerDb(readerToken);
const [rows] = await rdb.query(`SELECT public_id, title, body_text FROM content_version WHERE public_id = 'law-demo-1'`) as [Record<string, unknown>[]];
log("reader select body", `rows=${rows.length} title=${rows[0]?.title} body_len=${String(rows[0]?.body_text ?? "").length}`);
const [meta] = await rdb.query(`SELECT public_id, title, revision, source_form FROM content_version WHERE public_id = 'law-demo-1'`) as [Record<string, unknown>[]];
log("reader select metadata", `rows=${meta.length} version_label?=${(meta[0] as Record<string, unknown>)?.source_form}`);
const [hidden] = await rdb.query(`SELECT evidence_text FROM source_license_revision`) as [Record<string, unknown>[]];
log("reader license evidence_text", `rows=${hidden.length} value=${JSON.stringify((hidden[0] as Record<string, unknown>)?.evidence_text ?? null)}`);
const [hidden2] = await rdb.query(`SELECT evidence, processing FROM content_version WHERE public_id = 'law-demo-1'`) as [Record<string, unknown>[]];
log("reader hidden fields", `evidence=${JSON.stringify((hidden2[0] as Record<string, unknown>)?.evidence ?? null)} processing=${JSON.stringify((hidden2[0] as Record<string, unknown>)?.processing ?? null)}`);
const [gate] = await rdb.query(`SELECT id, actions FROM content_read_gate`) as [Record<string, unknown>[]];
log("reader own gate rows", `rows=${gate.length} actions=${JSON.stringify((gate[0] as Record<string, unknown>)?.actions)}`);
const [articles] = await rdb.query(`SELECT label, body_text FROM legal_article_version`) as [Record<string, unknown>[]];
log("reader article body", `rows=${articles.length} body_len=${String((articles[0] as Record<string, unknown>)?.body_text ?? "").length}`);

// 3. DDL / DML 拒绝
try { await rdb.query(`DEFINE TABLE hack SCHEMAFULL`); log("reader DDL", "NO-ERROR (bad)"); }
catch (e) { log("reader DDL denied", String(e).split("\n")[0]); }
try { await rdb.query(`UPDATE content_version:demo1 SET body_text = 'tampered'`); log("reader DML", "NO-ERROR (bad)"); }
catch (e) { log("reader DML denied", String(e).split("\n")[0]); }
try { await rdb.query(`DELETE FROM content_read_gate`); log("reader delete gate", "NO-ERROR (bad)"); }
catch (e) { log("reader delete gate", String(e).split("\n")[0]); }
try { await rdb.query(`UPDATE content_authorization_projection:['ws_alpha'] SET status = 'closed'`); log("reader update own projection", "NO-ERROR (silently denied)"); }
catch (e) { log("reader update own projection", String(e).split("\n")[0]); }
try { await rdb.query(`CREATE content_read_gate:hack CONTENT { version: content_version:demo1, item: content_item:demo1, license: source_license_revision:demo, workspace_id: 'ws_alpha', revision: '1', actions: ['read'], ai_actions: [], source_status: 'active', publication_status: 'published', license_from: time::now(), license_until: NONE, license_actions: [], collection_matched: true, allowed_subjects: ['alice'], status: 'active' }`); log("reader create gate", "NO-ERROR (bad)"); }
catch (e) { log("reader create gate", String(e).split("\n")[0]); }
await rdb.close();

// 4. 重复/并发换票收敛
const [before] = await root.query(`SELECT count() FROM content_authorization_projection GROUP ALL`) as [Record<string, unknown>[]];
const [gBefore] = await root.query(`SELECT count() FROM content_read_gate GROUP ALL`) as [Record<string, unknown>[]];
const results = await Promise.all([1, 2, 3].map(() => exchange("alice", "ws_alpha")));
const [after] = await root.query(`SELECT count() FROM content_authorization_projection GROUP ALL`) as [Record<string, unknown>[]];
const [gAfter] = await root.query(`SELECT count() FROM content_read_gate GROUP ALL`) as [Record<string, unknown>[]];
log("concurrent codes", results.map((r) => (r.body as { error?: { code?: string } })?.error?.code ?? "ok").join(","));
log("concurrent exchange", `oks=${results.filter((r) => r.body?.accessToken).length}/3 projection=${JSON.stringify(before?.[0])}→${JSON.stringify(after?.[0])} gate=${JSON.stringify(gBefore?.[0])}→${JSON.stringify(gAfter?.[0])}`);

// 5. 负例换票
const neg = async (label: string, subject: string, db: string, publicId = "law-demo-1") => {
  const r = await exchange(subject, db, publicId);
  const code = (r.body as { error?: { code?: string } })?.error?.code ?? JSON.stringify(r.body).slice(0, 120);
  log(label, `http=${r.status} code=${code}`);
};
await neg("eve beta expired entitlement", "eve", "ws_beta");
await neg("carol removed member", "carol", "ws_alpha");
await neg("mallory non-member", "mallory", "ws_alpha");
await neg("alice withdrawn content", "alice", "ws_alpha", "law-withdrawn");

// 6. 伪造 workspace/revision 的 content_reader token
for (const [label, ws, rev] of [
  ["forge ws_beta+rev1", "ws_beta", "1"],
  ["forge ws_alpha+rev99", "ws_alpha", "99"],
] as const) {
  const forged = await mint("alice", { ns: "main", ac: "content_reader", db: "platform_content", workspace_id: ws, entitlement_revision: rev }, 300);
  try {
    const fdb = await readerDb(forged);
    await fdb.close();
    log(label, "AUTH OK (bad)");
  } catch (e) { log(label, "auth denied: " + String(e).split("\n")[0]); }
}
// 其他 subject 的合法投影行不能读：mallory 用真实 gate 的 workspace/revision 但 subject 不在 allowed_subjects
const malloryTok = await mint("mallory", { ns: "main", ac: "content_reader", db: "platform_content", workspace_id: "ws_alpha", entitlement_revision: "1" }, 300);
try {
  const mdb = await readerDb(malloryTok);
  const [mrows] = await mdb.query(`SELECT id FROM content_version WHERE public_id = 'law-demo-1'`) as [unknown[]];
  log("mallory subject-not-allowed", `auth ok but rows=${mrows.length}`);
  await mdb.close();
} catch (e) { log("mallory subject-not-allowed", "auth denied: " + String(e).split("\n")[0]); }

// 7. 投影中断 → 旧票据新读取关闭
await root.query(`UPDATE content_authorization_projection:['ws_alpha'] SET status = 'closed'`);
try {
  const cdb = await readerDb(readerToken);
  const [crows] = await cdb.query(`SELECT id FROM content_version`) as [unknown[]];
  log("projection closed → old token", `auth ok rows=${crows.length}`);
  await cdb.close();
} catch (e) { log("projection closed → old token", "auth denied: " + String(e).split("\n")[0]); }
await root.query(`UPDATE content_authorization_projection:['ws_alpha'] SET status = 'active'`);

// 8. 1 秒 token 过期
const shortTok = await mint("alice", { ns: "main", ac: "content_reader", db: "platform_content", workspace_id: "ws_alpha", entitlement_revision: "1" }, 1);
await Bun.sleep(1500);
try {
  const sdb = await readerDb(shortTok);
  await sdb.close();
  log("1s expired token", "AUTH OK (bad)");
} catch (e) { log("1s expired token", "auth denied: " + String(e).split("\n")[0]); }

// 9. 许可过期：license revision 有 immutable event 不可改；改用一条过期许可的来源+内容验证 fail closed。
await root.query(`
  UPSERT content_source:expired SET source_key = 'expired.synthetic', label = '过期来源', jurisdiction = 'CN',
    base_url = 'https://expired.invalid', status = 'active', allowed_actions = ['publish'],
    created_at = time::now(), updated_at = time::now();
  UPSERT source_license_revision:expired SET source = content_source:expired, revision = 1,
    license_kind = 'synthetic-permit', allowed_actions = ['browse','read'],
    effective_from = time::now() - 10d, effective_until = time::now() - 1d,
    evidence_url = NONE, evidence_text = NONE, created_by_subject = 'e2e-seed', created_at = time::now();
  UPSERT content_item:exp SET public_id = 'law-expired', kind = 'legislation',
    current_version = NONE, publication_status = 'published', publication_revision = 1,
    created_at = time::now(), updated_at = time::now();
  UPSERT content_version:exp SET public_id = 'law-expired', item = content_item:exp, revision = 1,
    version_label = NONE, source = content_source:expired, source_url = 'https://expired.invalid/law',
    source_record_key = NONE, fetched_at = time::now(), published_at = time::now(), updated_at_source = NONE,
    published_on = NONE, updated_on = NONE, source_date_text = NONE, title = '过期许可内容',
    body_text = '不应可读', body_sha256 = 'x', source_form = 'full_text',
    evidence = [], field_issues = [], processing = {}, content_kind_payload = {},
    received_at = time::now(), created_by_subject = 'e2e-seed', created_at = time::now();
  UPDATE content_item:exp SET current_version = content_version:exp;
  UPSERT content_collection_binding:exp SET item = content_item:exp, collections = ['core'];`);
await neg("license expired", "alice", "ws_alpha", "law-expired");
// license_revision 表有 immutable event？—— 若更新被拦截上面两条会报错，看输出确认。

// 10. 管理员 RL 不带内容库写权：alice 的工作区 token 直接签内容库 admin access？content db 无 admin access，拒绝
const wsTok = await mint("alice", { ns: "main", db: "platform_content", ac: "admin", RL: ["Owner"] });
try {
  const adb = new Surreal();
  await adb.connect(cfg.SURREAL_URL);
  await adb.use({ namespace: cfg.NS, database: "platform_content" });
  await adb.authenticate(wsTok);
  log("workspace admin token → content db", "AUTH OK (bad)");
  await adb.close();
} catch (e) { log("workspace admin token → content db", "auth denied: " + String(e).split("\n")[0]); }

await root.close();
console.log("DONE");
