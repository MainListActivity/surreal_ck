import { z } from "zod";
import {
  NativeQuotaCapabilityDocumentSchema,
  type NativeQuotaCapabilityDocument,
} from "./contracts";

export const NATIVE_QUOTA_EXPECTED_CONTRACT = {
  capabilityFormatVersion: 1,
  manifestRevision: "native-quota-v1.0",
  forkId: "mainlistactivity/surrealdb-native-quota",
  forkRelease: "3.3.0-native-quota.1",
  capabilityName: "native-quota-v1",
  quotaContractMajor: 1,
  infoFormatVersion: 1,
  errorFormatVersion: 1,
  errorWireCode: -32010,
  storageStatusFormatVersion: 1,
  storageMarkerFormatRevision: 1,
  upstreamStorageMajor: 3,
  forkStorageMajor: 32771,
  quotaCatalogFormatRevision: 1,
  quotaUsageFormatRevision: 1,
  cliRelease: "3.3.0-native-quota.1",
  surrealDbJsVersion: "2.0.8",
  imageRepository: "ghcr.io/mainlistactivity/surrealdb-native-quota",
  backendCertificationRevision: "native-quota-contract-v1",
  productionBackends: ["rocksdb"],
  requiredBackendContracts: [
    "transaction-contention",
    "conflict-retry",
    "multi-node",
    "atomic-fault-injection",
    "commit-outcome-unknown",
    "policy-generation-race",
    "rebuild-epoch",
  ],
} as const;

const REQUIRED_RESOURCES = ["table", "field", "record"] as const;

export type NativeQuotaCapabilityDiagnosticCode =
  | "invalid_document"
  | "unsupported_capability_major"
  | "incompatible_fork"
  | "incompatible_contract"
  | "storage_not_ready"
  | "uncertified_backend";

