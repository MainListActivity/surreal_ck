import { test, expect } from "bun:test";
import { Surreal } from "surrealdb";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { CONTENT_SEARCH_COUNT_QUERY, CONTENT_SEARCH_QUERY } from "@surreal-ck/shared";
import { loadPlatformContentScripts } from "@surreal-ck/shared/platform-content-schema";
import { homedir } from "node:os";
import { defineReaderFixture } from "../../test/define-reader-fixture";
import { ensurePlatformContentSchema } from "./schema";
import { writeContentReaderProjection } from "./reader-projection";
import { CONTENT_CATALOG_SCAN_QUERY } from "./search-exchange";
import type { ContentReaderProjectionWrite } from "./reader-exchange";

test("authorized catalog filters before pagination and count", async () => {
  const port = 19000 + Math.floor(Math.random() * 10000);
  const password = crypto.randomUUID();
  const keys = await generateKeyPair("ES256");
  const publicKey = await exportJWK(keys.publicKey);
  const jwks = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ keys: [{ ...publicKey, kid: "fixture", alg: "ES256", use: "sig" }] }) });
  const issuer = `http://127.0.0.1:${jwks.port}`;
  const binary = process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`;
  const proc = Bun.spawn([binary, "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "test", "--pass", password, "memory"], { stdout: "ignore", stderr: "ignore" });
  const root = new Surreal();
  const sync = new Surreal();
  const reader = new Surreal();
  const other = new Surreal();
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* startup */ }
      await Bun.sleep(50);
    }
    const url = `ws://127.0.0.1:${port}/rpc`;
    await root.connect(url); await root.signin({ username: "test", password });
    await root.query("DEFINE NAMESPACE test; USE NS test; DEFINE DATABASE content; USE DB content;");
    await root.use({ namespace: "test", database: "content" });
    for (const script of (await loadPlatformContentScripts()).filter((entry) => entry.version <= 6)) await root.query(script.sql);
    await defineReaderFixture(root, { jwksUrl: `${issuer}/jwks`, issuer, audience: "fixture" }, keys.publicKey);
    const pass = crypto.randomUUID();
    await root.query(`CREATE content_projection_identity:server SET active = true;
      CREATE content_projection_credential:server SET secret_hash = crypto::argon2::generate($pass);`, { pass });
    await root.query(`
      CREATE content_source:s SET source_key='s', label='fixture', jurisdiction='CN', base_url='https://example.invalid', status='active', allowed_actions=['publish'];
      CREATE source_license_revision:l SET source=content_source:s, revision=1, license_kind='fixture', allowed_actions=['browse','search','read','cite'], effective_from=time::now()-1h, created_by_subject='fixture';
      CREATE content_item:a SET public_id='a', kind='legislation', publication_status='published', current_version=content_version:a;
      CREATE content_item:b SET public_id='b', kind='judicial_document', publication_status='published', current_version=content_version:b;
      CREATE content_version:a SET public_id='a-v1', item=content_item:a, revision=1, source=content_source:s, source_url='https://example.invalid/a', fetched_at=time::now(), published_on='2026-01-01', title='甲法', body_text='甲法正文', body_sha256='a', source_form='full_text', evidence=[], field_issues=[], processing={}, content_kind_payload={}, created_by_subject='fixture';
      CREATE content_version:b SET public_id='b-v1', item=content_item:b, revision=1, source=content_source:s, source_url='https://example.invalid/b', fetched_at=time::now(), published_on='2026-01-02', title='乙案', body_text='乙案正文', body_sha256='b', source_form='full_text', evidence=[], field_issues=[], processing={}, content_kind_payload={}, created_by_subject='fixture';
      CREATE content_collection_binding:a SET item=content_item:a, collections=['core'];
      CREATE content_collection_binding:b SET item=content_item:b, collections=['premium'];
      CREATE content_publication_projection:a SET item=content_item:a, version=content_version:a, searchable_text='甲法', indexed_at=time::now(), publication_revision=1;
      CREATE content_publication_projection:b SET item=content_item:b, version=content_version:b, searchable_text='乙案', indexed_at=time::now(), publication_revision=1;
    `);
    await root.query("UPSERT platform_content_schema_version:current CONTENT { version: 6, applied_at: time::now() };");
    expect((await ensurePlatformContentSchema(root, { namespace: "test", database: "content" })).appliedVersions).toEqual([7, 8, 9]);
    await sync.connect(url, { namespace: "test", database: "content" });
    await sync.signin({ namespace: "test", database: "content", access: "content_projection_sync", variables: { pass } });
    // 回归（LCA04 生产 503 根因）：3.3 引擎要求 ORDER BY 字段在 SELECT 投影内，
    // catalog 扫描必须原样在真实引擎上执行通过并返回公开指针。
    const catalog = await sync.query(CONTENT_CATALOG_SCAN_QUERY);
    expect((catalog[0] as { public_id?: string }[]).map((row) => row.public_id).sort())
      .toEqual(["a-v1", "b-v1"]);
    const write: ContentReaderProjectionWrite = {
      workspaceId: "ws_test", revision: "1", revisionNumber: 1, digest: "sha256:fixture", resolverVersion: "test",
      collections: ["core"], contentActions: ["browse", "search", "read", "cite"], aiActions: [], allowedSubjects: ["human"],
      confirmedUntilSeconds: Math.floor(Date.now() / 1000) + 120, versionId: "content_version:a", itemId: "content_item:a", licenseId: "source_license_revision:l",
      sourceStatus: "active", publicationStatus: "published", licenseFromSeconds: Math.floor(Date.now() / 1000) - 3600,
      licenseUntilSeconds: null, licenseActions: ["browse", "search", "read", "cite"], gateActions: ["browse", "search", "read", "cite"], gateAiActions: [],
    };
    await writeContentReaderProjection(sync, write);
    const issue = (subject: string) => new SignJWT({ ns: "test", db: "content", ac: "content_reader", workspace_id: "ws_test", entitlement_revision: "1" })
      .setSubject(subject).setIssuer(issuer).setAudience("fixture").setExpirationTime("120s").setIssuedAt()
      .setProtectedHeader({ alg: "ES256", kid: "fixture" }).sign(keys.privateKey);
    await reader.connect(url, { namespace: "test", database: "content" }); await reader.authenticate(await issue("human"));
    await other.connect(url, { namespace: "test", database: "content" });
    await expect(other.authenticate(await issue("outsider"))).rejects.toThrow();
    const filters = { keyword: "甲", kind: "legislation", from: "2026-01-01", until: "2026-12-31", jurisdiction: "CN", effective: "", cursor: undefined };
    const allowed = await reader.query(CONTENT_SEARCH_QUERY, filters);
    expect(allowed[0]).toHaveLength(1);
    expect(JSON.stringify(allowed)).toContain("a-v1");
    expect(JSON.stringify(allowed)).not.toContain("b-v1");
    const denied = await reader.query(CONTENT_SEARCH_QUERY, { ...filters, keyword: "乙", kind: "all", jurisdiction: "" });
    expect(denied[0]).toHaveLength(0);
    const count = await reader.query(CONTENT_SEARCH_COUNT_QUERY, { ...filters, keyword: "", kind: "all", from: "", until: "", jurisdiction: "" });
    expect(count[0]).toEqual([{ total: 1 }]);
    expect((await reader.query("SELECT * FROM content_publication_projection;"))[0]).toEqual([]);
    // A corrected publication replaces the searchable facet, while the old
    // version remains a stable pointer and needs its own read authorization.
    await root.query(`CREATE content_version:a2 SET public_id='a-v2', item=content_item:a, revision=2,
      source=content_source:s, source_url='https://example.invalid/a2', fetched_at=time::now(),
      published_on='2026-02-01', title='甲法修订', body_text='修订正文', body_sha256='a2',
      source_form='full_text', evidence=[], field_issues=[], processing={}, content_kind_payload={}, created_by_subject='fixture';
      UPDATE content_item:a SET current_version=content_version:a2;
      UPDATE content_publication_projection:a SET version=content_version:a2;
      UPDATE content_search_facet SET version=content_version:a2, published_on='2026-02-01' WHERE item=content_item:a;`);
    expect((await reader.query(CONTENT_SEARCH_QUERY, filters))[0]).toHaveLength(0);
    await writeContentReaderProjection(sync, { ...write, versionId: "content_version:a2" });
    expect(JSON.stringify((await reader.query(CONTENT_SEARCH_QUERY, filters))[0])).toContain("a-v2");
    expect(JSON.stringify((await reader.query(CONTENT_SEARCH_QUERY, filters))[0])).not.toContain("a-v1");
    const batch = Array.from({ length: 20 }, (_, i) => {
      const key = `c${String(i).padStart(2, "0")}`;
      return `CREATE content_item:${key} SET public_id='${key}', kind='legislation', publication_status='published', current_version=content_version:${key};
        CREATE content_version:${key} SET public_id='${key}-v1', item=content_item:${key}, revision=1,
          source=content_source:s, source_url='https://example.invalid/${key}', fetched_at=time::now(),
          published_on='2026-02-01', title='甲法 ${key}', body_text='正文', body_sha256='${key}',
          source_form='full_text', evidence=[], field_issues=[], processing={}, content_kind_payload={}, created_by_subject='fixture';
        CREATE content_search_facet:${key} SET item=content_item:${key}, version=content_version:${key},
          kind='legislation', jurisdiction='CN', published_on='2026-02-01';`;
    }).join("\n");
    await root.query(batch);
    for (let i = 0; i < 20; i++) {
      const key = `c${String(i).padStart(2, "0")}`;
      await writeContentReaderProjection(sync, { ...write, itemId: `content_item:${key}`, versionId: `content_version:${key}` });
    }
    const allFilters = { ...filters, keyword: "", kind: "all", from: "", until: "", jurisdiction: "" };
    const firstPage = (await reader.query(CONTENT_SEARCH_QUERY, allFilters))[0] as Array<{ id: unknown }>;
    expect(firstPage).toHaveLength(21);
    const cursor = firstPage[19]!.id;
    const secondPage = (await reader.query(CONTENT_SEARCH_QUERY, { ...allFilters, cursor }))[0] as unknown[];
    expect(secondPage).toHaveLength(1);
    expect((await reader.query(CONTENT_SEARCH_COUNT_QUERY, allFilters))[0]).toEqual([{ total: 21 }]);
    await root.query("UPDATE content_item:a SET publication_status='withdrawn';");
    expect((await reader.query(CONTENT_SEARCH_COUNT_QUERY, allFilters))[0]).toEqual([{ total: 20 }]);
  } finally {
    await other.close(); await reader.close(); await sync.close(); await root.close(); proc.kill(); await proc.exited; jwks.stop(true);
  }
}, 60_000);
