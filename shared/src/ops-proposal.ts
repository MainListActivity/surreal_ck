import { z } from "zod";

export const opsProposalActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("follow_up.claim"), leaseSeconds: z.number().int().min(30).max(3600) }).strict(),
  z.object({ type: z.literal("follow_up.update"), status: z.enum(["waiting", "resolved", "dismissed"]), dueCheckAt: z.iso.datetime().nullable(), result: z.string().trim().min(1).max(2000).nullable() }).strict()
    .refine((value) => value.status === "waiting" || Boolean(value.result), { path: ["result"] }),
]);
const idempotencyKey = z.string().min(8).max(256);
export const submitOpsProposalSchema = z.object({
  followUpId: z.string().startsWith("activation_follow_up:").max(256),
  followUpVersion: z.number().int().positive(),
  summaryUpdatedAt: z.iso.datetime(),
  action: opsProposalActionSchema,
  rationale: z.string().trim().min(1).max(1000),
  expectedResult: z.string().trim().min(1).max(1000),
  triggerReason: z.enum(["fresh_activation_opportunity", "manual_support_review", "scheduled_check"]),
  inputSummary: z.string().trim().min(1).max(500),
  idempotencyKey,
}).strict();
export const reviewOpsProposalSchema = z.object({
  expectedVersion: z.number().int().positive(),
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(1).max(1000),
  idempotencyKey,
}).strict();
export const executeOpsProposalSchema = z.object({ expectedVersion: z.number().int().positive(), idempotencyKey }).strict();
export const takeoverFollowUpSchema = z.object({ expectedVersion: z.number().int().positive(), leaseSeconds: z.number().int().min(30).max(3600), reason: z.string().trim().min(1).max(1000), idempotencyKey }).strict();

export type OpsProposalAction = z.infer<typeof opsProposalActionSchema>;
export type OpsProposal = {
  proposalId: string;
  followUpId: string;
  summaryId: string;
  summaryUpdatedAt: string;
  followUpVersion: number;
  action: OpsProposalAction;
  actionDigest: string;
  rationale: string;
  expectedResult: string;
  triggerReason: string;
  inputSummary: string;
  proposerSubject: string;
  agentId: string | null;
  status: "pending" | "approved" | "rejected" | "executing" | "succeeded" | "failed" | "stale";
  version: number;
  executorSubject: string | null;
  reviewerSubject: string | null;
  reviewReason: string | null;
  toolResult: { code: string; followUpId?: string; followUpVersion?: number } | null;
  actionFollowUpVersion: number | null;
  createdAt: string;
  updatedAt: string;
};
export type OpsProposalPage = { items: OpsProposal[]; nextCursor: string | null };
