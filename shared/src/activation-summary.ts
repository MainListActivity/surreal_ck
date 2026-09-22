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

export const shareActivationSummarySchema = z.object({
  summary: activationSummaryV1Schema,
  idempotencyKey: z.string().min(8).max(256),
}).strict();

export const withdrawActivationSummarySchema = z.object({
  idempotencyKey: z.string().min(8).max(256),
}).strict();

export type ActivationMetricState = z.infer<typeof activationMetricStateSchema>;
export type ActivationMetric = z.infer<typeof activationMetricSchema>;
export type ActivationSummaryV1 = z.infer<typeof activationSummaryV1Schema>;
export type ShareActivationSummaryInput = z.infer<typeof shareActivationSummarySchema>;

export type SharedActivationSummary = {
  summaryId: string;
  workspaceSlug: string;
  contractVersion: "1";
  status: "active" | "withdrawn";
  summary: ActivationSummaryV1 | null;
  suppliedAt: string | null;
  updatedAt: string;
  sourceTrust: "team_supplied";
};

export type ActivationSummaryPage = {
  items: SharedActivationSummary[];
  nextCursor: string | null;
};
