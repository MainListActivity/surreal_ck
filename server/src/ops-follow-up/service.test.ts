import { describe, expect, test } from "bun:test";
import type {
  ActivationSummaryV2,
  FollowUpItem,
  SharedActivationSummary,
} from "@surreal-ck/shared";
import {
  OpsFollowUpService,
  OpsFollowUpServiceError,
  type FollowUpCursor,
  type OpsFollowUpStore,
} from "./service";

const NOW = "2026-09-22T12:00:00.000Z";

function summary(overrides: Partial<ActivationSummaryV2> = {}): SharedActivationSummary {
  const content: ActivationSummaryV2 = {
    contractVersion: "2",
    period: { startedAt: "2026-09-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:00.000Z", timeZone: "UTC" },
    stage: "incomplete",
    progress: {
      members: { state: "completed", total: 2, firstLoginCompleted: 2, source: "user", definition: "members" },
      workbooks: { state: "incomplete", count: 0, source: "workbook", definition: "workbooks" },
      imports: { state: "unknown", completed: null, outcomeUnknown: null, source: "import_batch", definition: "imports" },
      checks: { state: "unknown", completed: null, failed: null, source: "data_check_run", definition: "checks" },
      reviews: { state: "unknown", completed: null, pending: null, source: "finding_assignment", definition: "reviews" },
    },
    outcomes: {
      firstReview: { state: "unknown", durationMinutes: null, source: "review", definition: "first review" },
      importQuality: { state: "unknown", terminalBatches: null, failedBatches: null, outcomeUnknownBatches: null, failureRate: null, determinedRows: null, rejectedRows: null, outcomeUnknownRows: null, rejectionRate: null, source: "import", definition: "quality" },
      issueResolution: { state: "unknown", runStartedAt: null, denominator: null, reviewedClosed: null, notApplicable: null, rate: null, source: "finding", definition: "resolution" },
      collaboration: { state: "unknown", humanActors: null, source: "assignment", definition: "collaboration" },
      nextWeekUpdate: { state: "unknown", windowStartedAt: null, windowEndedAt: null, evidenceAt: null, source: "activity", definition: "next update" },
    },
    updatedAt: NOW,
    dedupeKey: "2026-09:v2",
    ...overrides,
  };
  return {
    summaryId: "workspace_activation_summary:demo",
    workspaceSlug: "demo",
    contractVersion: "2",
    status: "active",
    summary: content,
    suppliedAt: NOW,
    updatedAt: content.updatedAt,
    sourceTrust: "team_supplied",
  };
}

class MemoryStore implements OpsFollowUpStore {
  summaries: SharedActivationSummary[] = [summary()];
  items: FollowUpItem[] = [];
  idempotency = new Map<string, { item: FollowUpItem; requestDigest: string }>();
  writes = 0;

  async listActiveSummaries() { return this.summaries.filter((item) => item.status === "active"); }
  async getSummary(id: string) { return this.summaries.find((item) => item.summaryId === id) ?? null; }
  async findIdempotent(subject: string, key: string) { return this.idempotency.get(`${subject}:${key}`) ?? null; }
  async create(input: Parameters<OpsFollowUpStore["create"]>[0]) {
    const duplicate = this.items.find((item) => item.dedupeKey === input.dedupeKey);
    if (duplicate) return duplicate;
    this.writes += 1;
    const item: FollowUpItem = {
      followUpId: `activation_follow_up:${this.items.length + 1}`,
      workspaceSlug: input.workspaceSlug,
      summaryId: input.summaryId,
      reason: input.reason,
      period: input.period,
      dedupeKey: input.dedupeKey,
      sourceContractVersion: input.sourceContractVersion,
      sourceUpdatedAt: input.sourceUpdatedAt,
      sourceAvailable: true,
      sourceFreshness: "fresh",
      status: "open",
      ownerSubject: null,
      leaseExpiresAt: null,
      dueCheckAt: input.dueCheckAt,
      result: null,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
      nextStep: "claim",
    };
    this.items.push(item);
    this.idempotency.set(`${input.actorSubject}:${input.idempotencyKey}`, { item, requestDigest: input.requestDigest });
    return item;
  }
  async list(input: { limit: number; cursor: FollowUpCursor | null }) {
    const ordered = [...this.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.followUpId.localeCompare(a.followUpId));
    if (!input.cursor) return ordered.slice(0, input.limit);
    return ordered.filter((item) => item.updatedAt < input.cursor!.updatedAt || (item.updatedAt === input.cursor!.updatedAt && item.followUpId < input.cursor!.followUpId)).slice(0, input.limit);
  }
  async get(id: string) { return this.items.find((item) => item.followUpId === id) ?? null; }
  async claim(input: Parameters<OpsFollowUpStore["claim"]>[0]) {
    const current = this.items.find((item) => item.followUpId === input.followUpId) ?? null;
    if (!current || current.version !== input.expectedVersion) return null;
    if (current.leaseExpiresAt && current.leaseExpiresAt > input.now && current.ownerSubject !== input.actorSubject) return null;
    const changed: FollowUpItem = { ...current, ownerSubject: input.actorSubject, leaseExpiresAt: input.leaseExpiresAt, status: "claimed", version: current.version + 1, updatedAt: input.now, nextStep: "update" };
    this.items[this.items.indexOf(current)] = changed;
    this.idempotency.set(`${input.actorSubject}:${input.idempotencyKey}`, { item: changed, requestDigest: input.requestDigest });
    return changed;
  }
  async update(input: Parameters<OpsFollowUpStore["update"]>[0]) {
    const current = await this.get(input.followUpId);
    if (!current || current.version !== input.expectedVersion || current.ownerSubject !== input.actorSubject || !current.leaseExpiresAt || current.leaseExpiresAt <= input.now) return null;
    const changed: FollowUpItem = { ...current, status: input.status, dueCheckAt: input.dueCheckAt, result: input.result, version: current.version + 1, updatedAt: input.now, nextStep: input.status === "resolved" || input.status === "dismissed" ? "none" : "update" };
    this.items[this.items.indexOf(current)] = changed;
    this.idempotency.set(`${input.actorSubject}:${input.idempotencyKey}`, { item: changed, requestDigest: input.requestDigest });
    return changed;
  }
}

