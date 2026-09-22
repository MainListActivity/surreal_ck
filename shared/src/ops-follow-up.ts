import { z } from "zod";

export const followUpReasonSchema = z.enum([
  "activation_incomplete",
  "activation_failed",
  "review_incomplete",
  "next_update_missing",
]);

export const followUpStatusSchema = z.enum([
  "open",
  "claimed",
  "waiting",
  "resolved",
  "dismissed",
]);

export const createFollowUpSchema = z.object({
  opportunityId: z.string().min(1).max(1024),
  dueCheckAt: z.iso.datetime().nullable(),
  idempotencyKey: z.string().min(8).max(256),
}).strict();

export const claimFollowUpSchema = z.object({
  expectedVersion: z.number().int().positive(),
  leaseSeconds: z.number().int().min(30).max(3600),
  idempotencyKey: z.string().min(8).max(256),
}).strict();

export const updateFollowUpSchema = z.object({
  expectedVersion: z.number().int().positive(),
  status: z.enum(["waiting", "resolved", "dismissed"]),
  dueCheckAt: z.iso.datetime().nullable(),
  result: z.string().trim().min(1).max(2_000).nullable(),
  idempotencyKey: z.string().min(8).max(256),
}).strict().refine(
  (input) => input.status === "waiting" || Boolean(input.result?.trim()),
  { path: ["result"], message: "结束跟进时必须填写处理结果" },
);

export type FollowUpReason = z.infer<typeof followUpReasonSchema>;
export type FollowUpStatus = z.infer<typeof followUpStatusSchema>;

export type ActivationOpportunity = {
  opportunityId: string;
  workspaceSlug: string;
  summaryId: string;
  reason: FollowUpReason;
  period: { startedAt: string; endedAt: string; timeZone: string };
  sourceContractVersion: "1" | "2";
  sourceUpdatedAt: string;
  freshness: "fresh";
  freshnessEvaluatedAt: string;
  freshnessMaxAgeDays: 30;
  nextStep: "create_follow_up";
};

export type ActivationOpportunityPage = {
  items: ActivationOpportunity[];
  nextCursor: string | null;
};

export type FollowUpItem = {
  followUpId: string;
  workspaceSlug: string;
  summaryId: string;
  reason: FollowUpReason;
  period: { startedAt: string; endedAt: string; timeZone: string };
  dedupeKey: string;
  sourceContractVersion: "1" | "2";
  sourceUpdatedAt: string;
  sourceAvailable: boolean;
  sourceFreshness: "fresh" | "stale" | "unknown" | "unavailable";
  status: FollowUpStatus;
  ownerSubject: string | null;
  leaseExpiresAt: string | null;
  dueCheckAt: string | null;
  result: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  nextStep: "claim" | "update" | "none";
};

export type FollowUpPage = {
  items: FollowUpItem[];
  nextCursor: string | null;
};
