import { z } from "zod";

const RecordIdStringSchema = z
  .string()
  .regex(/^[a-z_][a-z0-9_]*:[^\s]+$/u);
const ChecksumSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const DecimalCountSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const IsoDateTimeSchema = z.iso.datetime();

export const QUOTA_MIGRATION_COHORTS = [
  "synthetic_internal",
  "one_percent",
  "ten_percent",
  "fifty_percent",
  "remainder",
] as const;
export const QuotaMigrationCohortSchema = z.enum(
  QUOTA_MIGRATION_COHORTS,
);
export type QuotaMigrationCohort = z.infer<
  typeof QuotaMigrationCohortSchema
>;

export const QuotaMigrationRolloutClassSchema = z.enum([
  "synthetic",
  "internal",
  "standard",
]);
export type QuotaMigrationRolloutClass = z.infer<
  typeof QuotaMigrationRolloutClassSchema
>;

export const QuotaMigrationAnomalySchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["discrepancy", "blocker"]),
  details: z.record(z.string(), z.unknown()).default({}),
});
export type QuotaMigrationAnomaly = z.infer<
  typeof QuotaMigrationAnomalySchema
>;

export const QuotaMigrationPhysicalTableSchema = z.object({
  table: z.string().min(1),
  field_count: DecimalCountSchema,
  record_count: DecimalCountSchema,
});
export type QuotaMigrationPhysicalTable = z.infer<
  typeof QuotaMigrationPhysicalTableSchema
>;

export const QuotaMigrationPhysicalScanSchema = z.object({
  tables: z.array(QuotaMigrationPhysicalTableSchema),
  totals: z.object({
    table_count: DecimalCountSchema,
    field_count: DecimalCountSchema,
    record_count: DecimalCountSchema,
  }),
  scan_checksum: ChecksumSchema,
});
export type QuotaMigrationPhysicalScan = z.infer<
  typeof QuotaMigrationPhysicalScanSchema
>;

export const QuotaMigrationLegacyEvidenceSchema = z.object({
  plans: z.array(
    z.object({
      plan_record: RecordIdStringSchema,
      plan_key: z.string(),
      max_sheets: DecimalCountSchema,
      max_fields_per_sheet: DecimalCountSchema,
      max_records_per_sheet: DecimalCountSchema,
    }),
  ),
  plan_binding: z
    .object({
      plan_record: RecordIdStringSchema.nullable(),
      plan_key: z.string().nullable(),
      max_sheets: DecimalCountSchema.nullable(),
      max_fields_per_sheet: DecimalCountSchema.nullable(),
      max_records_per_sheet: DecimalCountSchema.nullable(),
    })
    .nullable(),
  counters: z.object({
    sheet_count: DecimalCountSchema.nullable(),
    per_sheet_records: z.array(
      z.object({
        sheet: RecordIdStringSchema,
        table: z.string().nullable(),
        record_count: DecimalCountSchema,
      }),
    ),
  }),
  event_targets: z.array(
    z.object({
      table: z.string().min(1),
      event_present: z.boolean(),
    }),
  ),
});
export type QuotaMigrationLegacyEvidence = z.infer<
  typeof QuotaMigrationLegacyEvidenceSchema
>;

export const QuotaMigrationTargetPreviewSchema = z.object({
  plan_revision: RecordIdStringSchema,
  source: z.enum(["manual", "contract"]),
  policy_digest: ChecksumSchema,
  rules: z.array(
    z.object({
      rule_id: z.string().min(1),
      resource: z.enum(["table", "field", "record"]),
      selector: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("exact"), table: z.string().min(1) }),
        z.object({ kind: z.literal("regex"), pattern: z.string() }),
      ]),
      limit: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("finite"),
          value: DecimalCountSchema,
        }),
        z.object({ kind: z.literal("unlimited") }),
      ]),
    }),
  ),
  overage: z.array(
    z.object({
      resource: z.enum(["table", "field", "record"]),
      table: z.string().nullable(),
      used: DecimalCountSchema,
      limit: DecimalCountSchema,
      over_by: DecimalCountSchema,
    }),
  ),
});
export type QuotaMigrationTargetPreview = z.infer<
  typeof QuotaMigrationTargetPreviewSchema