const reader = { subject: "ops-reader", capabilities: ["activation.followup.read"] };
const writer = { subject: "ops-a", capabilities: ["activation.followup.read", "activation.followup.write"] };

describe("ops follow-up service", () => {
  test("derives fresh opportunities with stable pagination and does not turn stale/unknown into churn", async () => {
    const store = new MemoryStore();
    store.summaries.push(summary({ updatedAt: "2026-07-01T00:00:00.000Z", dedupeKey: "old" }));
    store.summaries.push(summary({ stage: "unknown", dedupeKey: "unknown" }));
    const service = new OpsFollowUpService(store, () => new Date(NOW));
    const page = await service.listOpportunities(reader, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ reason: "activation_incomplete", freshness: "fresh", nextStep: "create_follow_up" });
    expect(page.items[0]?.opportunityId).toContain("demo:activation_incomplete");
    expect(page.nextCursor).toBeNull();
  });

  test("pages opportunities and follow-ups without repeating a cursor item", async () => {
    const store = new MemoryStore();
    store.summaries.push({ ...summary({ updatedAt: "2026-09-22T11:00:00.000Z" }), summaryId: "workspace_activation_summary:other", workspaceSlug: "other" });
    const service = new OpsFollowUpService(store, () => new Date(NOW));
    const firstPage = await service.listOpportunities(reader, { limit: 1 });
    expect(firstPage.nextCursor).toBeTypeOf("string");
    const secondPage = await service.listOpportunities(reader, { limit: 1, cursor: firstPage.nextCursor! });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.opportunityId).not.toBe(firstPage.items[0]?.opportunityId);
    await service.create(writer, { opportunityId: firstPage.items[0]!.opportunityId, dueCheckAt: null, idempotencyKey: "page-create-0001" });
    await service.create(writer, { opportunityId: secondPage.items[0]!.opportunityId, dueCheckAt: null, idempotencyKey: "page-create-0002" });
    const queueFirst = await service.listFollowUps(reader, { limit: 1 });
    const queueSecond = await service.listFollowUps(reader, { limit: 1, cursor: queueFirst.nextCursor! });
    expect(queueSecond.items[0]?.followUpId).not.toBe(queueFirst.items[0]?.followUpId);
    expect(queueSecond.nextCursor).toBeNull();
  });

  test("deduplicates workspace + reason + period and replays idempotent create", async () => {
    const store = new MemoryStore();
    const service = new OpsFollowUpService(store, () => new Date(NOW));
    const opportunity = (await service.listOpportunities(reader, {})).items[0]!;
    const first = await service.create(writer, { opportunityId: opportunity.opportunityId, dueCheckAt: "2026-09-25T00:00:00.000Z", idempotencyKey: "create-0001" });
    const replay = await service.create(writer, { opportunityId: opportunity.opportunityId, dueCheckAt: "2026-09-25T00:00:00.000Z", idempotencyKey: "create-0001" });
    const duplicate = await service.create(writer, { opportunityId: opportunity.opportunityId, dueCheckAt: null, idempotencyKey: "create-0002" });
    expect(replay.followUpId).toBe(first.followUpId);
    expect(duplicate.followUpId).toBe(first.followUpId);
    expect(store.writes).toBe(1);
    await expect(service.create(writer, { opportunityId: opportunity.opportunityId, dueCheckAt: "2026-09-26T00:00:00.000Z", idempotencyKey: "create-0001" })).rejects.toMatchObject({ code: "conflict" });
  });

  test("only one concurrent claimant wins; expired lease can be reclaimed and old owner cannot update", async () => {
    const store = new MemoryStore();
    let now = new Date(NOW);
    const service = new OpsFollowUpService(store, () => now);
    const opportunity = (await service.listOpportunities(reader, {})).items[0]!;
    const item = await service.create(writer, { opportunityId: opportunity.opportunityId, dueCheckAt: null, idempotencyKey: "create-0001" });
    const [a, b] = await Promise.allSettled([
      service.claim(writer, { followUpId: item.followUpId, expectedVersion: 1, leaseSeconds: 60, idempotencyKey: "claim-a-0001" }),
      service.claim({ ...writer, subject: "ops-b" }, { followUpId: item.followUpId, expectedVersion: 1, leaseSeconds: 60, idempotencyKey: "claim-b-0001" }),
    ]);
    expect([a, b].filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const claimed = (a.status === "fulfilled" ? a.value : (b as PromiseFulfilledResult<FollowUpItem>).value);
    const oldOwner = claimed.ownerSubject!;
    const bystander = { ...reader, subject: "ops-c" };
    expect((await service.listFollowUps(bystander, {})).items[0]?.nextStep).toBe("none");
    now = new Date("2026-09-22T12:02:00.000Z");
    expect((await service.listFollowUps(bystander, {})).items[0]?.nextStep).toBe("claim");
    const reclaimed = await service.claim({ ...writer, subject: "ops-c" }, { followUpId: item.followUpId, expectedVersion: claimed.version, leaseSeconds: 60, idempotencyKey: "claim-c-0001" });
    expect(reclaimed.ownerSubject).toBe("ops-c");
    await expect(service.update({ ...writer, subject: oldOwner }, { followUpId: item.followUpId, expectedVersion: reclaimed.version, status: "resolved", dueCheckAt: null, result: "done", idempotencyKey: "update-old-0001" })).rejects.toMatchObject({ code: "conflict" });
  });

  test("withdrawn source hides content but retains minimal queue history", async () => {
    const store = new MemoryStore();
    const service = new OpsFollowUpService(store, () => new Date(NOW));
    const opportunity = (await service.listOpportunities(reader, {})).items[0]!;
    const item = await service.create(writer, { opportunityId: opportunity.opportunityId, dueCheckAt: null, idempotencyKey: "create-0001" });
    store.summaries[0] = { ...store.summaries[0]!, status: "withdrawn", summary: null };
    const page = await service.listFollowUps(reader, {});
    expect(page.items[0]).toMatchObject({ followUpId: item.followUpId, sourceAvailable: false, summaryId: "workspace_activation_summary:demo" });
    expect(await service.listOpportunities(reader, {})).toEqual({ items: [], nextCursor: null });
  });

  test("replaced summary version does not masquerade as the original follow-up source", async () => {
    const store = new MemoryStore();
    const service = new OpsFollowUpService(store, () => new Date(NOW));
    const opportunity = (await service.listOpportunities(reader, {})).items[0]!;
    await service.create(writer, { opportunityId: opportunity.opportunityId, dueCheckAt: null, idempotencyKey: "create-replaced-0001" });
    store.summaries[0] = { ...store.summaries[0]!, updatedAt: "2026-09-22T12:01:00.000Z" };
    expect((await service.listFollowUps(reader, {})).items[0]).toMatchObject({ sourceAvailable: false, sourceFreshness: "unavailable" });
  });

  test("checks capability and idempotency on every mutation", async () => {
    const store = new MemoryStore();
    const service = new OpsFollowUpService(store, () => new Date(NOW));
    await expect(service.listFollowUps({ subject: "ops", capabilities: [] }, {})).rejects.toBeInstanceOf(OpsFollowUpServiceError);
    const opportunity = (await service.listOpportunities(reader, {})).items[0]!;
    await expect(service.create(reader, { opportunityId: opportunity.opportunityId, dueCheckAt: null, idempotencyKey: "create-0001" })).rejects.toMatchObject({ code: "capability_missing" });
    await expect(service.create(writer, { opportunityId: opportunity.opportunityId, dueCheckAt: null, idempotencyKey: "short" })).rejects.toMatchObject({ code: "invalid_request" });
  });

  test("暂停后不能用旧幂等键取回已完成跟进动作", async () => {
    const store = new MemoryStore();
    let paused = false;
    const service = new OpsFollowUpService(store, () => new Date(NOW), {
      authorize: async () => { if (paused) throw { code: "paused" }; },
      allowedWorkspaces: async () => ["demo"],
    });
    const agent = { ...writer, kind: "agent" as const };
    const opportunity = (await service.listOpportunities(agent, {})).items[0]!;
    const createInput = { opportunityId: opportunity.opportunityId, dueCheckAt: null, idempotencyKey: "create-verify-01" };
    const created = await service.create(agent, createInput);
    expect(await service.verifyAction(agent, "follow_up.create", { ...createInput, idempotencyKey: "missing-key-01" })).toBeNull();
    expect((await service.verifyAction(agent, "follow_up.create", createInput))?.followUpId).toBe(created.followUpId);
    await expect(service.verifyAction(agent, "follow_up.create", { ...createInput, dueCheckAt: "2026-09-30T00:00:00.000Z" })).rejects.toMatchObject({ code: "conflict" });
    paused = true;
    await expect(service.verifyAction(agent, "follow_up.create", createInput)).rejects.toMatchObject({ code: "paused" });
  });
});
