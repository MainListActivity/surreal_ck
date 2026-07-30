import { z } from "zod";

const SafeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const IntSchema = z.union([SafeIntegerSchema, z.bigint()]);
const UIntSchema = z.union([
  SafeIntegerSchema.nonnegative(),
  z.bigint().nonnegative(),
]);
const NullableWireUIntSchema = UIntSchema.nullish().transform(
  (value) => value ?? null,
);

export const NativeQuotaResourceSchema = z.enum(["table", "field", "record"]);
export type NativeQuotaResource = z.infer<typeof NativeQuotaResourceSchema>;

export const NativeQuotaStorageStateSchema = z.enum([
  "empty",
  "legacy_unversioned",
  "migration_required",
  "migrating",
  "ready",
]);

export const NativeQuotaStorageMarkerSchema = z.object({
  format_revision: z.number().int().positive(),
  fork_id: z.string().min(1),
  upstream_storage_major: z.number().int().positive(),
  quota_policy_format_revision: z.number().int().positive(),
  quota_usage_format_revision: z.number().int().positive(),
  minimum_compatible_fork_release: z.string().min(1),
  migration_state: z.enum(["clean", "in_progress"]),
});

export const NativeQuotaStorageStatusSchema = z.object({
  format_version: z.number().int().positive(),
  backend: z.string().min(1),
  storage_version: UIntSchema.nullable(),
  state: NativeQuotaStorageStateSchema,
  ready: z.boolean(),
  migration_required: z.boolean(),
  marker: NativeQuotaStorageMarkerSchema.nullable(),
});

export const NativeQuotaBackendContractSchema = z.object({
  name: z.string().min(1),
  hard_quota_certified: z.boolean(),
  production: z.boolean(),
  persistent_restart_certified: z.boolean(),
  certification_revision: z.string().min(1).nullable(),
  contract_suite: z.array(z.string().min(1)),
  network_fault_model: z.string().min(1),
});

export const NativeQuotaCliManifestSchema = z.object({
  release: z.string().min(1),
  requires_exact_release_for_destructive_operations: z.boolean(),
});

export const NativeQuotaCapabilityDocumentSchema = z.object({
  format_version: z.number().int().positive(),
  manifest_revision: z.string().min(1),
  fork: z.object({
    id: z.string().min(1),
    release: z.string().min(1),
  }),
  build: z.object({
    engine_version: z.string().min(1),
    git_sha: z.string().min(1),
  }),
  quota: z.object({
    name: z.string().min(1),
    contract_major: z.number().int().positive(),
    resources: z.array(NativeQuotaResourceSchema),
  }),
  info: z.object({
    format_version: z.number().int().positive(),
  }),
  error: z.object({
    format_version: z.number().int().positive(),
    wire_code: z.number().int(),
  }),
  storage: NativeQuotaStorageStatusSchema,
  catalog: z.object({
    format_revision: z.number().int().positive(),
  }),
  usage: z.object({
    format_revision: z.number().int().positive(),
  }),
  backend: NativeQuotaBackendContractSchema,
  cli: NativeQuotaCliManifestSchema,
});
export type NativeQuotaCapabilityDocument = z.infer<typeof NativeQuotaCapabilityDocumentSchema>;

export const NativeQuotaSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), table: z.string().min(1) }),
  z.object({ kind: z.literal("regex"), pattern: z.string() }),
]);
export type NativeQuotaSelector = z.infer<typeof NativeQuotaSelectorSchema>;

export const NativeQuotaLimitSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("finite"), value: UIntSchema }),
  z.object({ kind: z.literal("unlimited") }),
]);
export type NativeQuotaLimit = z.infer<typeof NativeQuotaLimitSchema>;

export const NativeQuotaRuleSchema = z.object({
  rule_id: z.string().min(1),
  resource: NativeQuotaResourceSchema,
  selector: NativeQuotaSelectorSchema,
  limit: NativeQuotaLimitSchema,
});
export type NativeQuotaRule = z.infer<typeof NativeQuotaRuleSchema>;

