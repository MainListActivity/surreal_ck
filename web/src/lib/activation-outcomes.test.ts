import { describe, expect, test } from "bun:test";
import { calculateActivationSummaryV2, type ActivationEvidence } from "./activation-outcomes";

function evidence(overrides: Partial<ActivationEvidence> = {}): ActivationEvidence {
  const available = <T>(rows: T[]) => ({ available: true as const, rows });
  return {
    users: available([{ id: "user:u1", lastSeenAt: "2026-03-01T00:00:00Z" }, { id: "user:u2", lastSeenAt: null }]),
    workbooks: available([{ id: "workbook:w1" }]),
    imports: available([
      { id: "import_batch:b1", workbookId: "workbook:w1", status: "completed", startedAt: "2026-03-01T16:00:00Z", completedAt: "2026-03-01T16:30:00Z" },
      { id: "import_batch:b2", workbookId: "workbook:w1", status: "partial_failure", startedAt: "2026-03-02T00:00:00Z", completedAt: "2026-03-02T01:00:00Z" },
      { id: "import_batch:b3", workbookId: "workbook:w1", status: "outcome_unknown", startedAt: "2026-03-03T00:00:00Z", completedAt: null },
    ]),
    importRows: available([
      ...Array.from({ length: 7 }, () => ({ batchId: "import_batch:b1", status: "success" })),
      ...Array.from({ length: 3 }, () => ({ batchId: "import_batch:b2", status: "rejected" })),
      ...Array.from({ length: 2 }, () => ({ batchId: "import_batch:b3", status: "outcome_unknown" })),
    ]),
    runs: available([{ id: "data_check_run:r1", workbookId: "workbook:w1", status: "completed", findingCount: 4, startedAt: "2026-03-02T02:00:00Z" }]),
    findings: available([
      { id: "data_check_finding:f1", workbookId: "workbook:w1", runHistory: ["data_check_run:r1"], status: "closed" },
      { id: "data_check_finding:f2", workbookId: "workbook:w1", runHistory: ["data_check_run:r1"], status: "closed" },
      { id: "data_check_finding:f3", workbookId: "workbook:w1", runHistory: ["data_check_run:r1"], status: "not_applicable" },
      { id: "data_check_finding:f4", workbookId: "workbook:w1", runHistory: ["data_check_run:r1"], status: "pending" },
    ]),
    assignments: available([{ id: "finding_assignment:a1", findingIds: ["data_check_finding:f1"], assigneeId: "user:u1", reviewerId: "user:u2", status: "completed", reviewedAt: "2026-03-01T18:30:00Z" }]),
    assignmentEvents: available([
      { assignmentId: "finding_assignment:a1", actorId: "user:u1", kind: "submitted" },
      { assignmentId: "finding_assignment:a1", actorId: "user:u2", kind: "approved" },
    ]),
    activities: available([{ verb: "record.write", createdAt: "2026-03-08T16:05:00Z" }]),
    ...overrides,
  };
}

