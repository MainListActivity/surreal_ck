import { test, expect } from "bun:test";
import { Surreal } from "surrealdb";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { loadPlatformContentScripts } from "@surreal-ck/shared/platform-content-schema";
import { defineContentReaderAccess } from "./reader-access";
import { homedir } from "node:os";

test("content reader development DB permissions", async () => {
  const port = 19000 + Math.floor(Math.random() * 10000);
  const password = crypto.randomUUID();
  const keys = await generateKeyPair("ES256");
  const publicKey = await exportJWK(keys.publicKey);
  const jwks = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ keys: [{ ...publicKey, kid: "fixture", alg: "ES256", use: "sig" }] }) });
  const issuer = `http://127.0.0.1:${jwks.port}`;
  const surrealBinary = process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`;
  const proc = Bun.spawn([surrealBinary, "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "test", "--pass", password, "memory"], { stdout: "ignore", stderr: "ignore" });
  const root = new Surreal();
  const reader = new Surreal();
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
    await root.query(`
      CREATE content_source:s SET source_key='s', label='synthetic', base_url='https://example.invalid', status='active', allowed_actions=['publish'];
      CREATE source_license_revision:l SET source=content_source:s, revision=1, license_kind='synthetic', allowed_actions=['browse','search','read','cite','export','research','generate'], effective_from=time::now()-1h, created_by_subject='fixture';
      CREATE content_item:i SET public_id='i', kind='legislation', publication_status='published';
      CREATE content_version:v SET public_id='v', item=content_item:i, revision=1, source=content_source:s, source_url='https://example.invalid', fetched_at=time::now(), title='synthetic', body_text='synthetic body', body_sha256='fixture', source_form='full_text', evidence=[], field_issues=[], processing={}, content_kind_payload={}, created_by_subject='fixture';
      CREATE content_collection_binding:b SET item=content_item:i, collections=['core'];
      CREATE content_version:other SET public_id='other', item=content_item:i, revision=2, source=content_source:s, source_url='https://example.invalid/other', fetched_at=time::now(), title='other title', body_text='other body', body_sha256='other', source_form='full_text', evidence=[], field_issues=[], processing={}, content_kind_payload={}, created_by_subject='fixture';
      CREATE legal_article_version:a SET regulation_version=content_version:v, local_key='art-1', label='第一条', hierarchy_path=['编'], body_text='article body', locator={};
      CREATE content_citation:c SET document_version=content_version:v, local_citation_key='c1', relation_kind='explicit_citation', speaker='court', quoted_text='quoted excerpt', locator={}, resolution='verified', candidates=[];
      CREATE content_authorization_projection:p SET workspace_id='ws_test', revision='1', revision_number=1, digest='sha256:fixture', resolver_version='test', collections=['core'], content_actions=['browse'], ai_actions=[], allowed_subjects=['human'], confirmed_at=time::now(), confirmed_until=time::now()+1m, status='active';
      CREATE content_read_gate:g SET version=content_version:v, item=content_item:i, license=source_license_revision:l, workspace_id='ws_test', revision='1', actions=['browse'], ai_actions=[], source_status='active', publication_status='published', license_from=time::now()-1h, license_until=NONE, license_actions=['browse','search','read','cite','export','research','generate'], collection_matched=true, allowed_subjects=['human'], status='active';
      CREATE content_item:i2 SET public_id='i2', kind='legislation', publication_status='published';
      CREATE content_version:v2 SET public_id='v2', item=content_item:i2, revision=1, source=content_source:s, source_url='https://example.invalid/v2', fetched_at=time::now(), title='workspace two', body_text='workspace two body', body_sha256='w2', source_form='full_text', evidence=[], field_issues=[], processing={}, content_kind_payload={}, created_by_subject='fixture';
      CREATE content_authorization_projection:p2 SET workspace_id='ws_other', revision='1', revision_number=1, digest='sha256:other', resolver_version='test', collections=['core'], content_actions=['read'], ai_actions=[], allowed_subjects=['human-two'], confirmed_at=time::now(), confirmed_until=time::now()+1m, status='active';
      CREATE content_read_gate:g2 SET version=content_version:v2, item=content_item:i2, license=source_license_revision:l, workspace_id='ws_other', revision='1', actions=['read'], ai_actions=[], source_status='active', publication_status='published', license_from=time::now()-1h, license_until=NONE, license_actions=['browse','search','read','cite','export','research','generate'], collection_matched=true, allowed_subjects=['human-two'], status='active';
    `);
    const issue = (subject = "human", revision = "1", lifetime = "60s", workspace = "ws_test") =>
      new SignJWT({ ns: "test", db: "content", ac: "content_reader", workspace_id: workspace, entitlement_revision: revision, RL: ["Owner"] })
        .setSubject(subject).setIssuer(issuer).setAudience("fixture").setExpirationTime(lifetime).setIssuedAt()
        .setProtectedHeader({ alg: "ES256", kid: "fixture" }).sign(keys.privateKey);
    const token = await issue();
    await reader.connect(url, { namespace: 'test', database: 'content' });
    await reader.authenticate(token);
    const rows = await reader.query("SELECT title, body_text FROM content_version;");
    expect(rows).toEqual([[expect.objectContaining({ title: 'synthetic' })]]);
    expect(JSON.stringify(rows)).not.toContain('synthetic body');
    const ddl = new Surreal();
    await ddl.connect(url, { namespace: "test", database: "content" });
    await ddl.authenticate(token);
    const ddlOutcome = await Promise.race([
      ddl.query("DEFINE TABLE unauthorized SCHEMALESS;").then(() => "ok", (error: unknown) => `err:${String(error)}`),
      Bun.sleep(1500).then(() => "timeout"),
    ]);
    await ddl.close();
    expect(ddlOutcome).not.toBe("ok");
    expect(JSON.stringify(await root.query("INFO FOR DB;"))).not.toContain("unauthorized");
    await reader.query("UPDATE content_authorization_projection SET status='closed';");
    expect((await root.query<Array<{ status: string }>>("SELECT status FROM content_authorization_projection;"))[0]?.[0]?.status).toBe("active");
    for (const actions of [["browse"], ["read"], ["cite"], ["export"], ["search"], []]) {
      await root.query("UPDATE content_authorization_projection:p SET content_actions=$actions; UPDATE content_read_gate:g SET actions=$actions;", { actions });
      const result = await reader.query("SELECT title, body_text, evidence, created_by_subject FROM content_version:v;");
      const body = JSON.stringify(result);
      expect(body.includes("synthetic body")).toBe(actions.includes("read"));
      expect(body.includes("other body")).toBe(false);
      expect(body.includes('"title"')).toBe(actions.includes("browse") || actions.includes("search"));
      expect(body.includes("evidence")).toBe(false);
      expect(body.includes("created_by_subject")).toBe(false);
      const article = JSON.stringify(await reader.query("SELECT body_text, source_locator FROM legal_article_version:a;"));
      const citation = JSON.stringify(await reader.query("SELECT quoted_text, treatment_evidence FROM content_citation:c;"));
      expect(article.includes("article body")).toBe(actions.includes("read"));
      expect(citation.includes("quoted excerpt")).toBe(actions.includes("cite"));
      expect(article.includes("source_locator") || citation.includes("treatment_evidence")).toBe(false);
    }
    await root.query("UPDATE content_authorization_projection:p SET content_actions=['browse','read']; UPDATE content_read_gate:g SET actions=['browse','read'];");
    for (const [subject, revision, workspace] of [["other", "1", "ws_test"], ["human", "2", "ws_test"], ["human", "1", "ws_other"]]) {
      const denied = new Surreal();
      try {
        await denied.connect(url, { namespace: "test", database: "content" });
        await expect(denied.authenticate(await issue(subject, revision, "60s", workspace))).rejects.toThrow();
      } finally { await denied.close(); }
    }
    await root.query("UPDATE content_authorization_projection:p SET allowed_subjects=[]; UPDATE content_read_gate:g SET allowed_subjects=[];");
    expect(await reader.query("SELECT title FROM content_version;" )).toEqual([[]]);
    await root.query("UPDATE content_authorization_projection:p SET allowed_subjects=['human'], confirmed_until=time::now()-1s; UPDATE content_read_gate:g SET allowed_subjects=['human'];");
    expect(await reader.query("SELECT title FROM content_version:v;" )).toEqual([[]]);
    await root.query("UPDATE content_authorization_projection:p SET confirmed_until=time::now()+1m;");
    await root.query("UPDATE content_item:i SET publication_status='withdrawn'; UPDATE content_read_gate:g SET publication_status='withdrawn';");
    expect(await reader.query("SELECT title FROM content_version;" )).toEqual([[]]);
    await root.query("UPDATE content_item:i SET publication_status='published'; UPDATE content_read_gate:g SET publication_status='published';");
    await root.query("UPDATE content_read_gate:g SET license_until=time::now()-1s;");
    expect(await reader.query("SELECT title FROM content_version:v;" )).toEqual([[]]);
    await root.query("UPDATE content_read_gate:g SET license_until=NONE;");
    const other = new Surreal();
    try {
      await other.connect(url, { namespace: "test", database: "content" });
      await other.authenticate(await issue("human-two", "1", "60s", "ws_other"));
      const seen = JSON.stringify(await other.query("SELECT title, body_text FROM content_version;"));
      expect(seen.includes("workspace two body")).toBe(true);
      expect(seen.includes("synthetic body")).toBe(false);
    } finally { await other.close(); }
    const write = await reader.query("UPDATE content_version:v SET body_text='changed';").then(() => "ok", (error: unknown) => String(error));
    expect(write === "ok" || /permission|immutable|not allowed/i.test(write)).toBe(true);
    expect(JSON.stringify(await root.query("SELECT body_text FROM content_version:v;"))).toContain("synthetic body");
    expect(JSON.stringify(await root.query("SELECT body_text FROM content_version:v;"))).not.toContain("changed");
    await reader.authenticate(await issue("human", "1", "1s"));
    await Bun.sleep(1200);
    try { expect(await reader.query("SELECT title FROM content_version;" )).toEqual([[]]); }
    catch (error) { expect(String(error)).toMatch(/expir|session|auth/i); }

  } finally {
    await reader.close(); await root.close(); proc.kill(); await proc.exited; jwks.stop(true);
  }
}, 60_000);
