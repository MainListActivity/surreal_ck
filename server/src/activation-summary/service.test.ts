import { describe, expect, test } from "bun:test";
import type { ActivationSummary, ActivationSummaryV1, ActivationSummaryV2, SharedActivationSummary } from "@surreal-ck/shared";
import {
  ActivationSummaryService,
  ActivationSummaryServiceError,
  type ActivationSummaryCursor,
  type ActivationSummaryStore,
  type WorkspaceSummaryAuthority,
} from "./service";

const summary: ActivationSummaryV1 = {
  contractVersion: "1",
  period: {
    startedAt: "2026-09-01T00:00:00.000Z",
    endedAt: "2026-10-01T00:00:00.000Z",
    timeZone: "Asia/Shanghai",
  },
  stage: "activated",
  metrics: {
    members: { state: "completed", count: 3, source: "workspace.user" },
    workbooks: { state: "completed", count: 2, source: "workspace.workbook" },
    imports: { state: "unknown", count: null, source: "not_reported_v1" },
    reviews: { state: "unknown", count: null, source: "not_reported_v1" },
  },
  updatedAt: "2026-09-22T12:00:00.000Z",
  dedupeKey: "2026-09:v1",
};

const summaryV2: ActivationSummaryV2 = {
  contractVersion: "2",
  period: summary.period,
  stage: "activated",
  progress: {
    members: { state: "completed", total: 2, firstLoginCompleted: 2, source: "user.last_seen_at", definition: "members" },
    workbooks: { state: "completed", count: 1, source: "workbook", definition: "workbooks" },
    imports: { state: "completed", completed: 1, outcomeUnknown: 1, source: "import_batch+import_batch_row", definition: "imports" },
    checks: { state: "completed", completed: 1, failed: 0, source: "data_check_run", definition: "checks" },
    reviews: { state: "completed", completed: 1, pending: 0, source: "finding_assignment", definition: "reviews" },
  },
  outcomes: {
    firstReview: { state: "completed", durationMinutes: 60, source: "import→review", definition: "first review" },
    importQuality: { state: "completed", terminalBatches: 1, failedBatches: 0, outcomeUnknownBatches: 1, failureRate: 0, determinedRows: 10, rejectedRows: 0, outcomeUnknownRows: 1, rejectionRate: 0, source: "import evidence", definition: "import quality" },
    issueResolution: { state: "not_applicable", runStartedAt: summary.period.startedAt, denominator: 0, reviewedClosed: 0, notApplicable: 0, rate: null, source: "fixed run", definition: "issue resolution" },
    collaboration: { state: "completed", humanActors: 2, source: "assignment events", definition: "collaboration" },
    nextWeekUpdate: { state: "completed", windowStartedAt: summary.period.startedAt, windowEndedAt: summary.period.endedAt, evidenceAt: summary.updatedAt, source: "activity event", definition: "next week update" },
  },
  updatedAt: summary.updatedAt,
  dedupeKey: "2026-09:v2",
};

class MemoryStore implements ActivationSummaryStore {
  readonly authority: WorkspaceSummaryAuthority = {
    workspaceId: "workspace:demo",
    workspaceSlug: "demo",
    dbName: "ws_demo",
  };
  adminSubject = "admin-1";
  item: SharedActivationSummary | null = null;
  audit = new Map<string, SharedActivationSummary>();
  writes = 0;

  async resolveAdmin(slug: string, subject: string) {
    return slug === "demo" && subject === this.adminSubject ? this.authority : null;
  }
  async findIdempotent(_workspaceId: string, key: string) {
    return this.audit.get(key) ?? null;
  }
  async share(input: { summary: ActivationSummary; idempotencyKey: string }) {
    this.writes += 1;
    this.item = {
      summaryId: "workspace_activation_summary:demo",
      workspaceSlug: "demo",
      contractVersion: input.summary.contractVersion,
      status: "active",
      summary: input.summary,
      suppliedAt: input.summary.updatedAt,
      updatedAt: input.summary.updatedAt,
      sourceTrust: "team_supplied",
    };
    this.audit.set(input.idempotencyKey, this.item);
    return this.item;
  }
  async withdraw(input: { idempotencyKey: string }) {
    this.writes += 1;
    this.item = {
      ...(this.item ?? {
        summaryId: "workspace_activation_summary:demo",
        workspaceSlug: "demo",
        contractVersion: "1" as const,
        updatedAt: "2026-09-22T12:00:00.000Z",
        sourceTrust: "team_supplied" as const,
      }),
      status: "withdrawn",
      summary: null,
      suppliedAt: null,
    };
    this.audit.set(input.idempotencyKey, this.item);
    return this.item;
  }
  async list(_input: { limit: number; cursor: ActivationSummaryCursor | null }) {
    return this.item?.status === "active" ? [this.item] : [];
  }
  async get(id: string) {
    return this.item?.summaryId === id ? this.item : null;
  }
}