const NativeQuotaEffectiveUsageSchema = z.object({
  effective_rule_ids: z.array(z.string().min(1)),
  exceeded: z.boolean(),
  limit: NativeQuotaLimitSchema,
  limit_origin: z.enum(["exact", "regex_min", "explicit_unlimited", "unmatched"]),
  matched_rule_ids: z.array(z.string().min(1)),
  remaining: NullableWireUIntSchema,
  used: UIntSchema,
});

const NativeQuotaTableBucketUsageSchema = z.object({
  exceeded: z.boolean(),
  limit: NativeQuotaLimitSchema,
  remaining: NullableWireUIntSchema,
  rule_id: z.string().min(1),
  used: UIntSchema,
});

export const NativeQuotaInfoSchema = z.object({
  database: z.string().min(1),
  format_version: z.number().int().positive(),
  latest_change: z
    .object({
      action: z.string().min(1),
      actor: z.string().min(1),
      changed_at: z.iso.datetime(),
      generation: UIntSchema,
      operation_id: z.string().min(1),
    })
    .nullish()
    .transform((value) => value ?? null),
  ledger: z.object({
    active_epoch: NullableWireUIntSchema,
    state: z.enum(["uninitialized", "rebuilding", "ready", "corrupt"]),
    usage_trusted: z.boolean(),
  }),
  observed_at: z.iso.datetime(),
  policy: z
    .object({
      generation: UIntSchema,
      rules: z.array(NativeQuotaRuleSchema),
    })
    .nullish()
    .transform((value) => value ?? null),
  usage: z
    .object({
      table_buckets: z.array(NativeQuotaTableBucketUsageSchema),
      tables: z.array(
        z.object({
          table: z.string().min(1),
          field: NativeQuotaEffectiveUsageSchema,
          record: NativeQuotaEffectiveUsageSchema,
        }),
      ),
      unmatched: z.object({
        table: z.array(z.string().min(1)),
        field: z.array(z.string().min(1)),
        record: z.array(z.string().min(1)),
      }),
    })
    .nullish()
    .transform((value) => value ?? null),
});
export type NativeQuotaInfo = z.infer<typeof NativeQuotaInfoSchema>;

export const NativeQuotaOperationStateSchema = z.object({
  active_epoch: NullableWireUIntSchema,
  generation: NullableWireUIntSchema,
  ledger_state: z.enum(["uninitialized", "rebuilding", "ready", "corrupt"]),
});

const NativeQuotaPolicyOperationResultSchema = z.object({
  format_version: z.number().int().positive(),
  operation_id: z.string().min(1),
  operation: z.enum(["define_quota", "alter_quota", "remove_quota"]),
  database: z.string().min(1),
  changed: z.boolean(),
  before: NativeQuotaOperationStateSchema,
  after: NativeQuotaOperationStateSchema,
});

const NativeQuotaRebuildOperationResultSchema = z.object({
  format_version: z.number().int().positive(),
  operation_id: z.string().min(1),
  operation: z.literal("rebuild_quota"),
  database: z.string().min(1),
  changed: z.boolean(),
  before: NativeQuotaOperationStateSchema,
  after: NativeQuotaOperationStateSchema,
  duration_ms: UIntSchema,
  scanned: z.object({
    table: UIntSchema,
    field: UIntSchema,
    record: UIntSchema,
  }),
});

export const NativeQuotaOperationResultSchema = z.discriminatedUnion("operation", [
  NativeQuotaPolicyOperationResultSchema,
  NativeQuotaRebuildOperationResultSchema,
]);
export type NativeQuotaOperationResult = z.infer<typeof NativeQuotaOperationResultSchema>;

export const NativeQuotaViolationSchema = z.object({
  resource: NativeQuotaResourceSchema,
  table: z.string().min(1),
  rule_ids: z.array(z.string().min(1)),
  limit: UIntSchema,
  current: UIntSchema,
  delta: IntSchema,
  projected: UIntSchema,
  over_by: UIntSchema,
});
export type NativeQuotaViolation = z.infer<typeof NativeQuotaViolationSchema>;

export const NativeQuotaErrorEnvelopeSchema = z.object({
  code: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()),
});
export type NativeQuotaErrorEnvelope = z.infer<typeof NativeQuotaErrorEnvelopeSchema>;
