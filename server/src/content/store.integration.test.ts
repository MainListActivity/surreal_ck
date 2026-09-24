import { describe, expect, test } from "bun:test";
import { Surreal } from "surrealdb";
import { createSyntheticJudgmentBatch, createSyntheticLegislationBatch } from "@surreal-ck/shared/platform-content";
import { loadPlatformContentScripts } from "@surreal-ck/shared/platform-content-schema";
import { PlatformContentService } from "./service";
import { SurrealPlatformContentStore } from "./store";
import { provisionContentPublisher } from "./publisher-session";
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
});