describe("activation summary service", () => {
  test("rejects forged workspace identity and non-whitelisted fields", async () => {
    const service = new ActivationSummaryService(new MemoryStore());
    await expect(service.share({
      workspaceSlug: "other",
      actorSubject: "admin-1",
      summary,
      idempotencyKey: "request-0001",
    })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.share({
      workspaceSlug: "demo",
      actorSubject: "admin-1",
      summary: { ...summary, caseName: "不得共享" },
      idempotencyKey: "request-0002",
    })).rejects.toMatchObject({ code: "invalid_request" });
  });

  test("keeps unknown metrics explicit and replays the same idempotency key", async () => {
    const store = new MemoryStore();
    const service = new ActivationSummaryService(store);
    const first = await service.share({
      workspaceSlug: "demo",
      actorSubject: "admin-1",
      summary,
      idempotencyKey: "request-0001",
    });
    const replay = await service.share({
      workspaceSlug: "demo",
      actorSubject: "admin-1",
      summary: { ...summary, stage: "failed" },
      idempotencyKey: "request-0001",
    });
    expect(replay).toEqual(first);
    expect(store.writes).toBe(1);
    expect(first.summary?.metrics.imports).toEqual({ state: "unknown", count: null, source: "not_reported_v1" });
  });

  test("accepts v2 outcomes without collapsing not-applicable or outcome-unknown", async () => {
    const service = new ActivationSummaryService(new MemoryStore());
    const shared = await service.share({
      workspaceSlug: "demo",
      actorSubject: "admin-1",
      summary: summaryV2,
      idempotencyKey: "request-v2-0001",
    });
    expect(shared.contractVersion).toBe("2");
    expect(shared.summary?.contractVersion).toBe("2");
    if (shared.summary?.contractVersion !== "2") throw new Error("expected v2 summary");
    expect(shared.summary.outcomes.issueResolution.state).toBe("not_applicable");
    expect(shared.summary.progress.imports.outcomeUnknown).toBe(1);
  });

  test("withdrawal clears content and removes it from operator reads", async () => {
    const store = new MemoryStore();
    const service = new ActivationSummaryService(store);
    await service.share({ workspaceSlug: "demo", actorSubject: "admin-1", summary, idempotencyKey: "request-0001" });
    const withdrawn = await service.withdraw({
      workspaceSlug: "demo",
      actorSubject: "admin-1",
      idempotencyKey: "withdraw-0001",
    });
    expect(withdrawn.summary).toBeNull();
    expect(withdrawn.status).toBe("withdrawn");
    await expect(service.get(
      { subject: "ops-1", capabilities: ["activation.summary.read"] },
      withdrawn.summaryId,
    )).rejects.toMatchObject({ code: "not_found" });
  });

  test("applies live capability checks and returns opaque pagination", async () => {
    const store = new MemoryStore();
    const service = new ActivationSummaryService(store);
    await service.share({ workspaceSlug: "demo", actorSubject: "admin-1", summary, idempotencyKey: "request-0001" });
    await expect(service.list({ subject: "ops-1", capabilities: [] }, {}))
      .rejects.toBeInstanceOf(ActivationSummaryServiceError);
    const page = await service.list(
      { subject: "ops-1", capabilities: ["activation.summary.read"] },
      { limit: 1 },
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.sourceTrust).toBe("team_supplied");
    await expect(service.list(
      { subject: "ops-1", capabilities: ["activation.summary.read"] },
      { limit: Number.NaN },
    )).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.list(
      { subject: "ops-1", capabilities: ["activation.summary.read"] },
      { cursor: "not-a-cursor" },
    )).rejects.toMatchObject({ code: "cursor_invalid" });
  });
});
