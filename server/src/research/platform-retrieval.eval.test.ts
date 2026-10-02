import { test, expect } from "bun:test";
import { Surreal } from "surrealdb";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { loadPlatformContentScripts } from "@surreal-ck/shared/platform-content-schema";
import { homedir } from "node:os";
import { defineReaderFixture } from "../../test/define-reader-fixture";
import { ensurePlatformContentSchema } from "../content/schema";
import { writeContentReaderProjection } from "../content/reader-projection";
import type { ContentReaderProjectionWrite } from "../content/reader-exchange";
import { LegalRetrievalRequestSchema } from "@surreal-ck/shared";
import { retrievePlatformCandidates } from "./platform-retrieval";
import { createEmbeddingProfileKey } from "../resources/research-save";

/**
 * LCA12 测量集（固定夹具，真实引擎）：确定性 char-bag 向量模拟 provider，
 * 语料含 keyword 命中、仅语义可召回、授权外强关键词（泄露哨兵）与撤回四类文档。
 * 输出 recall@10 / 延迟 / 泄露计数的测量记录；任何哨兵或撤回文档出现即失败。
 */
const QUERY = "抵押权的设立条件";
const charVector = (text: string): number[] => {
  const vector = Array.from<number>({ length: 1536 }).fill(0);
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (!/[\p{L}\p{N}]/u.test(ch)) continue;
    vector[(code * 2654435761) % 1536] += 1;
  }
  return vector;
};

type Doc = { key: string; title: string; body: string; denied?: boolean; withdrawn?: boolean };
const DOCS: Doc[] = [
  // 与查询词面重合的相关文档（关键词基线可召回）
  { key: "rk1", title: "抵押权的设立条件", body: "抵押权的设立条件包括书面抵押合同与登记手续。" },
  { key: "rk2", title: "抵押权登记", body: "不动产抵押权自登记时设立，抵押合同是设立的前提条件。" },
  { key: "rk3", title: "最高额抵押", body: "最高额抵押权在决算期确定债权，其设立条件与登记规则相同。" },
  // 语义相关但不含任何查询词面片段（关键词基线应漏检）
  { key: "rs1", title: "担保物权变动", body: "不动产担保物权登记后确立的对抗效力与要件由登记簿决定。" },
  { key: "rs2", title: "登记要件与效力", body: "不动产担保经登记后确立的对抗效力与保全要件由登记簿决定。" },
  { key: "rs3", title: "海商担保", body: "船舶担保物权经登记后确立的对抗效力与受偿要件由登记机关确认。" },
  // 授权内噪声文档：可能共享单字（权/的/件），但无语义相关含义
  { key: "n01", title: "海难救助报酬", body: "救助方对获救财产享有海难救助报酬请求权。" },
  { key: "n02", title: "提单背书", body: "指示提单经背书转让，记名提单不得转让。" },
  { key: "n03", title: "共同海损", body: "共同海损理算由航程终止地机构办理。" },
  { key: "n04", title: "海事赔偿责任限制", body: "船舶所有人可申请设立海事赔偿责任限制基金。" },
  { key: "n05", title: "仲裁协议", body: "有效仲裁协议排除法院管辖，书面形式为必要。" },
  { key: "n06", title: "劳动仲裁时效", body: "劳动争议申请仲裁的时效期间为一年。" },
  { key: "n07", title: "破产取回权", body: "破产程序中权利人可取回不属于债务人的财产。" },
  { key: "n08", title: "票据追索", body: "持票人被拒付后得向背书人行使追索权。" },
  { key: "n09", title: "商标续展", body: "注册商标有效期届满前十二个月内可办理续展。" },
  { key: "n10", title: "专利强制许可", body: "专利权人自授予之日起满三年未实施的可申请强制许可。" },
  { key: "n11", title: "著作权邻接权", body: "表演者对其表演享有许可录音录像并获得报酬的权利。" },
  { key: "n12", title: "海上保险委付", body: "推定全损时被保险人可将保险标的委付给保险人。" },
  { key: "n13", title: "继承顺序", body: "法定继承按配偶、子女、父母为第一顺序。" },
  { key: "n14", title: "行政复议期限", body: "公民自知道行政行为之日起六十日内可申请复议。" },
  { key: "n15", title: "外商投资准入", body: "负面清单以外的外商投资领域实行备案管理。" },
  { key: "n16", title: "环境公益诉讼", body: "符合条件的社会组织可提起环境民事公益诉讼。" },
  { key: "n17", title: "建设工程价款", body: "承包人工程价款就该工程折价或拍卖款优先受偿。" },
  { key: "n18", title: "网络侵权责任", body: "网络服务提供者经通知后应采取必要措施。" },
  // 授权外哨兵：词面强命中但工作区无 gate（泄露必须为零）
  { key: "d1", title: "抵押权的设立条件详解", body: "抵押权的设立条件权威指引，完整条文与裁判要旨。", denied: true },
  { key: "d2", title: "抵押权设立判例", body: "抵押权设立条件争议的最高法院裁判规则汇编。", denied: true },
  { key: "d3", title: "担保设立实务", body: "抵押权设立条件与登记对抗问题实务全书。", denied: true },
  // 已撤回：曾经是授权内容，撤回后不得复活
  { key: "w1", title: "抵押权旧规", body: "已废止的抵押权设立条件旧规范文本。", withdrawn: true },
];
const RELEVANT = ["rk1", "rk2", "rk3", "rs1", "rs2", "rs3"];

