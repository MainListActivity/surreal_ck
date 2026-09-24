import { describe, expect, test } from "bun:test";
import type { FollowUpItem } from "@surreal-ck/shared";
import { followUpSourceState, matchesProposalPremise } from "./premise";

const updatedAt = "2026-09-01T00:00:00.000Z";
const now = new Date("2026-09-02T00:00:00.000Z");
const item = {
  version: 2,
  summaryId: "workspace_activation_summary:demo",
  sourceUpdatedAt: updatedAt,
  status: "claimed",
  ...followUpSourceState(updatedAt, updatedAt, now),
} as FollowUpItem;
const premise = { followUpVersion: 2, summaryId: item.summaryId, summaryUpdatedAt: updatedAt };

describe("follow-up proposal premise", () => {
  test("uses the same source age boundary in follow-up and proposal reads", () => {
    expect(followUpSourceState(updatedAt, updatedAt, now).sourceFreshness).toBe("fresh");
    expect(followUpSourceState(updatedAt, updatedAt, new Date("2026-10-02T00:00:01.000Z")).sourceFreshness).toBe("stale");
    expect(followUpSourceState(updatedAt, null, now).sourceAvailable).toBe(false);
  });

  test("binds proposal to summary identity, revision, and an actionable follow-up", () => {
    expect(matchesProposalPremise(item, premise, updatedAt)).toBe(true);
    expect(matchesProposalPremise(item, { ...premise, summaryId: "workspace_activation_summary:other" }, updatedAt)).toBe(false);
    expect(matchesProposalPremise(item, premise, null)).toBe(false);
    expect(matchesProposalPremise({ ...item, status: "resolved" }, premise, updatedAt)).toBe(false);
  });
});
