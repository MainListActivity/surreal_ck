import { describe, expect, test } from "bun:test";
import { Surreal } from "surrealdb";
import { createSyntheticJudgmentBatch, createSyntheticLegislationBatch } from "@surreal-ck/shared/platform-content";
import { loadPlatformContentScripts } from "@surreal-ck/shared/platform-content-schema";
import { PlatformContentService } from "./service";
import { SurrealPlatformContentStore } from "./store";
import { provisionContentPublisher } from "./publisher-session";
import { fetchContentReaderTarget } from "./reader-projection";
import { planContentReaderExchange } from "./reader-exchange";
import { SurrealNativeQuotaClient } from "../db/native-quota/client";
import { extractNativeQuotaError } from "@surreal-ck/shared/native-quota";
import { Hono } from "hono";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { createContentRoutes } from "../routes/content";
import { createContentMcpRoutes } from "../ops/mcp/routes";
import { HttpError } from "../http-error";

const localTest = test.skipIf(process.env.RUN_LOCAL_PLATFORM_CONTENT_TESTS !== "1");

const operator = {
  subject: "operator:local",
  capabilities: ["content.submit", "content.read", "content.publish", "content.withdraw", "content.restore", "content.source.manage"],
} as const;

describe("Surreal platform content store", () => {
  localTest("persists a batch and publishes, withdraws, then restores one item", async () => {
    const db = new Surreal();
    const publisher = new Surreal();
    const namespace = `content_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const database = "platform";
    await db.connect(process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8999/rpc", {
      namespace,
      database,
      authentication: { username: "root", password: "root" },
    });
    await db.use({ namespace, database });
    try {
      const scripts = await loadPlatformContentScripts();
      if (scripts.length === 0) throw new Error("platform schema missing");
      for (const script of scripts) {
        await db.query(script.sql);
      }
      const quota = process.env.RUN_NATIVE_QUOTA_PLATFORM_CONTENT_TESTS === "1"
        ? new SurrealNativeQuotaClient(db)
        : null;
      let customerUsageBefore: Awaited<ReturnType<SurrealNativeQuotaClient["info"]>>["usage"] | undefined;
      if (quota) {
        await db.query("DEFINE DATABASE IF NOT EXISTS ws_customer;");
        await quota.applyPolicy({
          database: "ws_customer",
          rules: [{ rule_id: "customer_records", resource: "record", selector: { kind: "regex", pattern: ".*" }, limit: { kind: "finite", value: 0 } }],
        });
        await db.use({ namespace, database: "ws_customer" });
        const customerWriteError = await db.query("CREATE customer_probe:blocked CONTENT { value: 1 };")
          .then(() => null, (error: unknown) => error);
        expect(extractNativeQuotaError(customerWriteError)?.code).toBe("quota_exceeded");
        customerUsageBefore = (await quota.info("ws_customer")).usage;
        await db.use({ namespace, database });
      }
      const secret = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      await provisionContentPublisher(db, secret);
      const unqualified = new Surreal();
      await unqualified.connect(process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8999/rpc", { namespace, database });
      try {
        await expect(unqualified.signin({
          namespace, database, access: "content_publisher", variables: { pass: "wrong-password" },
        })).rejects.toThrow();
      } finally {
        await unqualified.close();
      }
      await publisher.connect(process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8999/rpc", { namespace, database });
      const tokens = await publisher.signin({ namespace, database, access: "content_publisher", variables: { pass: secret } });
      await db.query(
        `CREATE content_source:fixture CONTENT {
          source_key: "fixture.synthetic.cn", label: "fixture", status: "active",
          allowed_actions: ["submit", "publish", "withdraw", "restore"], base_url: "https://example.invalid"
        };`,
      );
      const service = new PlatformContentService({
        store: new SurrealPlatformContentStore(publisher),
        sources: [{ sourceKey: "fixture.synthetic.cn", label: "fixture", status: "active", allowedActions: ["submit", "publish", "withdraw", "restore"] }],
      });
      const registered = await service.registerSource(operator, {
        sourceKey: "gov.example.cn",
        label: "公开法规示例",
        jurisdiction: "中国大陆",
        baseUrl: "https://gov.example.cn",
        status: "active",
        allowedActions: ["submit", "publish"],
        license: {
          licenseKind: "public",
          allowedActions: ["submit", "publish"],
          effectiveFrom: "2026-09-01T00:00:00Z",
          effectiveUntil: null,
          evidenceUrl: "https://gov.example.cn/license",
          evidenceText: "公开许可说明",
        },
      });
      expect(registered.license?.revision).toBe(1);
      expect((await new SurrealPlatformContentStore(publisher).listSources()).some((source) => source.sourceKey === "gov.example.cn")).toBe(true);
      const batch = await createSyntheticJudgmentBatch();
      const licensedBatch = {
        ...batch,
        idempotencyKey: "licensed-batch",
        items: [{
          ...batch.items[0]!,
          entryKey: "licensed-entry",
          payload: {
            ...batch.items[0]!.payload,
            source: { ...batch.items[0]!.payload.source, sourceKey: "gov.example.cn", recordKey: "licensed-1" },
          },
        }],
      };
      const licensedSubmitted = await service.submitBatch(operator, licensedBatch);
      const licensedStored = await service.inspectBatch(operator, licensedSubmitted.batchId);
      expect(licensedStored.sourceLicenseSnapshot?.["gov.example.cn"]?.revision).toBe(1);
      const revised = await service.registerSource(operator, {
        sourceKey: "gov.example.cn",
        label: "公开法规示例（修订）",
        jurisdiction: "中国大陆",
        baseUrl: "https://gov.example.cn",
        status: "active",
        allowedActions: ["submit"],
        expectedLicenseRevision: 1,
        license: {
          licenseKind: "public-revised",
          allowedActions: ["submit"],
          effectiveFrom: "2026-10-01T00:00:00Z",
          effectiveUntil: null,
          evidenceUrl: "https://gov.example.cn/license/v2",
          evidenceText: "修订后的公开许可说明",
        },
      });
      expect(revised.license?.revision).toBe(2);
      const historical = await service.inspectBatch(operator, licensedSubmitted.batchId);
      expect(historical.sourceLicenseSnapshot?.["gov.example.cn"]?.revision).toBe(1);
      const law = await createSyntheticLegislationBatch();
      const lawSubmitted = await service.submitBatch(operator, law);
      const lawRequest = {
        batchId: lawSubmitted.batchId,
        validationRevision: 1,
        entryKeys: ["fixture-legislation-1"],
        idempotencyKey: "publication-law-1",
      };
      const [lawPublished, lawReplay] = await Promise.all([
        service.publishBatch(operator, lawRequest),
        service.publishBatch(operator, lawRequest),
      ]);
      expect(lawPublished.status).toBe("completed");
      expect(lawReplay.publicationId).toBe(lawPublished.publicationId);
      expect((await db.query("SELECT id FROM content_version;"))[0]).toHaveLength(1);
      expect((await db.query("SELECT id FROM legal_article_version;"))[0]).toHaveLength(1);
      const submitted = await service.submitBatch(operator, batch);
      const summaries = await service.listBatchSummaries(operator, { limit: 10 });
      expect(summaries.items[0]?.batchId).toBe(submitted.batchId);
      const published = await service.publishBatch(operator, {
        batchId: submitted.batchId,
        validationRevision: 1,
        entryKeys: ["fixture-judgment-1"],
        idempotencyKey: "publication-1",
      });
      expect(published.status).toBe("completed");
      expect((await db.query("SELECT id FROM cites_article;"))[0]).toHaveLength(1);
      expect((await service.searchContent(operator, { limit: 20 })).items).toHaveLength(2);
      const app = new Hono<AppBindings>();
      app.onError(handleError);
      const requireOperator = async (context: { set: (key: "platformOperator", value: typeof operator) => void }, next: () => Promise<void>) => {
        context.set("platformOperator", operator);
        await next();
      };
      app.route("/", createContentRoutes({ service, requireUser: () => requireOperator }));
      app.route("/", createContentMcpRoutes({ service, requireOperator }));
      const uiSearch = await app.request("/api/content/search", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 20 }),
      });
      expect(uiSearch.status).toBe(200);
      expect((await uiSearch.json()).items).toHaveLength(2);
      const uiAudit = await app.request(`/api/content/audit?batchId=${encodeURIComponent(submitted.batchId)}`);
      expect(uiAudit.status).toBe(200);
      expect((await uiAudit.json()).items.length).toBeGreaterThan(0);
      const uiBatches = await app.request("/api/content/batches?limit=10");
      expect(uiBatches.status).toBe(200);
      expect((await uiBatches.json()).items.some((candidate: { batchId: string }) => candidate.batchId === submitted.batchId)).toBe(true);
      const uiDetail = await app.request(`/api/content/batches/${encodeURIComponent(submitted.batchId)}/detail`);
      expect(uiDetail.status).toBe(200);
      expect((await uiDetail.json()).summary.batchId).toBe(submitted.batchId);
      const customerApp = new Hono<AppBindings>();
      customerApp.onError((error, context) => error instanceof HttpError && error.status === 403
        ? context.json({ error: { code: error.code } }, 403)
        : handleError(error, context));
      customerApp.route("/", createContentRoutes({ service, requireUser: () => async (context, next) => {
        context.set("user", { subject: "customer:fixture", email: "customer@example.test", raw: {}, rawToken: "customer-token" });
        await next();
      } }));
      for (const path of [
        `/api/content/batches/${encodeURIComponent(submitted.batchId)}`,
        `/api/content/audit?batchId=${encodeURIComponent(submitted.batchId)}`,
      ]) {
        expect((await customerApp.request(path)).status).toBe(403);
      }
      const unprivilegedOperatorApp = new Hono<AppBindings>();
      unprivilegedOperatorApp.onError((error, context) => error instanceof HttpError && error.status === 403
        ? context.json({ error: { code: error.code } }, 403)
        : handleError(error, context));
      unprivilegedOperatorApp.route("/", createContentRoutes({ service, requireUser: () => async (context, next) => {
        context.set("platformOperator", { subject: "operator:unprivileged", capabilities: [] });
        await next();
      } }));
      expect((await unprivilegedOperatorApp.request(`/api/content/batches/${encodeURIComponent(submitted.batchId)}`)).status).toBe(403);
      expect((await unprivilegedOperatorApp.request("/api/content/audit")).status).toBe(403);
      let rpcId = 0;
      const mcpCall = async (name: string, args: unknown): Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }> => {
        const response = await app.request("/api/ops/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer integration-test" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
        });
        expect(response.status).toBe(200);
        return (await response.json()).result;
      };
      expect((await mcpCall("get_data_contract", {})).isError).not.toBe(true);
      expect((await mcpCall("search_content", { limit: 20 })).structuredContent?.items).toHaveLength(2);
      const mcpBatch = {
        ...batch,
        idempotencyKey: "mcp-real-store",
        items: [{ ...batch.items[0]!, entryKey: "mcp-entry", payload: {
          ...batch.items[0]!.payload,
          source: { ...batch.items[0]!.payload.source, recordKey: "mcp-real-store" },
        } }],
      };
      const mcpSubmitted = await mcpCall("submit_batch", mcpBatch);
      const mcpBatchId = mcpSubmitted.structuredContent?.batchId;
      expect(mcpBatchId).toBeTypeOf("string");
      expect((await mcpCall("inspect_batch", { batchId: mcpBatchId })).structuredContent?.status).toBe("ready");
      expect((await mcpCall("publish_batch", {
        batchId: mcpBatchId, validationRevision: 1, entryKeys: ["mcp-entry"], idempotencyKey: "mcp-real-publication",
      })).structuredContent?.status).toBe("completed");
      expect((await service.searchContent(operator, { limit: 20 })).items).toHaveLength(3);
      const stored = await service.inspectBatch(operator, submitted.batchId);
      expect(stored.status).toBe("published");
      const audit = await service.listAuditEvents(operator, { limit: 20, batchId: submitted.batchId });
      expect(audit.items.some((event) => event.kind === "batch_received")).toBe(true);
      const item = (await new SurrealPlatformContentStore(publisher).searchPublished({ limit: 20 }))
        .find((candidate) => candidate.kind === "judicial_document");
      if (!item) throw new Error("published item missing");
      const withdraw = await mcpCall("submit_batch", {
        ...batch,
        idempotencyKey: "withdraw-1",
        items: [{ entryKey: "withdraw-1", operation: "withdraw", payload: { target: { itemId: item.itemId, expectedVersionId: item.version.versionId, expectedPublicationRevision: item.publicationRevision }, reason: "test", evidenceRefs: [] } }],
      });
      const withdrawBatchId = withdraw.structuredContent?.batchId;
      expect((await mcpCall("inspect_batch", { batchId: withdrawBatchId })).structuredContent?.status).toBe("ready");
      expect((await mcpCall("publish_batch", { batchId: withdrawBatchId, validationRevision: 1, entryKeys: ["withdraw-1"], idempotencyKey: "publication-withdraw-1" })).structuredContent?.status).toBe("completed");
      expect((await service.searchContent(operator, { limit: 20 })).items).toHaveLength(2);
      const restore = await mcpCall("submit_batch", {
        ...batch,
        idempotencyKey: "restore-1",
        items: [{ entryKey: "restore-1", operation: "restore", payload: { target: { itemId: item.itemId, expectedVersionId: item.version.versionId, expectedPublicationRevision: 2 }, reason: "test", evidenceRefs: [] } }],
      });
      const restoreBatchId = restore.structuredContent?.batchId;
      expect((await mcpCall("inspect_batch", { batchId: restoreBatchId })).structuredContent?.status).toBe("ready");
      expect((await mcpCall("publish_batch", { batchId: restoreBatchId, validationRevision: 1, entryKeys: ["restore-1"], idempotencyKey: "publication-restore-1" })).structuredContent?.status).toBe("completed");
      expect((await service.searchContent(operator, { limit: 20 })).items).toHaveLength(3);
      expect(stored.entries[0]?.status).toBe("published");
      const sqlUrl = (process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8999/rpc")
        .replace(/^ws/u, "http").replace(/\/rpc$/u, "/sql");
      async function sqlAsPublisher(sql: string): Promise<{ ok: boolean; body: string }> {
        const response = await fetch(sqlUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${tokens.access}`,
            "surreal-ns": namespace,
            "surreal-db": database,
            accept: "application/json",
            "content-type": "text/plain",
          },
          body: sql,
          signal: AbortSignal.timeout(3000),
        });
        const body = await response.text();
        return { ok: response.ok && !body.includes('"status":"ERR"'), body };
      }
      expect((await sqlAsPublisher("DEFINE TABLE publisher_cannot_ddl;")).ok).toBe(false);
      const before = await db.query("SELECT id, title FROM content_version ORDER BY id;");
      await sqlAsPublisher("UPDATE content_version SET title = 'tampered';");
      const after = await db.query("SELECT id, title FROM content_version ORDER BY id;");
      expect(after).toEqual(before);
      expect((await sqlAsPublisher("SELECT * FROM content_publisher_credential;")).body).not.toContain("secret_hash");
      if (quota) {
        const customerUsage = await quota.info("ws_customer");
        expect(customerUsage.usage).toEqual(customerUsageBefore);
        expect(customerUsage.policy?.rules[0]?.limit).toEqual({ kind: "finite", value: 0 });
      }
    } finally {
      await publisher.close();
      await db.close();
    }
  });

  localTest("round-trips customer license actions through the real store and still rejects unknown verbs", async () => {
    const db = new Surreal();
    const publisher = new Surreal();
    const namespace = `content_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const database = "platform";
    await db.connect(process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8999/rpc", {
      namespace,
      database,
      authentication: { username: "root", password: "root" },
    });
    await db.use({ namespace, database });
    try {
      const scripts = await loadPlatformContentScripts();
      for (const script of scripts) await db.query(script.sql);
      const secret = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      await provisionContentPublisher(db, secret);
      await publisher.connect(process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8999/rpc", { namespace, database });
      await publisher.signin({ namespace, database, access: "content_publisher", variables: { pass: secret } });
      const service = new PlatformContentService({ store: new SurrealPlatformContentStore(publisher), sources: [] });
      const actions = ["submit", "publish", "browse", "search", "read", "cite", "export", "research", "generate"];
      const registered = await service.registerSource(operator, {
        sourceKey: "flk.example.cn",
        label: "官方法规发布",
        jurisdiction: "中国大陆",
        baseUrl: "https://flk.example.cn",
        status: "active",
        allowedActions: actions,
        license: {
          licenseKind: "official-legislative-document-publication",
          allowedActions: actions,
          effectiveFrom: "2026-09-01T00:00:00Z",
          effectiveUntil: null,
          evidenceUrl: "https://flk.example.cn/license",
          evidenceText: "法定排除依据说明",
        },
      });
      expect(registered.license?.allowedActions).toEqual(actions);
      const readBack = (await new SurrealPlatformContentStore(publisher).listSources())
        .find((item) => item.sourceKey === "flk.example.cn");
      expect(readBack?.allowedActions).toEqual(actions);
      expect(readBack?.license?.allowedActions).toEqual(actions);
      const raw = await db.query("SELECT allowed_actions FROM source_license_revision WHERE source.source_key = 'flk.example.cn';");
      expect(JSON.stringify(raw)).toContain('"read"');
      await expect(service.registerSource(operator, {
        sourceKey: "invalid.example.cn",
        label: "非法动作",
        baseUrl: "https://invalid.example.cn",
        status: "active",
        allowedActions: ["submit", "delete"],
        license: {
          licenseKind: "public",
          allowedActions: ["submit", "delete"],
          effectiveFrom: "2026-09-01T00:00:00Z",
          effectiveUntil: null,
        },
      })).rejects.toMatchObject({ code: "invalid_request" });
    } finally {
      await publisher.close();
      await db.close();
    }
  });

  localTest("publish writes one collection binding visible to the reader gate", async () => {
    const db = new Surreal();
    const publisher = new Surreal();
    const projection = new Surreal();
    const namespace = `content_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const database = "platform";
    const url = process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8999/rpc";
    await db.connect(url, { namespace, database, authentication: { username: "root", password: "root" } });
    await db.use({ namespace, database });
    try {
      for (const script of await loadPlatformContentScripts()) await db.query(script.sql);
      const secret = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      await provisionContentPublisher(db, secret);
      const projectionPass = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      await db.query(`
        INSERT INTO content_projection_identity { id: content_projection_identity:server, active: true }
          ON DUPLICATE KEY UPDATE active = true;
        INSERT INTO content_projection_credential { id: content_projection_credential:server, secret_hash: crypto::argon2::generate($pass) }
          ON DUPLICATE KEY UPDATE secret_hash = crypto::argon2::generate($pass);
      `, { pass: projectionPass });
      await publisher.connect(url, { namespace, database });
      await publisher.signin({ namespace, database, access: "content_publisher", variables: { pass: secret } });
      await projection.connect(url, { namespace, database });
      await projection.signin({ namespace, database, access: "content_projection_sync", variables: { pass: projectionPass } });
      const service = new PlatformContentService({
        store: new SurrealPlatformContentStore(publisher),
        sources: [],
        activeCollectionKeys: async () => ["statutes", "cases"],
      });
      await service.registerSource(operator, {
        sourceKey: "fixture.synthetic.cn",
        label: "合成来源",
        baseUrl: "https://example.invalid",
        status: "active",
        allowedActions: ["submit", "publish", "browse", "search", "read", "cite", "export"],
        license: {
          licenseKind: "synthetic",
          allowedActions: ["submit", "publish", "browse", "search", "read", "cite", "export"],
          effectiveFrom: "2026-09-01T00:00:00Z",
          effectiveUntil: null,
          evidenceText: "合成许可",
        },
      });
      const law = await createSyntheticLegislationBatch();
      const bound = structuredClone(law);
      bound.idempotencyKey = "binding-batch";
      bound.items[0]!.payload.collections = ["statutes"];
      const submitted = await service.submitBatch(operator, bound);
      expect(submitted.entries[0]?.status).toBe("accepted");
      const published = await service.publishBatch(operator, {
        batchId: submitted.batchId,
        validationRevision: 1,
        entryKeys: ["fixture-legislation-1"],
        idempotencyKey: "binding-publication",
      });
      expect(published.entries[0]?.status).toBe("published");
      const versionId = published.entries[0]?.versionId;
      expect(versionId).toBeTruthy();
      const target = await fetchContentReaderTarget(projection, versionId!);
      expect(target?.collectionKeys).toEqual(["statutes"]);
      const nowSeconds = Math.floor(Date.now() / 1000);
      const allowed = planContentReaderExchange({
        body: { contentPublicId: versionId },
        subject: "human",
        workspaceDb: "ws_alpha",
        workspaceActive: true,
        membership: "active",
        activeSubjects: ["human"],
        subjectExpiresAtSeconds: nowSeconds + 3600,
        nowSeconds,
        subjectIsContentReader: false,
        database,
        namespace,
        entitlement: {
          revision: 1,
          digest: "sha256:abc",
          resolverVersion: "product-entitlement-v1",
          effectiveUntilSeconds: null,
          collections: ["statutes"],
          contentActions: ["browse", "read"],
          aiActions: [],
        },
        content: target,
      });
      expect(allowed.ok).toBe(true);

      const republish = structuredClone(bound);
      republish.idempotencyKey = "binding-batch-again";
      republish.items[0]!.payload.collections = ["statutes", "cases"];
      const resubmitted = await service.submitBatch(operator, republish);
      const republished = await service.publishBatch(operator, {
        batchId: resubmitted.batchId,
        validationRevision: 1,
        entryKeys: ["fixture-legislation-1"],
        idempotencyKey: "binding-publication-again",
      });
      expect(republished.entries[0]?.status).toBe("unchanged");
      const bindings = (await db.query("SELECT collections FROM content_collection_binding;"))[0] as { collections: string[] }[];
      expect(bindings).toHaveLength(1);
      expect(bindings[0]?.collections).toEqual(["statutes", "cases"]);
      const again = await fetchContentReaderTarget(projection, versionId!);
      expect(again?.collectionKeys).toEqual(["statutes", "cases"]);
      const events = (await db.query("SELECT event_kind, reason, occurred_at FROM publication_event ORDER BY occurred_at;"))[0] as { event_kind: string; reason: string | null }[];
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ event_kind: "corrected", reason: "content collections updated" });

      await db.query(`DEFINE EVENT reject_binding_audit ON publication_event
        WHEN $event = "CREATE" AND $after.reason = "content collections updated"
        THEN { THROW "audit-unavailable"; };`);
      const failedBatch = structuredClone(bound);
      failedBatch.idempotencyKey = "binding-batch-audit-failure";
      failedBatch.items[0]!.payload.collections = ["cases"];
      const failedSubmitted = await service.submitBatch(operator, failedBatch);
      const failedPublication = await service.publishBatch(operator, {
        batchId: failedSubmitted.batchId,
        validationRevision: 1,
        entryKeys: ["fixture-legislation-1"],
        idempotencyKey: "binding-publication-audit-failure",
      });
      expect(failedPublication.entries[0]?.status).toBe("failed");
      expect((await fetchContentReaderTarget(projection, versionId!))?.collectionKeys).toEqual(["statutes", "cases"]);
      expect((await db.query("SELECT * FROM publication_event;"))[0]).toHaveLength(2);
      await db.query("REMOVE EVENT reject_binding_audit ON publication_event;");

      const plain = structuredClone(law);
      plain.idempotencyKey = "unbound-batch";
      plain.items[0]!.entryKey = "fixture-legislation-2";
      plain.items[0]!.payload.source.recordKey = "law-2";
      const plainSubmitted = await service.submitBatch(operator, plain);
      const plainPublished = await service.publishBatch(operator, {
        batchId: plainSubmitted.batchId,
        validationRevision: 1,
        entryKeys: ["fixture-legislation-2"],
        idempotencyKey: "unbound-publication",
      });
      expect(plainPublished.entries[0]?.status).toBe("published");
      expect((await db.query("SELECT collections FROM content_collection_binding;"))[0]).toHaveLength(1);
      const unbound = await fetchContentReaderTarget(projection, plainPublished.entries[0]!.versionId!);
      expect(unbound?.collectionKeys).toEqual([]);
      const deniedInput = {
        body: { contentPublicId: plainPublished.entries[0]!.versionId },
        subject: "human",
        workspaceDb: "ws_alpha",
        workspaceActive: true,
        membership: "active",
        activeSubjects: ["human"],
        subjectExpiresAtSeconds: nowSeconds + 3600,
        nowSeconds,
        subjectIsContentReader: false,
        database,
        namespace,
        entitlement: {
          revision: 1,
          digest: "sha256:abc",
          resolverVersion: "product-entitlement-v1",
          effectiveUntilSeconds: null,
          collections: ["statutes"],
          contentActions: ["browse", "read"],
          aiActions: [],
        },
        content: unbound,
      } as const;
      const denied = planContentReaderExchange(deniedInput);
      expect(denied).toEqual({ ok: false, error: "collection_denied" });

      const empty = structuredClone(law);
      empty.idempotencyKey = "empty-collections-batch";
      empty.items[0]!.entryKey = "fixture-legislation-empty";
      empty.items[0]!.payload.source.recordKey = "law-empty";
      empty.items[0]!.payload.collections = [];
      const emptySubmitted = await service.submitBatch(operator, empty);
      expect(emptySubmitted.entries[0]?.status).toBe("accepted");
      const emptyPublished = await service.publishBatch(operator, {
        batchId: emptySubmitted.batchId,
        validationRevision: 1,
        entryKeys: ["fixture-legislation-empty"],
        idempotencyKey: "empty-collections-publication",
      });
      expect(emptyPublished.entries[0]?.status).toBe("published");
      expect((await db.query("SELECT collections FROM content_collection_binding;"))[0]).toHaveLength(1);
      const emptyTarget = await fetchContentReaderTarget(projection, emptyPublished.entries[0]!.versionId!);
      expect(emptyTarget?.collectionKeys).toEqual([]);
      expect(planContentReaderExchange({
        ...deniedInput,
        body: { contentPublicId: emptyPublished.entries[0]!.versionId },
        content: emptyTarget,
      })).toEqual({ ok: false, error: "collection_denied" });

      const unknown = structuredClone(law);
      unknown.idempotencyKey = "unknown-collection";
      unknown.items[0]!.entryKey = "fixture-legislation-3";
      unknown.items[0]!.payload.source.recordKey = "law-3";
      unknown.items[0]!.payload.collections = ["not_listed"];
      const rejected = await service.submitBatch(operator, unknown);
      expect(rejected.entries[0]).toMatchObject({ status: "rejected" });
      expect((await db.query("SELECT collections FROM content_collection_binding;"))[0]).toHaveLength(1);
    } finally {
      await projection.close();
      await publisher.close();
      await db.close();
    }
  });
});