export type NativeQuotaCapabilityValidation =
  | { ok: true; capability: NativeQuotaCapabilityDocument }
  | {
      ok: false;
      code: NativeQuotaCapabilityDiagnosticCode;
      issues: string[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 校验 server 的公开 capability 文档。已知 major 内允许新增字段，但任何会改变
 * quota 语义、datastore 格式或发布身份的值都必须精确匹配。
 */
export function validateNativeQuotaCapability(
  input: unknown,
  options: { production: boolean },
): NativeQuotaCapabilityValidation {
  if (
    isRecord(input)
    && "format_version" in input
    && input.format_version !== NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityFormatVersion
  ) {
    return {
      ok: false,
      code: "unsupported_capability_major",
      issues: [`format_version=${String(input.format_version)}`],
    };
  }

  const parsed = NativeQuotaCapabilityDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_document",
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }

  const capability = parsed.data;
  const expected = NATIVE_QUOTA_EXPECTED_CONTRACT;
  const forkIssues = [
    capability.manifest_revision === expected.manifestRevision
      ? null
      : `manifest_revision=${capability.manifest_revision}`,
    capability.fork.id === expected.forkId ? null : `fork.id=${capability.fork.id}`,
    capability.fork.release === expected.forkRelease ? null : `fork.release=${capability.fork.release}`,
    capability.cli.release === expected.cliRelease ? null : `cli.release=${capability.cli.release}`,
    capability.cli.requires_exact_release_for_destructive_operations
      ? null
      : "cli.requires_exact_release_for_destructive_operations=false",
  ].filter((issue): issue is string => issue !== null);
  if (forkIssues.length > 0) {
    return { ok: false, code: "incompatible_fork", issues: forkIssues };
  }

  const contractIssues = [
    capability.quota.name === expected.capabilityName ? null : `quota.name=${capability.quota.name}`,
    capability.quota.contract_major === expected.quotaContractMajor
      ? null
      : `quota.contract_major=${capability.quota.contract_major}`,
    capability.info.format_version === expected.infoFormatVersion
      ? null
      : `info.format_version=${capability.info.format_version}`,
    capability.error.format_version === expected.errorFormatVersion
      ? null
      : `error.format_version=${capability.error.format_version}`,
    capability.error.wire_code === expected.errorWireCode
      ? null
      : `error.wire_code=${capability.error.wire_code}`,
    capability.storage.format_version === expected.storageStatusFormatVersion
      ? null
      : `storage.format_version=${capability.storage.format_version}`,
    capability.catalog.format_revision === expected.quotaCatalogFormatRevision
      ? null
      : `catalog.format_revision=${capability.catalog.format_revision}`,
    capability.usage.format_revision === expected.quotaUsageFormatRevision
      ? null
      : `usage.format_revision=${capability.usage.format_revision}`,
    ...REQUIRED_RESOURCES.map((resource) =>
      capability.quota.resources.includes(resource) ? null : `quota.resources missing ${resource}`,
    ),
  ].filter((issue): issue is string => issue !== null);
  if (contractIssues.length > 0) {
    return { ok: false, code: "incompatible_contract", issues: contractIssues };
  }

  const marker = capability.storage.marker;
  const storageIssues = [
    capability.storage.ready ? null : "storage.ready=false",
    capability.storage.state === "ready" ? null : `storage.state=${capability.storage.state}`,
    capability.storage.migration_required ? "storage.migration_required=true" : null,
    marker === null ? "storage.marker missing" : null,
    marker?.format_revision === expected.storageMarkerFormatRevision
      ? null
      : `storage.marker.format_revision=${String(marker?.format_revision)}`,
    marker?.fork_id === expected.forkId ? null : `storage.marker.fork_id=${String(marker?.fork_id)}`,
    marker?.upstream_storage_major === expected.upstreamStorageMajor
      ? null
      : `storage.marker.upstream_storage_major=${String(marker?.upstream_storage_major)}`,
    capability.storage.storage_version === expected.forkStorageMajor
      ? null
      : `storage.storage_version=${String(capability.storage.storage_version)}`,
    marker?.quota_policy_format_revision === expected.quotaCatalogFormatRevision
      ? null
      : `storage.marker.quota_policy_format_revision=${String(marker?.quota_policy_format_revision)}`,
    marker?.quota_usage_format_revision === expected.quotaUsageFormatRevision
      ? null
      : `storage.marker.quota_usage_format_revision=${String(marker?.quota_usage_format_revision)}`,
    marker?.minimum_compatible_fork_release === expected.forkRelease
      ? null
      : `storage.marker.minimum_compatible_fork_release=${String(marker?.minimum_compatible_fork_release)}`,
    marker?.migration_state === "clean"
      ? null
      : `storage.marker.migration_state=${String(marker?.migration_state)}`,
  ].filter((issue): issue is string => issue !== null);
  if (storageIssues.length > 0) {
    return { ok: false, code: "storage_not_ready", issues: storageIssues };
  }

  const backendIssues = [
    capability.backend.name === capability.storage.backend
      ? null
      : `backend.name=${capability.backend.name}, storage.backend=${capability.storage.backend}`,
    capability.backend.hard_quota_certified ? null : "backend.hard_quota_certified=false",
    capability.backend.certification_revision === expected.backendCertificationRevision
      ? null
      : `backend.certification_revision=${String(capability.backend.certification_revision)}`,
    options.production
      && !(expected.productionBackends as readonly string[]).includes(capability.backend.name)
      ? `backend.name=${capability.backend.name} is not production-certified`
      : null,
    options.production && !capability.backend.production ? "backend.production=false" : null,
    options.production && !capability.backend.persistent_restart_certified
      ? "backend.persistent_restart_certified=false"
      : null,
    ...(options.production
      ? expected.requiredBackendContracts.map((contract) =>
          capability.backend.contract_suite.includes(contract)
            ? null
            : `backend.contract_suite missing ${contract}`,
        )
      : []),
  ].filter((issue): issue is string => issue !== null);
  if (backendIssues.length > 0) {
    return { ok: false, code: "uncertified_backend", issues: backendIssues };
  }

  return { ok: true, capability };
}

export const NativeQuotaCompatibilityManifestSchema = z.object({
  format_version: z.literal(1),
  app_release: z.string().min(1),
  fork_image: z.object({
    repository: z.literal(NATIVE_QUOTA_EXPECTED_CONTRACT.imageRepository),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }),
  engine: z.object({
    manifest_revision: z.literal(NATIVE_QUOTA_EXPECTED_CONTRACT.manifestRevision),
    fork_id: z.literal(NATIVE_QUOTA_EXPECTED_CONTRACT.forkId),
    fork_release: z.literal(NATIVE_QUOTA_EXPECTED_CONTRACT.forkRelease),
    git_sha: z.string().min(1),
  }),
  sdk: z.object({
    package: z.literal("surrealdb"),
    version: z.literal(NATIVE_QUOTA_EXPECTED_CONTRACT.surrealDbJsVersion),
    protocols: z.tuple([z.literal("http"), z.literal("ws")]),
  }),
  cli: z.object({
    release: z.literal(NATIVE_QUOTA_EXPECTED_CONTRACT.cliRelease),
  }),
  contracts: z.object({
    quota_major: z.literal(NATIVE_QUOTA_EXPECTED_CONTRACT.quotaContractMajor),
    info_format_version: z.literal(NATIVE_QUOTA_EXPECTED_CONTRACT.infoFormatVersion),
    error_format_version: z.literal(NATIVE_QUOTA_EXPECTED_CONTRACT.errorFormatVersion),
    error_wire_code: z.literal(NATIVE_QUOTA_EXPECTED_CONTRACT.errorWireCode),
  }),
  formats: z.object({
    storage_marker: z.literal(NATIVE_QUOTA_EXPECTED_CONTRACT.storageMarkerFormatRevision),
    upstream_storage_major: z.literal(NATIVE_QUOTA_EXPECTED_CONTRACT.upstreamStorageMajor),
    fork_storage_major: z.literal(NATIVE_QUOTA_EXPECTED_CONTRACT.forkStorageMajor),
    quota_catalog: z.literal(NATIVE_QUOTA_EXPECTED_CONTRACT.quotaCatalogFormatRevision),
    quota_usage: z.literal(NATIVE_QUOTA_EXPECTED_CONTRACT.quotaUsageFormatRevision),
  }),
  backend: z.object({
    name: z.string().min(1),
    certification_revision: z.literal(NATIVE_QUOTA_EXPECTED_CONTRACT.backendCertificationRevision),
  }),
});
export type NativeQuotaCompatibilityManifest = z.infer<
  typeof NativeQuotaCompatibilityManifestSchema
>;

export function createNativeQuotaCompatibilityManifest(input: {
  appRelease: string;
  forkImageDigest: string;
  capability: NativeQuotaCapabilityDocument;
}): NativeQuotaCompatibilityManifest {
  return NativeQuotaCompatibilityManifestSchema.parse({
    format_version: 1,
    app_release: input.appRelease,
    fork_image: {
      repository: NATIVE_QUOTA_EXPECTED_CONTRACT.imageRepository,
      digest: input.forkImageDigest,
    },
    engine: {
      manifest_revision: input.capability.manifest_revision,
      fork_id: input.capability.fork.id,
      fork_release: input.capability.fork.release,
      git_sha: input.capability.build.git_sha,
    },
    sdk: {
      package: "surrealdb",
      version: NATIVE_QUOTA_EXPECTED_CONTRACT.surrealDbJsVersion,
      protocols: ["http", "ws"],
    },
    cli: {
      release: input.capability.cli.release,
    },
    contracts: {
      quota_major: input.capability.quota.contract_major,
      info_format_version: input.capability.info.format_version,
      error_format_version: input.capability.error.format_version,
      error_wire_code: input.capability.error.wire_code,
    },
    formats: {
      storage_marker: input.capability.storage.marker?.format_revision,
      upstream_storage_major: input.capability.storage.marker?.upstream_storage_major,
      fork_storage_major: input.capability.storage.storage_version,
      quota_catalog: input.capability.catalog.format_revision,
      quota_usage: input.capability.usage.format_revision,
    },
    backend: {
      name: input.capability.backend.name,
      certification_revision: input.capability.backend.certification_revision,
    },
  });
}
