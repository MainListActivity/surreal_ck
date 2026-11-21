import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { StringRecordId, Surreal } from "surrealdb";
import { createSyntheticJudgmentBatch, createSyntheticLegislationBatch } from "@surreal-ck/shared/platform-content";
import { loadPlatformContentScripts } from "@surreal-ck/shared/platform-content-schema";
import { PlatformContentService, type StoredContentBatch } from "./service";
import { SurrealPlatformContentStore } from "./store";
import { provisionContentPublisher } from "./publisher-session";

test.skipIf(!process.env.SURREAL_BINARY)("固定参数化批量内容写入保留 publisher 权限、引用、幂等与事务回滚", async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("port unavailable"));
      server.close(() => resolve(address.port));
    });
  });
  const processHandle = Bun.spawn([process.env.SURREAL_BINARY!, "start", "--allow-all", "--bind", `127.0.0.1:${port}`,
    "--user", "root", "--pass", "test-content", "memory"], { stdout: "ignore", stderr: "ignore" });
  const root = new Surreal(), publisher = new Surreal();
  const operator = { subject: "operator:parameterized", capabilities: ["content.submit", "content.publish", "content.source.manage"] };
  let phase = "bootstrap";
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { /* startup */ }
      if (ready) break;
      await Bun.sleep(50);
    }
    if (!ready) throw new Error("isolated content database did not start");
    const url = `ws://127.0.0.1:${port}/rpc`;
    await root.connect(url, { authentication: { username: "root", password: "test-content" } });
    await root.query("DEFINE NAMESPACE IF NOT EXISTS main; USE NS main; DEFINE DATABASE platform_content;").collect();
    await root.use({ namespace: "main", database: "platform_content" });
    for (const script of await loadPlatformContentScripts()) await root.query(script.sql).collect();
    const pass = crypto.randomUUID();
    await provisionContentPublisher(root, pass);
    phase = "publisher-signin";
    await publisher.connect(url, { namespace: "main", database: "platform_content" });
    await publisher.signin({ namespace: "main", database: "platform_content", access: "content_publisher", variables: { pass } });
    const store = new SurrealPlatformContentStore(publisher);
    const service = new PlatformContentService({ store, sources: [] });
    phase = "register-source";
    await service.registerSource(operator, {
      sourceKey: "fixture.synthetic.cn", label: "参数化夹具", baseUrl: "https://example.invalid", status: "active",
      allowedActions: ["submit", "publish", "browse", "search", "read", "cite", "export"],
      license: { licenseKind: "synthetic", allowedActions: ["submit", "publish", "browse", "search", "read", "cite", "export"],
        effectiveFrom: "2026-09-01T00:00:00Z", effectiveUntil: null, evidenceText: "合成许可" },
    });
    const request = await createSyntheticLegislationBatch();
    const first = request.items[0]!;
    if (first.operation !== "upsert" || first.payload.kind !== "legislation") throw new Error("expected law fixture");
    const article = first.payload.legislation.articles[0]!;
    first.payload.legislation.articles = Array.from({ length: 3 }, (_, i) => ({ ...article, localKey: `article-${i}` }));
    request.items = [first, { ...structuredClone(first), entryKey: "law-second", payload: {
      ...first.payload, source: { ...first.payload.source, recordKey: "law-second" },
    } }];
    phase = "submit-laws";
    const submitted = await service.submitBatch(operator, request);
    expect(submitted.entries.map((entry) => entry.status)).toEqual(["accepted", "accepted"]);
    const publication = { batchId: submitted.batchId, validationRevision: 1,
      entryKeys: request.items.map((item) => item.entryKey), idempotencyKey: "publish-law" };
    phase = "publish-laws";
    const published = await service.publishBatch(operator, publication);
    expect(published.status).toBe("completed");
    expect((await service.publishBatch(operator, publication)).publicationId).toBe(published.publicationId);
    const [articles] = await root.query<[Array<{ regulation_version: unknown; local_key: string }>]>("SELECT regulation_version, local_key FROM legal_article_version;");
    expect(articles).toHaveLength(6);
    expect(new Set(articles.map((row) => String(row.regulation_version))).size).toBe(2);
    const judgment = await createSyntheticJudgmentBatch();
    const document = judgment.items[0]!;
    if (document.operation !== "upsert" || document.payload.kind !== "judicial_document") throw new Error("expected judgment fixture");
    const citation = document.payload.judgment.citations[0]!;
    document.payload.judgment.citations = [citation, { ...structuredClone(citation), localCitationKey: "citation-second" }];
    phase = "submit-judgment";
    const judgmentSubmitted = await service.submitBatch(operator, judgment);
    phase = "publish-judgment";
    const judgmentPublished = await service.publishBatch(operator, {
      batchId: judgmentSubmitted.batchId, validationRevision: 1, entryKeys: [document.entryKey], idempotencyKey: "publish-judgment",
    });
    expect(judgmentPublished.status).toBe("completed");
    const [resolutions] = await root.query<[Array<{ citation: { id: unknown; local_citation_key?: string }; status: string; verified_by_subject?: string }>]>(
      "SELECT citation, status, verified_by_subject FROM citation_resolution WHERE revision = 1 FETCH citation;",
    );
    expect(resolutions).toHaveLength(2);
    expect(new Set(resolutions.map((row) => String(row.citation.id))).size).toBe(2);
    expect(resolutions.map((row) => row.citation.local_citation_key).sort()).toEqual([citation.localCitationKey, "citation-second"].sort());
    for (const row of resolutions) expect(row.verified_by_subject).toBe(row.status === "verified" ? operator.subject : undefined);

    phase = "rollback";
    const duplicateStore = new SurrealPlatformContentStore(publisher, (prefix) => new StringRecordId(`${prefix}:duplicate`));
    const failed: StoredContentBatch = {
      batchId: "batch_rollback", actorSubject: operator.subject, idempotencyKey: "rollback", requestDigest: "digest", request,
      receivedAt: "2026-09-01T00:00:00Z", status: "accepted", validationRevision: 1,
      entries: request.items.map((item) => ({ entryKey: item.entryKey, operation: item.operation, status: "accepted", issues: [] })),
    };
    await expect(duplicateStore.saveBatch(failed)).rejects.toThrow();
    expect(await store.getBatch(failed.batchId)).toBeNull();
    const [partial] = await root.query<[unknown[]]>("SELECT * FROM ingestion_entry:duplicate;");
    expect(partial).toHaveLength(0);
  } catch (cause) {
    throw new Error(`parameterized content: ${phase}`, { cause });
  } finally {
    await Promise.allSettled([publisher.close(), root.close()]);
    processHandle.kill("SIGTERM");
    await processHandle.exited;
  }
}, 30_000);