test("固定法律检索集：召回率、延迟与授权泄露测量", async () => {
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
    await root.query(`CREATE content_source:s SET source_key='s', label='fixture', jurisdiction='CN', base_url='https://example.invalid', status='active', allowed_actions=['publish'];
      CREATE source_license_revision:l SET source=content_source:s, revision=1, license_kind='fixture', allowed_actions=['browse','search','read','cite','research'], effective_from=time::now()-1h, created_by_subject='fixture';`);
    for (const doc of DOCS) {
      await root.query(`
        CREATE content_item:${doc.key} SET public_id='${doc.key}', kind='legislation', publication_status='${doc.withdrawn ? "withdrawn" : "published"}', current_version=content_version:${doc.key};
        CREATE content_version:${doc.key} SET public_id='${doc.key}-v1', item=content_item:${doc.key}, revision=1, source=content_source:s,
          source_url='https://example.invalid/${doc.key}', fetched_at=time::now(), published_on='2026-01-01', title=$title, body_text=$body,
          body_sha256=$sha, source_form='full_text', evidence=[], field_issues=[], processing={}, content_kind_payload={}, created_by_subject='fixture';`,
        { title: doc.title, body: doc.body, sha: `sha-${doc.key}` });
    }
    await root.query("UPSERT platform_content_schema_version:current CONTENT { version: 6, applied_at: time::now() };");
    expect((await ensurePlatformContentSchema(root, { namespace: "test", database: "content" })).appliedVersions).toEqual([7, 8, 9]);
    for (const doc of DOCS) {
      await root.query(`CREATE content_search_facet:${doc.key} SET item=content_item:${doc.key}, version=content_version:${doc.key},
        kind='legislation', jurisdiction='CN', published_on='2026-01-01', effective_on='2026-01-01';`);
    }
    await sync.connect(url, { namespace: "test", database: "content" });
    await sync.signin({ namespace: "test", database: "content", access: "content_projection_sync", variables: { pass } })
      .catch((error: unknown) => { throw new Error("fixture projection SIGNIN failed", { cause: error }); });
    // 只对授权文档写 gate；denied/withdrawn 无投影，引擎侧不可见。
    const base: ContentReaderProjectionWrite = {
      workspaceId: "ws_eval", revision: "1", revisionNumber: 1, digest: "sha256:fixture", resolverVersion: "test",
      collections: ["core"], contentActions: ["browse", "search", "read", "cite"], aiActions: [], allowedSubjects: ["human"],
      confirmedUntilSeconds: Math.floor(Date.now() / 1000) + 300, versionId: "", itemId: "", licenseId: "source_license_revision:l",
      sourceStatus: "active", publicationStatus: "published", licenseFromSeconds: Math.floor(Date.now() / 1000) - 3600,
      licenseUntilSeconds: null, licenseActions: ["browse", "search", "read", "cite", "research"],
      gateActions: ["browse", "search", "read", "cite"], gateAiActions: [],
    };
    for (const doc of DOCS.filter((d) => !d.denied && !d.withdrawn)) {
      await writeContentReaderProjection(sync, { ...base, versionId: `content_version:${doc.key}`, itemId: `content_item:${doc.key}` });
    }
    const provider = { async embed({ text }: { text: string }) { return charVector(text); } };
    const profile = { provider: "fixture-charbag", model: "legal-chars", dimensions: 1536, version: "v1", release: "release-1" };
    const profileKey = createEmbeddingProfileKey(profile);
    await root.query(`CREATE content_embedding_profile:default CONTENT $profile;`, { profile });
    for (const doc of DOCS) {
      const vector = charVector(`${doc.title}\n${doc.body}`);
      await root.query(`CREATE content_search_embedding:${doc.key} SET item=content_item:${doc.key}, version=content_version:${doc.key},
        profile_key=$profileKey, release='release-1', body_sha256=$sha, vector=$vector, indexed_at=time::now();`,
        { profileKey, sha: `sha-${doc.key}`, vector });
    }
    await reader.connect(url, { namespace: "test", database: "content" });
    await reader.authenticate(await new SignJWT({ ns: "test", db: "content", ac: "content_reader", workspace_id: "ws_eval", entitlement_revision: "1" })
      .setSubject("human").setIssuer(issuer).setAudience("fixture").setExpirationTime("300s").setIssuedAt()
      .setProtectedHeader({ alg: "ES256", kid: "fixture" }).sign(keys.privateKey))
      .catch((error: unknown) => { throw new Error("fixture content_reader JWT authentication failed", { cause: error }); });

    const request = LegalRetrievalRequestSchema.parse({ query: QUERY, limit: 10 });
    const t0 = performance.now();
    const baseline = await retrievePlatformCandidates({ session: reader, request: { ...request, mode: "keyword" } });
    const keywordMs = performance.now() - t0;
    const t1 = performance.now();
    const hybrid = await retrievePlatformCandidates({ session: reader, request, embeddingProvider: provider });
    const hybridMs = performance.now() - t1;

    const publicIdsOf = (items: typeof hybrid.items) => new Set(items.map((hit) => hit.itemId.replace("content_item:", "")));
    const kwFound = publicIdsOf(baseline.items);
    const hyFound = publicIdsOf(hybrid.items);

    const leak = (items: typeof hybrid.items) => items.filter((hit) =>
      DOCS.find((d) => `content_item:${d.key}` === hit.itemId && (d.denied || d.withdrawn))).length;
    const recall = (found: Set<string>) => RELEVANT.filter((k) => found.has(k)).length / RELEVANT.length;

    const report = {
      corpus: { authorized: DOCS.filter((d) => !d.denied && !d.withdrawn).length, denied: DOCS.filter((d) => d.denied).length, withdrawn: DOCS.filter((d) => d.withdrawn).length, relevant: RELEVANT.length },
      keyword: { recall10: recall(kwFound), hits: [...kwFound].sort(), latencyMs: Math.round(keywordMs), leaked: leak(baseline.items) },
      hybrid: { recall10: recall(hyFound), hits: [...hyFound].sort(), latencyMs: Math.round(hybridMs), leaked: leak(hybrid.items), indexVersion: hybrid.indexVersion },
    };
    console.log("LCA12-EVAL " + JSON.stringify(report));

    expect(hybrid.capability).toBe("hybrid");
    expect(leak(baseline.items)).toBe(0);
    expect(leak(hybrid.items)).toBe(0);
    expect(hybrid.items.every((hit) => hit.itemId !== "content_item:w1")).toBe(true);
    expect(recall(hyFound)).toBeGreaterThan(recall(kwFound));
    for (const key of kwFound) expect(hyFound.has(key)).toBe(true);
    expect(hyFound.has("rs1")).toBe(true);
    expect(hyFound.has("rs2")).toBe(true);
    expect(hyFound.has("rs3")).toBe(true);
  } finally {
    await reader.close(); await sync.close(); await root.close(); proc.kill(); await proc.exited; jwks.stop(true);
  }
}, 90_000);
