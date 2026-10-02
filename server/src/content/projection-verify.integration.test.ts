import { test, expect } from "bun:test";
import { Surreal } from "surrealdb";
import { generateKeyPair, exportJWK } from "jose";
import { loadPlatformContentScripts } from "@surreal-ck/shared/platform-content-schema";
import { defineReaderFixture } from "../../test/define-reader-fixture";
import { verifyContentProjection } from "./projection-verify";
import { writeContentReaderProjection } from "./reader-projection";
import type { ContentReaderProjectionWrite } from "./reader-exchange";
import { homedir } from "node:os";

const WRITE: ContentReaderProjectionWrite = {
  workspaceId: "ws_team",
  revision: "workspace_product_entitlement:7",
  revisionNumber: 7,
  digest: "sha256:fixture",
  resolverVersion: "test",
  collections: ["core"],
  contentActions: ["read"],
  aiActions: [],
  allowedSubjects: ["ops"],
  confirmedUntilSeconds: Math.floor(Date.now() / 1000) + 600,
  versionId: "content_version:v",
  itemId: "content_item:i",
  licenseId: "source_license_revision:l",
  sourceStatus: "active",
  publicationStatus: "published",
  licenseFromSeconds: Math.floor(Date.now() / 1000) - 3600,
  licenseUntilSeconds: null,
  licenseActions: ["browse", "search", "read", "cite", "export", "research", "generate"],
  gateActions: ["read"],
  gateAiActions: [],
};

/**
 * 公司 fork 上的真实复验：受限投影会话跑多语句核验查询（LET…RETURN 数组形状），
 * 许可矩阵逐来源判定 + 工作区投影行与已交付快照 revision/digest 比对。
 */
test("verifyContentProjection on company fork: real SDK shape, license matrix, projection freshness", async () => {
  const port = 19000 + Math.floor(Math.random() * 10000);
  const password = crypto.randomUUID();
  const keys = await generateKeyPair("ES256");
  const publicKey = await exportJWK(keys.publicKey);
  const jwks = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ keys: [{ ...publicKey, kid: "fixture", alg: "ES256", use: "sig" }] }) });
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
    await defineReaderFixture(root, { jwksUrl: `http://127.0.0.1:${jwks.port}/jwks`, issuer: `http://127.0.0.1:${jwks.port}`, audience: "fixture" }, keys.publicKey);
    const syncPass = crypto.randomUUID();
    await root.query(`
      CREATE content_projection_identity:server SET active = true;
      CREATE content_projection_credential:server SET secret_hash = crypto::argon2::generate($pass);
      CREATE content_source:s SET source_key='s', label='synthetic', base_url='https://example.invalid', status='active', allowed_actions=['publish'];
      CREATE source_license_revision:l SET source=content_source:s, revision=1, license_kind='synthetic', allowed_actions=['browse','search','read','cite'], effective_from=time::now()-1h, created_by_subject='fixture';
      CREATE content_item:i SET public_id='i', kind='legislation', publication_status='published', current_version=content_version:v;
      CREATE content_version:v SET public_id='v', item=content_item:i, revision=1, source=content_source:s, source_url='https://example.invalid', fetched_at=time::now(), title='synthetic', body_text='synthetic body', body_sha256='fixture', source_form='full_text', evidence=[], field_issues=[], processing={}, content_kind_payload={}, created_by_subject='fixture';
      CREATE content_collection_binding:b SET item=content_item:i, collections=['core'];
    `, { pass: syncPass });
    await sync.connect(url, { namespace: "test", database: "content" });
    await sync.signin({ namespace: "test", database: "content", access: "content_projection_sync", variables: { pass: syncPass } });

    const input = {
      workspaceDb: "ws_team",
      expected: { revisionNumber: 7, digest: "sha256:fixture" },
      collections: [{ key: "core", label: "核心" }],
      actions: ["read"],
    };

    // 尚无投影行（首次换票才创建）：不误判为故障。
    const absent = await verifyContentProjection(input, sync);
    expect(absent.workspace.state).toBe("absent");
    expect(absent.verdict).toBe("ok");
    expect(absent.collections[0]).toMatchObject({ publishedItems: 1, readableItems: 1 });

    // 投影行与当前已交付快照一致：active + matchesExpected。
    await writeContentReaderProjection(sync, WRITE);
    const matched = await verifyContentProjection(input, sync);
    expect(matched.workspace).toMatchObject({ state: "active", revisionNumber: 7, matchesExpected: true });
    expect(matched.verdict).toBe("ok");

    // 旧修订投影（digest 不一致）→ projection_stale，能驱动交付修复。
    const stale = await verifyContentProjection({ ...input, expected: { revisionNumber: 8, digest: "sha256:new" } }, sync);
    expect(stale.verdict).toBe("projection_stale");
    expect(stale.workspace.matchesExpected).toBe(false);

    // 许可收紧（新修订过期 read）：真实库上 fail closed 判 license_blocked。
    await root.query(`
      CREATE source_license_revision:l2 SET source=content_source:s, revision=2, license_kind='synthetic',
        allowed_actions=['browse'], effective_from=time::now()-1m, created_by_subject='fixture';
    `);
    const tightened = await verifyContentProjection(input, sync);
    expect(tightened.verdict).toBe("license_blocked");
    expect(tightened.collections[0]!.sources[0]!.reason).toBe("action_denied");
    expect(tightened.collections[0]!.readableItems).toBe(0);
  } finally {
    await sync.close(); await root.close(); proc.kill(); await proc.exited; jwks.stop(true);
  }
}, 60_000);
