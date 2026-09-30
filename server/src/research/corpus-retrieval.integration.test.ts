import { test, expect } from "bun:test";
import { Surreal } from "surrealdb";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { CONTENT_SEARCH_QUERY } from "@surreal-ck/shared";
import { loadPlatformContentScripts } from "@surreal-ck/shared/platform-content-schema";
import { homedir } from "node:os";
import { defineContentReaderAccess } from "../content/reader-access";
import { ensurePlatformContentSchema } from "../content/schema";
import { writeContentReaderProjection } from "../content/reader-projection";
import type { ContentReaderProjectionWrite } from "../content/reader-exchange";
import { retrieveAuthorizedCorpus } from "./corpus-retrieval";

/**
 * LCA06 联调（真实引擎）：授权候选登记为证据、授权外候选（无 gate / 撤回）被拒，
 * CANARY-DENIED 全程不进入检索结果。需要本地 SurrealDB 时置
 * RUN_LOCAL_PLATFORM_CONTENT_TESTS=1 运行。
 */
const localTest = test.skipIf(process.env.RUN_LOCAL_PLATFORM_CONTENT_TESTS !== "1");

localTest("授权语料检索在真实引擎上按 gate 强制授权", async () => {
  const port = 19000 + Math.floor(Math.random() * 10000);
  const password = crypto.randomUUID();
  const keys = await generateKeyPair("ES256");
  const publicKey = await exportJWK(keys.publicKey);
  const jwks = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ keys: [{ ...publicKey, kid: "fixture", alg: "ES256", use: "sig" }] }),
  });
  const issuer = `http://127.0.0.1:${jwks.port}`;
  const binary = process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`;
  const proc = Bun.spawn([binary, "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "test", "--pass", password, "memory"], { stdout: "ignore", stderr: "ignore" });
  const root = new Surreal();
  const sync = new Surreal();
  const reader = new Surreal();
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* startup */ }
      await Bun.sleep(50);
    }
    const url = `ws://127.0.0.1:${port}/rpc`;
    await root.connect(url);
    await root.signin({ username: "test", password });
    await root.query("DEFINE NAMESPACE test; USE NS test; DEFINE DATABASE content; USE DB content;");
    await root.use({ namespace: "test", database: "content" });
    for (const script of (await loadPlatformContentScripts()).filter((entry) => entry.version <= 6)) await root.query(script.sql);
    await defineContentReaderAccess(root, { jwksUrl: `${issuer}/jwks`, issuer, audience: "fixture" });
    const pass = crypto.randomUUID();
    await root.query(`CREATE content_projection_identity:server SET active = true;
      CREATE content_projection_credential:server SET secret_hash = crypto::argon2::generate($pass);`, { pass });
    const body = "第一条 合同自成立时生效。第二条 当事人应当遵循诚信原则。";
    await root.query(`
      CREATE content_source:s SET source_key='s', label='fixture', jurisdiction='CN', base_url='https://example.invalid', status='active', allowed_actions=['publish'];
      CREATE source_license_revision:l SET source=content_source:s, revision=1, license_kind='fixture', allowed_actions=['browse','search','read','cite','research'], effective_from=time::now()-1h, created_by_subject='fixture';
      CREATE content_item:a SET public_id='a', kind='legislation', publication_status='published', current_version=content_version:a;
      CREATE content_item:b SET public_id='b', kind='legislation', publication_status='published', current_version=content_version:b;
      CREATE content_version:a SET public_id='a-v1', item=content_item:a, revision=1, source=content_source:s, source_url='https://example.invalid/a', fetched_at=time::now(), published_on='2026-01-01', title='甲法', body_text=$body, body_sha256=$bodyHash, source_form='full_text', evidence=[], field_issues=[], processing={}, content_kind_payload={}, created_by_subject='fixture';
      CREATE content_version:b SET public_id='b-v1', item=content_item:b, revision=1, source=content_source:s, source_url='https://example.invalid/b', fetched_at=time::now(), published_on='2026-01-02', title='乙法', body_text='乙法正文涉合同事项。', body_sha256='b', source_form='full_text', evidence=[], field_issues=[], processing={}, content_kind_payload={}, created_by_subject='fixture';
      CREATE legal_article_version:a1 SET regulation_version=content_version:a, local_key='a1', label='第一条', hierarchy_path=[], body_text='第一条 合同自成立时生效。', locator={ start: 0, end: 12, bodyDigest: $bodyHash }, effective_on=NONE, created_at=time::now();
      CREATE content_collection_binding:a SET item=content_item:a, collections=['core'];
      CREATE content_collection_binding:b SET item=content_item:b, collections=['premium'];
      CREATE content_publication_projection:a SET item=content_item:a, version=content_version:a, searchable_text='甲法', indexed_at=time::now(), publication_revision=1;
      CREATE content_publication_projection:b SET item=content_item:b, version=content_version:b, searchable_text='乙法', indexed_at=time::now(), publication_revision=1;
    `, { body, bodyHash: digestOf(body) });
    await root.query("UPSERT platform_content_schema_version:current CONTENT { version: 6, applied_at: time::now() };");
    expect((await ensurePlatformContentSchema(root, { namespace: "test", database: "content" })).appliedVersions).toEqual([7, 8]);
    await sync.connect(url, { namespace: "test", database: "content" });
    await sync.signin({ namespace: "test", database: "content", access: "content_projection_sync", variables: { pass } });

    // workspace 只授权 core 集合：甲法（core）可检索可引用；乙法（premium）无 gate。
    const write: ContentReaderProjectionWrite = {
      workspaceId: "ws_test", revision: "1", revisionNumber: 1, digest: "sha256:fixture", resolverVersion: "test",
      collections: ["core"], contentActions: ["browse", "search", "read", "cite"], aiActions: ["research"], allowedSubjects: ["human"],
      confirmedUntilSeconds: Math.floor(Date.now() / 1000) + 300, versionId: "content_version:a", itemId: "content_item:a", licenseId: "source_license_revision:l",
      sourceStatus: "active", publicationStatus: "published", licenseFromSeconds: Math.floor(Date.now() / 1000) - 3600,
      licenseUntilSeconds: null, licenseActions: ["browse", "search", "read", "cite", "research"],
      gateActions: ["browse", "search", "read", "cite"], gateAiActions: ["research"],
    };
    await writeContentReaderProjection(sync, write);

    const issue = (subject: string) => new SignJWT({ ns: "test", db: "content", ac: "content_reader", workspace_id: "ws_test", entitlement_revision: "1" })
      .setSubject(subject).setIssuer(issuer).setAudience("fixture").setExpirationTime("300s").setIssuedAt()
      .setProtectedHeader({ alg: "ES256", kid: "fixture" }).sign(keys.privateKey);
    await reader.connect(url, { namespace: "test", database: "content" });
    await reader.authenticate(await issue("human"));

    const result = await retrieveAuthorizedCorpus({ session: reader as unknown as Pick<Surreal, "query">, query: "合同" });
    // 只有获授权且有 gate 的甲法登记为证据；乙法（premium 集合）在库层就不出现在候选里。
    expect(result.candidatesSeen).toBe(1);
    expect(result.evidence).toHaveLength(1);
    const evidence = result.evidence[0]!;
    expect(evidence.versionId).toBe("content_version:a");
    expect(evidence.itemId).toBe("content_item:a");
    expect(evidence.versionPublicId).toBe("a-v1");
    expect(evidence.title).toBe("甲法");
    expect(evidence.quote).toBe("第一条 合同自成立时生效。");
    expect(evidence.quoteAllowed).toBe(true);
    expect(evidence.locator).toEqual({ start: 0, end: 12, bodyDigest: digestOf("第一条 合同自成立时生效。第二条 当事人应当遵循诚信原则。") });
    expect(evidence.bodySha256).toBe(evidence.locator!.bodyDigest);
    expect(evidence.sourceKey).toBe("s");
    expect(JSON.stringify(result)).not.toContain("CANARY-DENIED");
    expect(JSON.stringify(result)).not.toContain("b-v1");

    // 撤回后：facet 不再返回候选（当前发布状态 gate）。
    await root.query("UPDATE content_item:a SET publication_status='withdrawn';");
    const afterWithdraw = await reader.query(CONTENT_SEARCH_QUERY, {
      keyword: "合同", kind: "all", from: "", until: "", jurisdiction: "", effective: "",
    });
    expect(afterWithdraw[0]).toHaveLength(0);
  } finally {
    await reader.close().catch(() => undefined);
    await sync.close().catch(() => undefined);
    await root.close().catch(() => undefined);
    proc.kill();
    await proc.exited;
    jwks.stop(true);
  }
}, 60_000);

function digestOf(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}
