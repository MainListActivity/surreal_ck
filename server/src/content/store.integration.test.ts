import { describe, expect, test } from "bun:test";
import { Surreal } from "surrealdb";
import { createSyntheticJudgmentBatch } from "@surreal-ck/shared/platform-content";
import { loadPlatformContentScripts } from "@surreal-ck/shared/platform-content-schema";
import { PlatformContentService } from "./service";
import { SurrealPlatformContentStore } from "./store";

const localTest = test.skipIf(process.env.RUN_LOCAL_PLATFORM_CONTENT_TESTS !== "1");

const operator = {
  subject: "operator:local",
  capabilities: ["content.submit", "content.read", "content.publish", "content.withdraw", "content.restore", "content.source.manage"],
} as const;

describe("Surreal platform content store", () => {
  localTest("persists a batch and publishes, withdraws, then restores one item", async () => {
    const db = new Surreal();
    const namespace = `content_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const database = "platform";
    await db.connect(process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8999/rpc", {
      namespace,
      database,
    });
    await db.use({ namespace, database });
    try {
      const scripts = await loadPlatformContentScripts();
      if (scripts.length === 0) throw new Error("platform schema missing");
      for (const script of scripts) await db.query(script.sql);
      await db.query(
        `CREATE content_source:fixture CONTENT {
          source_key: "fixture.synthetic.cn", label: "fixture", status: "active",
          allowed_actions: ["submit", "publish", "withdraw", "restore"], base_url: "https://example.invalid"
        };`,
      );
      const service = new PlatformContentService({
        store: new SurrealPlatformContentStore(db),
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
      expect((await new SurrealPlatformContentStore(db).listSources()).some((source) => source.sourceKey === "gov.example.cn")).toBe(true);
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
      expect((await service.searchContent(operator, { limit: 20 })).items).toHaveLength(1);
      const stored = await service.inspectBatch(operator, submitted.batchId);
      expect(stored.status).toBe("published");
      const audit = await service.listAuditEvents(operator, { limit: 20, batchId: submitted.batchId });
      expect(audit.items.some((event) => event.kind === "batch_received")).toBe(true);
      const item = (await new SurrealPlatformContentStore(db).searchPublished({ limit: 20 }))[0];
      if (!item) throw new Error("published item missing");
      const withdraw = await service.submitBatch(operator, {
        ...batch,
        idempotencyKey: "withdraw-1",
        items: [{ entryKey: "withdraw-1", operation: "withdraw", payload: { target: { itemId: item.itemId, expectedVersionId: item.version.versionId, expectedPublicationRevision: item.publicationRevision }, reason: "test", evidenceRefs: [] } }],
      });
      const withdrawn = await service.publishBatch(operator, { batchId: withdraw.batchId, validationRevision: 1, entryKeys: ["withdraw-1"], idempotencyKey: "publication-withdraw-1" });
      expect(withdrawn.status).toBe("completed");
      expect((await service.searchContent(operator, { limit: 20 })).items).toHaveLength(0);
      const restore = await service.submitBatch(operator, {
        ...batch,
        idempotencyKey: "restore-1",
        items: [{ entryKey: "restore-1", operation: "restore", payload: { target: { itemId: item.itemId, expectedVersionId: item.version.versionId, expectedPublicationRevision: 2 }, reason: "test", evidenceRefs: [] } }],
      });
      const restored = await service.publishBatch(operator, { batchId: restore.batchId, validationRevision: 1, entryKeys: ["restore-1"], idempotencyKey: "publication-restore-1" });
      expect(restored.status).toBe("completed");
      expect((await service.searchContent(operator, { limit: 20 })).items).toHaveLength(1);
      expect(stored.entries[0]?.status).toBe("published");
    } finally {
      await db.close();
    }
  });
});
