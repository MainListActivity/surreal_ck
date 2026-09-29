import { test, expect } from "bun:test";
import { Surreal } from "surrealdb";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { loadPlatformContentScripts } from "@surreal-ck/shared/platform-content-schema";
import { defineContentReaderAccess } from "./reader-access";
import { fetchContentReaderTarget, writeContentReaderProjection } from "./reader-projection";
import type { ContentReaderProjectionWrite } from "./reader-exchange";
import { homedir } from "node:os";

const WRITE: ContentReaderProjectionWrite = {
  workspaceId: "ws_test",
  revision: "7",
  revisionNumber: 7,
  digest: "sha256:fixture",
  resolverVersion: "test",
  collections: ["core"],
  contentActions: ["browse", "read"],
  aiActions: [],
  allowedSubjects: ["human"],
  confirmedUntilSeconds: Math.floor(Date.now() / 1000) + 600,
  versionId: "content_version:v",
  itemId: "content_item:i",
  licenseId: "source_license_revision:l",
  sourceStatus: "active",
  publicationStatus: "published",
  licenseFromSeconds: Math.floor(Date.now() / 1000) - 3600,
  licenseUntilSeconds: null,
  licenseActions: ["browse", "search", "read", "cite", "export", "research", "generate"],
  gateActions: ["browse", "read"],
  gateAiActions: [],
};