>;

export const QuotaMigrationInventoryWorkspaceSchema = z.object({
  workspace_id: RecordIdStringSchema,
  workspace_slug: z.string().min(1),
  database: z.string().min(1),
  workspace_status: z.enum(["active", "provisioning"]),
  legacy: QuotaMigrationLegacyEvidenceSchema.nullable(),
  physical: QuotaMigrationPhysicalScanSchema.nullable(),
  target: QuotaMigrationTargetPreviewSchema.nullable(),
  anomalies: z.array(QuotaMigrationAnomalySchema),
  checksum: ChecksumSchema,
});
export type QuotaMigrationInventoryWorkspace = z.infer<
  typeof QuotaMigrationInventoryWorkspaceSchema
>;

export const QuotaMigrationInventorySchema = z.object({
  format_version: z.literal(1),
  run_id: z.string().min(1),
  namespace: z.string().min(1),
  generated_at: IsoDateTimeSchema,
  workspaces: z.array(QuotaMigrationInventoryWorkspaceSchema),
  checksum: ChecksumSchema,
});
export type QuotaMigrationInventory = z.infer<
  typeof QuotaMigrationInventorySchema
>;

export const QuotaMigrationAssignmentSchema = z.object({
  workspace_id: RecordIdStringSchema,
  workspace_slug: z.string().min(1),
  database: z.string().min(1),
  billing_account_id: RecordIdStringSchema,
  plan_revision_id: RecordIdStringSchema,
  source: z.enum(["manual", "contract"]),
  effective_at: IsoDateTimeSchema,
  rollout_class: QuotaMigrationRolloutClassSchema,
  evidence_reference: z.string().min(1),
});
export type QuotaMigrationAssignment = z.infer<
  typeof QuotaMigrationAssignmentSchema
>;

export const QuotaMigrationAssignmentManifestSchema = z.object({
  format_version: z.literal(1),
  manifest_id: z.string().min(1),
  inventory_checksum: ChecksumSchema,
  approved_by_subject: z.string().min(1),
  approved_at: IsoDateTimeSchema,
  assignments: z.array(QuotaMigrationAssignmentSchema).min(1),
  checksum: ChecksumSchema,
});
export type QuotaMigrationAssignmentManifest = z.infer<
  typeof QuotaMigrationAssignmentManifestSchema
>;

export const QuotaMigrationMaintenanceEvidenceSchema = z.object({
  snapshot_id: z.string().min(1),
  snapshot_checksum: ChecksumSchema,
  restore_drill_completed_at: IsoDateTimeSchema,
  fork_release: z.string().min(1),
  fork_image_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  compatibility_manifest_revision: z.string().min(1),
  backend: z.string().min(1),
  backend_certification_revision: z.string().min(1),
  format_migration_completed_at: IsoDateTimeSchema,
});
export type QuotaMigrationMaintenanceEvidence = z.infer<
  typeof QuotaMigrationMaintenanceEvidenceSchema
>;

export const QUOTA_MIGRATION_BLOCKING_SIGNALS = [
  "false_negative",
  "counter_mismatch",
  "ledger_corrupt",
  "structured_error_lost",
  "unknown_drift",
  "cross_workspace_leak",
  "recovery_failed",
] as const;

export const QuotaMigrationSignalSchema = z.object({
  kind: z.enum([
    ...QUOTA_MIGRATION_BLOCKING_SIGNALS,
    "unexpected_denial",
    "performance_regression",
  ]),
  workspace_id: RecordIdStringSchema.optional(),
  details: z.record(z.string(), z.unknown()).default({}),
  observed_at: IsoDateTimeSchema,
});
export type QuotaMigrationSignal = z.infer<
  typeof QuotaMigrationSignalSchema
>;
