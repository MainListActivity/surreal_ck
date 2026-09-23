import { z } from "zod";

export const activationMetricStateSchema = z.enum([
  "unknown",
  "incomplete",
  "completed",
  "failed",
]);

export const activationMetricSchema = z.object({
  state: activationMetricStateSchema,
  count: z.number().int().nonnegative().nullable(),
  source: z.string().min(1).max(80),
});

export const activationSummaryV1Schema = z.object({
  contractVersion: z.literal("1"),
  period: z.object({
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
    timeZone: z.string().min(1).max(64),
  }),
  stage: z.enum(["unknown", "incomplete", "activated", "failed"]),
  metrics: z.object({
    members: activationMetricSchema,
    workbooks: activationMetricSchema,
    imports: activationMetricSchema,
    reviews: activationMetricSchema,
  }).strict(),
  updatedAt: z.iso.datetime(),
  dedupeKey: z.string().min(1).max(256),
}).strict();

export const activationOutcomeStateSchema = z.enum([
  "unknown",
  "not_applicable",
  "incomplete",
  "completed",
  "failed",
]);

const outcomeBase = z.object({
  state: activationOutcomeStateSchema,
  source: z.string().min(1).max(120),
  definition: z.string().min(1).max(300),
});

export const activationSummaryV2Schema = z.object({
  contractVersion: z.literal("2"),
  period: z.object({
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
    timeZone: z.string().min(1).max(64),
  }),
  stage: z.enum(["unknown", "incomplete", "activated", "failed"]),
  progress: z.object({
    members: outcomeBase.extend({ total: z.number().int().nonnegative().nullable(), firstLoginCompleted: z.number().int().nonnegative().nullable() }),
    workbooks: outcomeBase.extend({ count: z.number().int().nonnegative().nullable() }),
    imports: outcomeBase.extend({ completed: z.number().int().nonnegative().nullable(), outcomeUnknown: z.number().int().nonnegative().nullable() }),
    checks: outcomeBase.extend({ completed: z.number().int().nonnegative().nullable(), failed: z.number().int().nonnegative().nullable() }),
    reviews: outcomeBase.extend({ completed: z.number().int().nonnegative().nullable(), pending: z.number().int().nonnegative().nullable() }),
  }).strict(),
  outcomes: z.object({
    firstReview: outcomeBase.extend({ durationMinutes: z.number().int().nonnegative().nullable() }),
    importQuality: outcomeBase.extend({
      terminalBatches: z.number().int().nonnegative().nullable(),
      failedBatches: z.number().int().nonnegative().nullable(),
      outcomeUnknownBatches: z.number().int().nonnegative().nullable(),
      failureRate: z.number().min(0).max(1).nullable(),
      determinedRows: z.number().int().nonnegative().nullable(),
      rejectedRows: z.number().int().nonnegative().nullable(),
      outcomeUnknownRows: z.number().int().nonnegative().nullable(),
      rejectionRate: z.number().min(0).max(1).nullable(),
    }),
    issueResolution: outcomeBase.extend({
      runStartedAt: z.iso.datetime().nullable(),
      denominator: z.number().int().nonnegative().nullable(),
      reviewedClosed: z.number().int().nonnegative().nullable(),
      notApplicable: z.number().int().nonnegative().nullable(),
      rate: z.number().min(0).max(1).nullable(),
    }),
    collaboration: outcomeBase.extend({ humanActors: z.number().int().nonnegative().nullable() }),
    nextWeekUpdate: outcomeBase.extend({
      windowStartedAt: z.iso.datetime().nullable(),
      windowEndedAt: z.iso.datetime().nullable(),
      evidenceAt: z.iso.datetime().nullable(),
    }),
  }).strict(),
  updatedAt: z.iso.datetime(),
  dedupeKey: z.string().min(1).max(256),
}).strict();

export const activationSummarySchema = z.union([
  activationSummaryV1Schema,
  activationSummaryV2Schema,
]);

export const shareActivationSummarySchema = z.object({
  summary: activationSummarySchema,
  idempotencyKey: z.string().min(8).max(256),
}).strict();

export const withdrawActivationSummarySchema = z.object({
  idempotencyKey: z.string().min(8).max(256),
}).strict();

export type ActivationMetricState = z.infer<typeof activationMetricStateSchema>;
export type ActivationMetric = z.infer<typeof activationMetricSchema>;
export type ActivationSummaryV1 = z.infer<typeof activationSummaryV1Schema>;
export type ActivationSummaryV2 = z.infer<typeof activationSummaryV2Schema>;
export type ActivationSummary = z.infer<typeof activationSummarySchema>;
export type ShareActivationSummaryInput = z.infer<typeof shareActivationSummarySchema>;

export type SharedActivationSummary = {
  summaryId: string;
  workspaceSlug: string;
  contractVersion: "1" | "2";
  status: "active" | "withdrawn";
  summary: ActivationSummary | null;
  suppliedAt: string | null;
  updatedAt: string;
  sourceTrust: "team_supplied";
};

export type ActivationSummaryPage = {
  items: SharedActivationSummary[];
  nextCursor: string | null;
};
