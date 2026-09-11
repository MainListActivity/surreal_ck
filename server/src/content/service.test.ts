import { describe, expect, test } from "bun:test";
import { createSyntheticJudgmentBatch } from "@surreal-ck/shared/platform-content";
import { ContentServiceError, InMemoryPlatformContentStore, PlatformContentService } from "./service";

const operator = { subject: "operator:ada", capabilities: ["content.submit", "content.read", "content.publish", "content.withdraw", "content.restore"] } as const;
const source = {
  sourceKey: "fixture.synthetic.cn",
  label: "合成测试来源",
  status: "active" as const,
  allowedActions: ["submit", "publish", "withdraw", "restore"] as const,
};

describe("platform content ingestion service", () => {
  test("is idempotent for same actor/key and rejects conflicting payloads", async () => {
    const store = new InMemoryPlatformContentStore();
    const service = new PlatformContentService({ store, sources: [source], idFactory: (prefix) => `${prefix}_one` });
    const batch = await createSyntheticJudgmentBatch();
    const first = await service.submitBatch(operator, batch);
    const replay = await service.submitBatch(operator, batch);
    expect(replay).toEqual(first);

    const conflict = structuredClone(batch);
    conflict.items[0].payload.document.title = "不同正文意图";
    await expect(service.submitBatch(operator, conflict)).rejects.toMatchObject<ContentServiceError>({
      code: "idempotency_conflict",
    });
  });

  test("keeps unregistered source as an independent rejected entry", async () => {
    const store = new InMemoryPlatformContentStore();
    const service = new PlatformContentService({ store, sources: [] });
    const batch = await createSyntheticJudgmentBatch();
    const response = await service.submitBatch(operator, batch);
    expect(response.status).toBe("rejected");
    expect(response.entries[0]).toMatchObject({ status: "rejected" });
    expect(response.entries[0]?.issues[0]?.code).toBe("source_not_registered");
  });

  test("does not accept a client supplied actor", async () => {
    const store = new InMemoryPlatformContentStore();
    const service = new PlatformContentService({ store, sources: [source] });
    const batch = await createSyntheticJudgmentBatch();
    const forged = { ...batch, actor: "attacker" };
    await expect(service.submitBatch(operator, forged)).rejects.toMatchObject<ContentServiceError>({ code: "invalid_request" });
  });

  test("publishes selected entries, supports replay, and exposes only published content by default", async () => {
    const store = new InMemoryPlatformContentStore();
    const service = new PlatformContentService({ store, sources: [source], idFactory: (prefix) => `${prefix}_stable` });
    const batch = await createSyntheticJudgmentBatch();
    const submitted = await service.submitBatch(operator, batch);
    const publication = await service.publishBatch(operator, {
      batchId: submitted.batchId,
      validationRevision: 1,
      entryKeys: ["fixture-judgment-1"],
      idempotencyKey: "publication-1",
    });
    expect(publication.status).toBe("completed");
    expect(publication.entries[0]).toMatchObject({ status: "published" });
    expect(await service.publishBatch(operator, {
      batchId: submitted.batchId,
      validationRevision: 1,
      entryKeys: ["fixture-judgment-1"],
      idempotencyKey: "publication-1",
    })).toEqual(publication);
    const search = await service.searchContent(operator, { limit: 20 });
    expect(search.items).toHaveLength(1);
    expect(search.items[0]?.bodyText).toContain("合成全文");
  });

  test("detects stale publication assumptions and allows correction, withdraw, and restore", async () => {
    const store = new InMemoryPlatformContentStore();
    const service = new PlatformContentService({ store, sources: [source] });
    const firstBatch = await createSyntheticJudgmentBatch();
    const submitted = await service.submitBatch(operator, firstBatch);
    await service.publishBatch(operator, {
      batchId: submitted.batchId,
      validationRevision: 1,
      entryKeys: ["fixture-judgment-1"],
      idempotencyKey: "publication-first",
    });
    const published = (await store.searchPublished({ limit: 20 }))[0];
    if (!published) throw new Error("published fixture missing");

    const staleBatch = await service.submitBatch(operator, {
      ...firstBatch,
      idempotencyKey: "withdraw-stale",
      items: [{
        entryKey: "withdraw-stale",
        operation: "withdraw",
        payload: { target: { itemId: published.itemId, expectedVersionId: published.version.versionId, expectedPublicationRevision: 0 }, reason: "测试撤回", evidenceRefs: [] },
      }],
    });
    const stale = await service.publishBatch(operator, {
      batchId: staleBatch.batchId,
      validationRevision: 1,
      entryKeys: ["withdraw-stale"],
      idempotencyKey: "publication-stale",
    });
    expect(stale.status).toBe("failed");
    expect(stale.entries[0]?.issues[0]?.code).toBe("stale_version");

    const withdrawBatch = await service.submitBatch(operator, {
      ...firstBatch,
      idempotencyKey: "withdraw-current",
      items: [{
        entryKey: "withdraw-current",
        operation: "withdraw",
        payload: { target: { itemId: published.itemId, expectedVersionId: published.version.versionId, expectedPublicationRevision: 1 }, reason: "测试撤回", evidenceRefs: [] },
      }],
    });
    const withdrawn = await service.publishBatch(operator, {
      batchId: withdrawBatch.batchId,
      validationRevision: 1,
      entryKeys: ["withdraw-current"],
      idempotencyKey: "publication-withdraw",
    });
    expect(withdrawn.entries[0]?.status).toBe("published");
    expect((await service.searchContent(operator, { limit: 20 })).items).toHaveLength(0);

    const restoreBatch = await service.submitBatch(operator, {
      ...firstBatch,
      idempotencyKey: "restore-current",
      items: [{
        entryKey: "restore-current",
        operation: "restore",
        payload: { target: { itemId: published.itemId, expectedVersionId: published.version.versionId, expectedPublicationRevision: 2 }, reason: "来源恢复", evidenceRefs: [] },
      }],
    });
    await service.publishBatch(operator, {
      batchId: restoreBatch.batchId,
      validationRevision: 1,
      entryKeys: ["restore-current"],
      idempotencyKey: "publication-restore",
    });
    expect((await service.searchContent(operator, { limit: 20 })).items).toHaveLength(1);
  });
});
