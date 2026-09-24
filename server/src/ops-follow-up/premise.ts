import type { FollowUpItem, OpsProposal } from "@surreal-ck/shared";

export const FOLLOW_UP_SOURCE_FRESH_MS = 30 * 24 * 60 * 60 * 1_000;

export function followUpSourceState(
  expectedUpdatedAt: string,
  actualUpdatedAt: string | null,
  now: Date,
): Pick<FollowUpItem, "sourceAvailable" | "sourceFreshness"> {
  const sourceAvailable = actualUpdatedAt !== null && actualUpdatedAt === expectedUpdatedAt;
  const age = actualUpdatedAt === null ? Number.NaN : now.getTime() - Date.parse(actualUpdatedAt);
  const sourceFreshness = !sourceAvailable ? "unavailable"
    : !Number.isFinite(age) || age < 0 ? "unknown"
    : age > FOLLOW_UP_SOURCE_FRESH_MS ? "stale" : "fresh";
  return { sourceAvailable, sourceFreshness };
}

/** One source of truth for whether a follow-up can produce a proposal. */
export function hasCurrentFollowUpSource(item: FollowUpItem): boolean {
  return item.sourceAvailable === true
    && item.sourceFreshness === "fresh"
    && item.status !== "resolved"
    && item.status !== "dismissed";
}

export function matchesProposalPremise(
  item: FollowUpItem | null,
  expected: Pick<OpsProposal, "followUpVersion" | "summaryId" | "summaryUpdatedAt">,
  actualSummaryUpdatedAt: string | null,
): boolean {
  return item !== null
    && hasCurrentFollowUpSource(item)
    && item.version === expected.followUpVersion
    && item.summaryId === expected.summaryId
    && item.sourceUpdatedAt === expected.summaryUpdatedAt
    && actualSummaryUpdatedAt === expected.summaryUpdatedAt;
}
