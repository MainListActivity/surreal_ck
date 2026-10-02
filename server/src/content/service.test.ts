import { describe, expect, test } from "bun:test";
import { createSyntheticJudgmentBatch } from "@surreal-ck/shared/platform-content";
import { ContentServiceError, InMemoryPlatformContentStore, PlatformContentService, searchQueryCandidates } from "./service";

const operator = { subject: "operator:ada", capabilities: ["content.submit", "content.read", "content.publish", "content.withdraw", "content.restore", "content.source.manage"] } as const;
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
    const naturalLanguageSearch = await service.searchPublishedForOperator(operator, {
      query: "请查找合同法第四百条相关的最高人民法院案例，并给出官方来源链接",
      limit: 5,
    });
    expect(naturalLanguageSearch.items).toHaveLength(1);

    const nounPhraseSearch = await service.searchPublishedForOperator(operator, {
      query: "查找委托事务案例",
      limit: 5,
    });
    expect(nounPhraseSearch.items).toHaveLength(1);
    expect(nounPhraseSearch.items[0]?.bodyText).toContain("委托事务");
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

  test("versions source licences and paginates batch and audit views", async () => {
    const store = new InMemoryPlatformContentStore();
    const service = new PlatformContentService({ store, sources: [source] });
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
    expect((await service.getDataContract(operator)).sources.some((item) => item.sourceKey === "gov.example.cn")).toBe(true);

    const batch = await createSyntheticJudgmentBatch();
    const large = {
      ...batch,
      idempotencyKey: "pagination-batch",
      items: Array.from({ length: 3 }, (_, index) => ({
        ...batch.items[0]!,
        entryKey: `entry-${index + 1}`,
        payload: {
          ...batch.items[0]!.payload,
          source: { ...batch.items[0]!.payload.source, recordKey: null },
        },
      })),
    };
    const submitted = await service.submitBatch(operator, large);
    const firstPage = await service.inspectBatchResponse(operator, { batchId: submitted.batchId, limit: 2 });
    expect(firstPage.entries).toHaveLength(2);
    expect(firstPage.nextCursor).toBeTypeOf("string");
    const secondPage = await service.inspectBatchResponse(operator, { batchId: submitted.batchId, cursor: firstPage.nextCursor, limit: 2 });
    expect(secondPage.entries).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();

    const summaries = await service.listBatchSummaries(operator, { limit: 1 });
    expect(summaries.items[0]?.batchId).toBe(submitted.batchId);
    expect(summaries.items[0]?.entryCount).toBe(3);
    const audit = await service.listAuditEvents(operator, { limit: 10 });
    expect(audit.items.some((item) => item.kind === "batch_received" && item.batchId === submitted.batchId)).toBe(true);
    expect(audit.items.some((item) => item.kind === "source_registered")).toBe(true);
  });

  test("paginates source discovery in the data contract", async () => {
    const sources = Array.from({ length: 101 }, (_, index) => ({
      sourceKey: `source-${index.toString().padStart(3, "0")}`,
      label: `来源 ${index}`,
      status: "active" as const,
      allowedActions: ["submit"] as const,
    }));
    const service = new PlatformContentService({ store: new InMemoryPlatformContentStore(), sources });
    const first = await service.getDataContract(operator);
    expect(first.sources).toHaveLength(100);
    expect(first.sourceNextCursor).toBeTypeOf("string");
    const second = await service.getDataContract(operator, { sourceCursor: first.sourceNextCursor });
    expect(second.sources).toHaveLength(1);
    expect(second.sourceNextCursor).toBeNull();
  });

  test("registers customer actions in the license vocabulary and rejects unknown verbs", async () => {
    const store = new InMemoryPlatformContentStore();
    const service = new PlatformContentService({ store, sources: [source] });
    const customerActions = ["submit", "publish", "browse", "search", "read", "cite", "export", "research", "generate"] as const;
    const registered = await service.registerSource(operator, {
      sourceKey: "flk.example.cn",
      label: "官方法规发布",
      jurisdiction: "中国大陆",
      baseUrl: "https://flk.example.cn",
      status: "active",
      allowedActions: [...customerActions],
      license: {
        licenseKind: "official-legislative-document-publication",
        allowedActions: [...customerActions],
        effectiveFrom: "2026-09-01T00:00:00Z",
        effectiveUntil: null,
        evidenceUrl: "https://flk.example.cn/license",
        evidenceText: "法定排除依据说明",
      },
    });
    expect(registered.allowedActions).toEqual([...customerActions]);
    expect(registered.license?.allowedActions).toEqual([...customerActions]);
    const listed = await service.listSources(operator);
    const readBack = listed.find((item) => item.sourceKey === "flk.example.cn");
    expect(readBack?.allowedActions).toEqual([...customerActions]);
    expect(readBack?.license?.allowedActions).toEqual([...customerActions]);
    expect((await service.getDataContract(operator)).sources.find((item) => item.sourceKey === "flk.example.cn")?.allowedActions)
      .toEqual([...customerActions]);

    const licenseActions = [...customerActions, "withdraw", "restore"];
    const widened = await service.registerSource(operator, {
      sourceKey: "flk.example.cn",
      label: "官方法规发布",
      jurisdiction: "中国大陆",
      baseUrl: "https://flk.example.cn",
      status: "active",
      allowedActions: licenseActions,
      license: {
        licenseKind: "official-legislative-document-publication",
        allowedActions: licenseActions,
        effectiveFrom: "2026-09-02T00:00:00Z",
        effectiveUntil: null,
        evidenceUrl: "https://flk.example.cn/license",
        evidenceText: "更新许可说明",
      },
      expectedLicenseRevision: 1,
    });
    expect(widened.license?.revision).toBe(2);
    expect(widened.license?.allowedActions).toEqual(licenseActions);

    await expect(service.registerSource(operator, {
      sourceKey: "evil.example.cn",
      label: "非法动作",
      baseUrl: "https://evil.example.cn",
      status: "active",
      allowedActions: ["submit", "delete"],
      license: {
        licenseKind: "public",
        allowedActions: ["submit", "delete"],
        effectiveFrom: "2026-09-01T00:00:00Z",
        effectiveUntil: null,
      },
    })).rejects.toMatchObject<ContentServiceError>({ code: "invalid_request" });
  });

  test("writes one collection binding on publish and rejects illegal or unknown keys", async () => {
    const store = new InMemoryPlatformContentStore();
    const service = new PlatformContentService({
      store,
      sources: [source],
      activeCollectionKeys: async () => ["statutes", "cases"],
    });
    const batch = await createSyntheticJudgmentBatch();
    const withCollections = (idempotencyKey: string, collections?: string[]) => {
      const next = structuredClone(batch);
      next.idempotencyKey = idempotencyKey;
      if (collections) next.items[0]!.payload.collections = collections;
      return next;
    };

    await expect(service.submitBatch(operator, withCollections("bad-key", ["NotAKey"])))
      .rejects.toMatchObject<ContentServiceError>({ code: "invalid_request" });
    const unknown = await service.submitBatch(operator, withCollections("unknown-key", ["not_listed"]));
    expect(unknown.entries[0]).toMatchObject({ status: "rejected" });
    expect(unknown.entries[0]?.issues[0]).toMatchObject({ code: "invalid_request", fieldPath: "payload.collections" });

    const unbound = await service.submitBatch(operator, withCollections("no-collections"));
    const unboundPublication = await service.publishBatch(operator, {
      batchId: unbound.batchId,
      validationRevision: 1,
      entryKeys: ["fixture-judgment-1"],
      idempotencyKey: "publication-unbound",
    });
    expect(unboundPublication.entries[0]?.status).toBe("published");
    const unboundItemId = (await service.searchContent(operator, { limit: 20 })).items[0]?.itemId;
    expect(unboundItemId).toBeTruthy();
    expect(store.collectionBinding(unboundItemId!)).toBeNull();

    const boundBatch = withCollections("with-collections", ["statutes"]);
    boundBatch.items[0]!.payload.source.recordKey = "bound-1";
    const bound = await service.submitBatch(operator, boundBatch);
    expect(bound.entries[0]?.status).toBe("accepted");
    const published = await service.publishBatch(operator, {
      batchId: bound.batchId,
      validationRevision: 1,
      entryKeys: ["fixture-judgment-1"],
      idempotencyKey: "publication-bound",
    });
    expect(published.entries[0]?.status).toBe("published");
    const boundItemId = (await service.searchContent(operator, { limit: 20 })).items
      .find((item) => item.version.sourceKey === source.sourceKey && item.itemId !== unboundItemId)?.itemId;
    expect(store.collectionBinding(boundItemId!)).toEqual(["statutes"]);

    const again = withCollections("with-collections-again", ["statutes", "cases"]);
    again.items[0]!.payload.source.recordKey = "bound-1";
    const resubmitted = await service.submitBatch(operator, again);
    const republished = await service.publishBatch(operator, {
      batchId: resubmitted.batchId,
      validationRevision: 1,
      entryKeys: ["fixture-judgment-1"],
      idempotencyKey: "publication-bound-again",
    });
    expect(republished.entries[0]?.status).toBe("unchanged");
    expect(store.collectionBinding(boundItemId!)).toEqual(["statutes", "cases"]);
    expect((await service.searchContent(operator, { limit: 20 })).items).toHaveLength(2);
  });

  test("searchQueryCandidates 从自然语言问句抽出可检索短语（通用，无领域词表）", () => {
    expect(searchQueryCandidates("查找合同解除案例")).toContain("合同解除案例");
    expect(searchQueryCandidates("帮我查一下最高法关于专利侵权许诺销售的指导案例和适用法条")).toEqual(
      expect.arrayContaining(["最高法", "专利侵权许诺销售", "指导案例"]),
    );
    expect(searchQueryCandidates("查找（2023）最高法知民终113号并给出官方来源链接")).toEqual([
      "查找（2023）最高法知民终113号并给出官方来源链接",
      "（2023）最高法知民终113号",
    ]);
    // 通用域样例：非法律问句同样按请求噪声/连接词结构拆分。
    expect(searchQueryCandidates("帮我查一下泵房设备的本月巡检记录")).toEqual(
      expect.arrayContaining(["泵房设备", "本月巡检记录"]),
    );
  });
});
