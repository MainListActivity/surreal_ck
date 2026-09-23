import { describe, expect, test } from "bun:test";
import { activationSummarySchema } from "./activation-summary";

describe("activation summary version compatibility", () => {
  test("continues accepting the v1 contract", () => {
    expect(activationSummarySchema.safeParse({
      contractVersion: "1",
      period: { startedAt: "2026-09-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:00.000Z", timeZone: "UTC" },
      stage: "incomplete",
      metrics: {
        members: { state: "completed", count: 1, source: "workspace.user" },
        workbooks: { state: "incomplete", count: 0, source: "workspace.workbook" },
        imports: { state: "unknown", count: null, source: "not_reported_v1" },
        reviews: { state: "unknown", count: null, source: "not_reported_v1" },
      },
      updatedAt: "2026-09-22T12:00:00.000Z",
      dedupeKey: "2026-09:v1",
    }).success).toBeTrue();
  });
});