describe("activation outcome metrics", () => {
  test("uses fixed denominators, separates unknown outcomes, and counts different humans", () => {
    const result = calculateActivationSummaryV2(evidence(), new Date("2026-03-12T00:00:00Z"), "Asia/Shanghai");
    expect(result.outcomes.firstReview).toMatchObject({ state: "completed", durationMinutes: 150 });
    expect(result.outcomes.importQuality).toMatchObject({
      terminalBatches: 2, failedBatches: 1, outcomeUnknownBatches: 1, failureRate: 0.5,
      determinedRows: 10, rejectedRows: 3, outcomeUnknownRows: 2, rejectionRate: 0.3,
    });
    expect(result.outcomes.issueResolution).toMatchObject({ denominator: 4, reviewedClosed: 1, notApplicable: 1, rate: 0.25 });
    expect(result.outcomes.issueResolution.state).toBe("incomplete");
    expect(result.outcomes.collaboration).toMatchObject({ state: "completed", humanActors: 2 });
    expect(result.progress.members).toMatchObject({ state: "incomplete", total: 2, firstLoginCompleted: 1 });
  });

  test("treats local calendar days 7 through 13 as next week, excluding days 6 and 14", () => {
    const at = (createdAt: string) => calculateActivationSummaryV2(
      evidence({ activities: { available: true, rows: [{ verb: "record.write", createdAt }] } }),
      new Date("2026-03-20T00:00:00Z"),
      "Asia/Shanghai",
    ).outcomes.nextWeekUpdate.state;
    expect(at("2026-03-07T16:05:00Z")).toBe("incomplete"); // local day 6
    expect(at("2026-03-08T16:05:00Z")).toBe("completed"); // local day 7
    expect(at("2026-03-14T16:05:00Z")).toBe("completed"); // local day 13
    expect(at("2026-03-15T16:05:00Z")).toBe("incomplete"); // local day 14
  });

  test("zero findings is not applicable, unreviewed findings are incomplete, and missing evidence is unknown", () => {
    const zero = calculateActivationSummaryV2(evidence({
      runs: { available: true, rows: [{ id: "data_check_run:r0", workbookId: "workbook:w1", status: "completed", findingCount: 0, startedAt: "2026-03-02T02:00:00Z" }] },
      findings: { available: true, rows: [] },
      assignments: { available: true, rows: [] },
    }), new Date("2026-03-12T00:00:00Z"), "UTC");
    expect(zero.outcomes.firstReview.state).toBe("not_applicable");
    expect(zero.outcomes.issueResolution.state).toBe("not_applicable");

    const missing = calculateActivationSummaryV2(evidence({
      assignments: { available: false, rows: [] },
      activities: { available: false, rows: [] },
    }), new Date("2026-03-12T00:00:00Z"), "UTC");
    expect(missing.outcomes.firstReview.state).toBe("unknown");
    expect(missing.outcomes.nextWeekUpdate.state).toBe("unknown");
    expect(missing.stage).toBe("unknown");
  });

  test("pins the first post-import run and only counts findings closed by a human approval", () => {
    const result = calculateActivationSummaryV2(evidence({
      runs: { available: true, rows: [
        { id: "data_check_run:r1", workbookId: "workbook:w1", status: "completed", findingCount: 4, startedAt: "2026-03-02T02:00:00Z" },
        { id: "data_check_run:r2", workbookId: "workbook:w1", status: "completed", findingCount: 1, startedAt: "2026-03-10T02:00:00Z" },
      ] },
      findings: { available: true, rows: [
        { id: "data_check_finding:f1", workbookId: "workbook:w1", runHistory: ["data_check_run:r1"], status: "closed" },
        { id: "data_check_finding:f2", workbookId: "workbook:w1", runHistory: ["data_check_run:r1"], status: "closed" },
        { id: "data_check_finding:f3", workbookId: "workbook:w1", runHistory: ["data_check_run:r1"], status: "closed" },
        { id: "data_check_finding:f4", workbookId: "workbook:w1", runHistory: ["data_check_run:r1"], status: "closed" },
        { id: "data_check_finding:new", workbookId: "workbook:w1", runHistory: ["data_check_run:r2"], status: "closed" },
      ] },
    }), new Date("2026-03-12T00:00:00Z"), "UTC");
    expect(result.outcomes.issueResolution).toMatchObject({
      runStartedAt: "2026-03-02T02:00:00Z",
      denominator: 4,
      reviewedClosed: 1,
      rate: 0.25,
      state: "incomplete",
    });
  });

  test("keeps no-import progress incomplete and excludes self-review from collaboration", () => {
    const noImport = calculateActivationSummaryV2(evidence({
      imports: { available: true, rows: [] },
      importRows: { available: true, rows: [] },
    }), new Date("2026-03-12T00:00:00Z"), "UTC");
    expect(noImport.outcomes.firstReview.state).toBe("incomplete");

    const selfReviewed = calculateActivationSummaryV2(evidence({
      assignments: { available: true, rows: [{
        id: "finding_assignment:a1",
        findingIds: ["data_check_finding:f1"],
        assigneeId: "user:u2",
        reviewerId: "user:u2",
        status: "completed",
        reviewedAt: "2026-03-01T18:30:00Z",
      }] },
      assignmentEvents: { available: true, rows: [
        { assignmentId: "finding_assignment:a1", actorId: "user:u1", kind: "created" },
        { assignmentId: "finding_assignment:a1", actorId: "user:u2", kind: "submitted" },
        { assignmentId: "finding_assignment:a1", actorId: "user:u2", kind: "approved" },
      ] },
    }), new Date("2026-03-12T00:00:00Z"), "UTC");
    expect(selfReviewed.outcomes.collaboration).toMatchObject({ state: "incomplete", humanActors: 0 });
  });

  test("anchors post-import runs and next-week window to the earliest successful completion", () => {
    const result = calculateActivationSummaryV2(evidence({
      imports: { available: true, rows: [
        { id: "import_batch:slow", workbookId: "workbook:w1", status: "completed", startedAt: "2026-03-01T00:00:00Z", completedAt: "2026-03-05T00:00:00Z" },
        { id: "import_batch:fast", workbookId: "workbook:w1", status: "completed", startedAt: "2026-03-02T00:00:00Z", completedAt: "2026-03-03T00:00:00Z" },
      ] },
      importRows: { available: true, rows: [
        { batchId: "import_batch:slow", status: "success" },
        { batchId: "import_batch:fast", status: "success" },
      ] },
      runs: { available: true, rows: [
        { id: "data_check_run:before-slow", workbookId: "workbook:w1", status: "completed", findingCount: 0, startedAt: "2026-03-04T00:00:00Z" },
        { id: "data_check_run:after-both", workbookId: "workbook:w1", status: "completed", findingCount: 0, startedAt: "2026-03-06T00:00:00Z" },
      ] },
      findings: { available: true, rows: [] },
      assignments: { available: true, rows: [] },
      assignmentEvents: { available: true, rows: [] },
      activities: { available: true, rows: [] },
    }), new Date("2026-03-20T00:00:00Z"), "UTC");
    expect(result.outcomes.issueResolution.runStartedAt).toBe("2026-03-04T00:00:00Z");
    expect(result.outcomes.nextWeekUpdate.windowStartedAt).toBe("2026-03-10T00:00:00.000Z");
  });
});
