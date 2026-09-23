import { z } from "zod";

export const opsRunPendingActionSchema = z.object({
  tool: z.enum(["create_follow_up", "claim_follow_up", "update_follow_up", "submit_ops_proposal"]),
  idempotencyKey: z.string().min(8).max(256),
  targetId: z.string().min(1).max(256),
  argsJson: z.string().min(2).max(4096),
}).strict();

export const saveOpsRunSchema = z.object({
  runKey: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/u),
  workspaceSlug: z.string().trim().min(1).max(128),
  expectedVersion: z.number().int().nonnegative().nullable(),
  status: z.enum(["running", "waiting", "completed", "needs_human"]),
  cursor: z.string().max(2048).nullable(),
  processedIds: z.array(z.string().min(1).max(256)).max(500),
  trackedProposalIds: z.array(z.string().startsWith("ops_proposal:").max(256)).max(500),
  pendingAction: opsRunPendingActionSchema.nullable(),
  dueCheckAt: z.string().datetime().nullable(),
  retryCount: z.number().int().min(0).max(100),
  lastErrorCode: z.string().max(128).nullable(),
  actionsCompleted: z.number().int().nonnegative(),
}).strict();

export type SaveOpsRun = z.infer<typeof saveOpsRunSchema>;
export type OpsRun = SaveOpsRun & {
  runId: string;
  agentSubject: string;
  version: number;
  updatedAt: string;
};