test("content projection sync writes converge and gate a real content_reader session", async () => {
  const port = 19000 + Math.floor(Math.random() * 10000);
  const password = crypto.randomUUID();
  const keys = await generateKeyPair("ES256");
  const publicKey = await exportJWK(keys.publicKey);
  const jwks = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ keys: [{ ...publicKey, kid: "fixture", alg: "ES256", use: "sig" }] }) });
  const issuer = `http://127.0.0.1:${jwks.port}`;
  const surrealBinary = process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`;
  const proc = Bun.spawn([surrealBinary, "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "test", "--pass", password, "memory"], { stdout: "ignore", stderr: "ignore" });
  const root = new Surreal();
  const sync = new Surreal();
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* local startup */ }
      await Bun.sleep(50);
    }
    const url = `ws://127.0.0.1:${port}/rpc`;
    await root.connect(url);
    await root.signin({ username: "test", password });
    await root.query("DEFINE NAMESPACE test; USE NS test; DEFINE DATABASE content; USE DB content;");
    await root.use({ namespace: "test", database: "content" });
    for (const script of await loadPlatformContentScripts()) await root.query(script.sql);
    await defineContentReaderAccess(root, { jwksUrl: `${issuer}/jwks`, issuer, audience: "fixture" });

    const syncPass = crypto.randomUUID();
    await root.query(`
      CREATE content_projection_identity:server SET active = true;
      CREATE content_projection_credential:server SET secret_hash = crypto::argon2::generate($pass);
    `, { pass: syncPass });
    await root.query(`
      CREATE content_source:s SET source_key='s', label='synthetic', base_url='https://example.invalid', status='active', allowed_actions=['publish'];
      CREATE source_license_revision:l SET source=content_source:s, revision=1, license_kind='synthetic', allowed_actions=['browse','search','read','cite','export','research','generate'], effective_from=time::now()-1h, created_by_subject='fixture';
      CREATE content_item:i SET public_id='i', kind='legislation', publication_status='published', current_version=content_version:v;
      CREATE content_version:v SET public_id='v', item=content_item:i, revision=1, source=content_source:s, source_url='https://example.invalid', fetched_at=time::now(), title='synthetic', body_text='synthetic body', body_sha256='fixture', source_form='full_text', evidence=[], field_issues=[], processing={}, content_kind_payload={}, created_by_subject='fixture';
      CREATE content_collection_binding:b SET item=content_item:i, collections=['core'];
    `);

    await sync.connect(url, { namespace: "test", database: "content" });
    await sync.signin({ namespace: "test", database: "content", access: "content_projection_sync", variables: { pass: syncPass } });

    // 受限会话读事实快照（不含正文）。
    const target = await fetchContentReaderTarget(sync, "v");
    expect(target).toEqual({
      versionId: "content_version:v",
      itemId: "content_item:i",
      licenseId: "source_license_revision:l",
      sourceActive: true,
      publicationStatus: "published",
      collectionKeys: ["core"],
      licenseFromSeconds: expect.any(Number),
      licenseUntilSeconds: null,
      licenseActions: ["browse", "search", "read", "cite", "export", "research", "generate"],
    });
    expect(await fetchContentReaderTarget(sync, "missing")).toBeNull();

    // 重复换票收敛到同一行 active 投影。
    await writeContentReaderProjection(sync, WRITE);
    await writeContentReaderProjection(sync, { ...WRITE, confirmedUntilSeconds: WRITE.confirmedUntilSeconds + 60 });
    let projections = await root.query<{ id: unknown; status: string; revision: string }[]>("SELECT id, status, revision FROM content_authorization_projection;");
    expect(projections[0]).toHaveLength(1);
    expect(projections[0]?.[0]?.status).toBe("active");

    // 并发换票同样收敛：同一 workspace 一行投影，同一版本一行门禁。
    await Promise.all([
      writeContentReaderProjection(sync, { ...WRITE, allowedSubjects: ["human", "admin"] }),
      writeContentReaderProjection(sync, { ...WRITE, allowedSubjects: ["human", "admin"] }),
      writeContentReaderProjection(sync, { ...WRITE, allowedSubjects: ["human"] }),
      writeContentReaderProjection(sync, { ...WRITE, allowedSubjects: ["human"] }),
    ]);
    projections = await root.query("SELECT id, status, revision FROM content_authorization_projection;");
    expect(projections[0]).toHaveLength(1);
    const gates = await root.query("SELECT id FROM content_read_gate;");
    expect(gates[0]).toHaveLength(1);
    const gateRow = (await root.query<{ actions: string[]; ai_actions: string[] }[]>("SELECT actions, ai_actions FROM content_read_gate;"))[0]?.[0];
    expect(gateRow?.actions).toEqual(["browse", "read"]);

    // 换票后的真实 content_reader 会话能读到正文（投影 + 门禁链路生效）。
    const issue = (subject = "human", revision = "7", lifetime = "120s", workspace = "ws_test") =>
      new SignJWT({ ns: "test", db: "content", ac: "content_reader", workspace_id: workspace, entitlement_revision: revision })
        .setSubject(subject).setIssuer(issuer).setAudience("fixture").setExpirationTime(lifetime).setIssuedAt()
        .setProtectedHeader({ alg: "ES256", kid: "fixture" }).sign(keys.privateKey);
    const reader = new Surreal();
    try {
      await reader.connect(url, { namespace: "test", database: "content" });
      await reader.authenticate(await issue());
      const rows = await reader.query("SELECT title, body_text FROM content_version:v;");
      expect(JSON.stringify(rows)).toContain("synthetic body");
    } finally { await reader.close(); }

    // 纯 AI 门禁：ai_use 为真但正文/元数据字段仍为空。
    await writeContentReaderProjection(sync, { ...WRITE, revision: "8", revisionNumber: 8, contentActions: [], aiActions: ["research"], gateActions: [], gateAiActions: ["research"] });
    const aiReader = new Surreal();
    try {
      await aiReader.connect(url, { namespace: "test", database: "content" });
      await aiReader.authenticate(await issue("human", "8"));
      const allowed = await aiReader.query("RETURN fn::content_reader_action(content_version:v, 'ai_use');");
      expect(allowed).toEqual([true]);
      const deniedMeta = JSON.stringify(await aiReader.query("SELECT title, body_text FROM content_version:v;"));
      expect(deniedMeta).not.toContain("synthetic body");
      expect(deniedMeta).not.toContain('"title"');
      const article = JSON.stringify(await aiReader.query("SELECT body_text FROM legal_article_version;"));
      expect(article).not.toContain("body");
    } finally { await aiReader.close(); }
  } finally {
    await sync.close(); await root.close(); proc.kill(); await proc.exited; jwks.stop(true);
  }
}, 60_000);
