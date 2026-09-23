import { z } from "zod";

export const opsAutonomyActionSchema = z.enum([
  "activation.summary.read", "opportunity.read", "follow_up.read", "follow_up.create", "follow_up.claim", "follow_up.update",
  "proposal.read", "proposal.submit", "proposal.execute",
]);
export const configureOpsAutonomySchema = z.object({
  agentSubject: z.string().trim().min(1).max(256),
  workspaceSlug: z.string().trim().min(1).max(128),
  actions: z.array(opsAutonomyActionSchema).max(9),
  expectedVersion: z.number().int().positive().nullable(),
  idempotencyKey: z.string().min(8).max(256),
}).strict();
export const changeOpsAutonomyStatusSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1000),
  idempotencyKey: z.string().min(8).max(256),
}).strict();
export type OpsAutonomyAction = z.infer<typeof opsAutonomyActionSchema>;
export type OpsAutonomyPolicy = {
  policyId: string;
  agentSubject: string;
  workspaceSlug: string;
  actions: OpsAutonomyAction[];
  status: "active" | "paused" | "revoked";
  version: number;
  updatedBySubject: string;
  updatedAt: string;
};
export type OpsAutonomyAudit = {
  auditId: string;
  policyId: string;
  event: "configured" | "paused" | "resumed" | "revoked";
  actorSubject: string;
  reason: string;
  version: number;
  occurredAt: string;
};
