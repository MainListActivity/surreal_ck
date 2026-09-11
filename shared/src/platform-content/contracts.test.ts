import { describe, expect, test } from "bun:test";
import {
  GetDataContractResponseSchema,
  IngestionBatchSchema,
  InspectBatchRequestSchema,
  PublishBatchRequestSchema,
  SearchContentRequestSchema,
  SubmitBatchResponseSchema,
  WithdrawContentPayloadSchema,
} from ".";
import { createSyntheticJudgmentBatch } from "./fixtures";
import { validatePlatformContentBatch, validateCitationLocator, utf8ByteLength } from "./validation";

describe("platform content contract v1", () => {
  test("accepts a complete synthetic judicial document with UTF-8 citation location", async () => {
    const batch = await createSyntheticJudgmentBatch();
    expect(IngestionBatchSchema.safeParse(batch).success).toBe(true);
    const result = await validatePlatformContentBatch(batch);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("fixture should validate");
    expect(result.bodyDigests["fixture-judgment-1"]).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("rejects unknown operations and self-reported actors", async () => {
    const batch = await createSyntheticJudgmentBatch();
    const unknownOperation = structuredClone(batch) as Record<string, unknown>;
    const items = (unknownOperation.items as Array<Record<string, unknown>>);
    items[0] = { ...items[0], operation: "delete" };
    const invalid = await validatePlatformContentBatch(unknownOperation);
    expect(invalid).toMatchObject({ ok: false, code: "invalid_request" });

    const forged = { ...batch, actor: { subject: "attacker" } };
    const forgedResult = await validatePlatformContentBatch(forged);
    expect(forgedResult).toMatchObject({ ok: false, code: "forged_actor" });
  });

  test("distinguishes body/evidence/request limits", async () => {
    const batch = await createSyntheticJudgmentBatch();
    const bodyTooLarge = structuredClone(batch);
    bodyTooLarge.items[0].payload.document.bodyText = "界".repeat(8);
    const bodyResult = await validatePlatformContentBatch(bodyTooLarge, { maxBodyTextBytes: 4 });
    expect(bodyResult).toMatchObject({ ok: false, code: "payload_too_large" });

    const evidenceTooLarge = structuredClone(batch);
    evidenceTooLarge.items[0].payload.document.evidence[0].text = "证".repeat(8);
    const evidenceResult = await validatePlatformContentBatch(evidenceTooLarge, { maxEvidenceTextBytes: 4 });
    expect(evidenceResult).toMatchObject({ ok: false, code: "payload_too_large" });

    const requestResult = await validatePlatformContentBatch(batch, { maxRequestBytes: 32 });
    expect(requestResult).toMatchObject({ ok: false, code: "payload_too_large" });
  });

  test("rejects stale or split UTF-8 locators and accepts exact repeated-text positions", async () => {
    const batch = await createSyntheticJudgmentBatch();
    const entry = batch.items[0];
    if (entry.operation !== "upsert") throw new Error("fixture operation changed");
    const citation = entry.payload.judgment.citations[0];
    expect(await validateCitationLocator(entry.payload.document.bodyText, citation)).toBeNull();

    const split = { ...citation, locator: { ...citation.locator, start: citation.locator.start + 1 } };
    expect((await validateCitationLocator(entry.payload.document.bodyText, split))?.code).toBe("locator_mismatch");

    const repeatedBody = "相同引文。相同引文。";
    const repeated = "相同引文";
    const firstStart = utf8ByteLength("");
    const secondStart = utf8ByteLength("相同引文。");
    const digest = await (await import("./validation")).sha256Hex(repeatedBody);
    expect(
      await validateCitationLocator(repeatedBody, {
        quotedText: repeated,
        locator: { start: firstStart, end: firstStart + utf8ByteLength(repeated), bodyDigest: digest },
      }),
    ).toBeNull();
    expect(
      await validateCitationLocator(repeatedBody, {
        quotedText: repeated,
        locator: { start: secondStart, end: secondStart + utf8ByteLength(repeated), bodyDigest: digest },
      }),
    ).toBeNull();
  });

  test("withdraw and restore carry no document and require a target", () => {
    expect(
      WithdrawContentPayloadSchema.safeParse({
        target: { itemId: "item-1", expectedVersionId: "version-1", expectedPublicationRevision: 2 },
        reason: "来源许可撤回",
        evidenceRefs: ["evidence-1"],
      }).success,
    ).toBe(true);
    expect(
      WithdrawContentPayloadSchema.safeParse({ reason: "missing target", evidenceRefs: [] }).success,
    ).toBe(false);
  });

  test("parses the five tool envelopes with stable pagination fields", () => {
    expect(SearchContentRequestSchema.parse({ limit: 10, cursor: null }).limit).toBe(10);
    expect(InspectBatchRequestSchema.parse({ batchId: "batch-1", limit: 10 }).limit).toBe(10);
    expect(PublishBatchRequestSchema.parse({ batchId: "batch-1", validationRevision: 1, entryKeys: ["entry-1"], idempotencyKey: "pub-1" }).batchId).toBe("batch-1");
    expect(
      SubmitBatchResponseSchema.parse({
        batchId: "batch-1",
        receivedAt: "2026-09-01T12:00:00Z",
        status: "received",
        entries: [{ entryKey: "entry-1", status: "accepted", issues: [] }],
      }).status,
    ).toBe("received");
    expect(
      GetDataContractResponseSchema.parse({
        contractVersion: "1",
        operations: ["get_data_contract", "search_content", "submit_batch", "inspect_batch", "publish_batch"],
        limits: { maxBatchItems: 50, maxRequestBytes: 5242880, maxBodyTextBytes: 2097152, maxEvidenceTextBytes: 524288 },
        errorCodes: ["invalid_request"],
        sources: [],
        sourceNextCursor: null,
        examples: ["submit_batch"],
      }).contractVersion,
    ).toBe("1");
  });
});
