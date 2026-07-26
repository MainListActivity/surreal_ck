import { describe, expect, test } from "bun:test";
import { parseRpcError } from "surrealdb";
import {
  createNativeQuotaCompatibilityManifest,
  extractNativeQuotaError,
  NativeQuotaInfoSchema,
  NativeQuotaOperationResultSchema,
  validateNativeQuotaCapability,
} from ".";

function compatibleCapability() {
  return {
    format_version: 1,
    manifest_revision: "native-quota-v1.0",
    fork: {
      id: "mainlistactivity/surrealdb-native-quota",
      release: "3.3.0-native-quota.1",
    },
    build: {
      engine_version: "3.3.0",
      git_sha: "0123456789abcdef",
    },
    quota: {
      name: "native-quota-v1",
      contract_major: 1,
      resources: ["table", "field", "record"],
    },
    info: { format_version: 1 },
    error: { format_version: 1, wire_code: -32010 },
    storage: {
      format_version: 1,
      backend: "rocksdb",
      storage_version: 32771,
      state: "ready",
      ready: true,
      migration_required: false,
      marker: {
        format_revision: 1,
        fork_id: "mainlistactivity/surrealdb-native-quota",
        upstream_storage_major: 3,
        quota_policy_format_revision: 1,
        quota_usage_format_revision: 1,
        minimum_compatible_fork_release: "3.3.0-native-quota.1",
        migration_state: "clean",
      },
    },
    catalog: { format_revision: 1 },
    usage: { format_revision: 1 },
    backend: {
      name: "rocksdb",
      hard_quota_certified: true,
      production: true,
      persistent_restart_certified: true,
      certification_revision: "native-quota-contract-v1",
      contract_suite: [
        "transaction-contention",
        "conflict-retry",
        "multi-node",
        "atomic-fault-injection",
        "commit-outcome-unknown",
        "policy-generation-race",
        "rebuild-epoch",
        "persistent-restart",
      ],
      network_fault_model: "not-applicable-embedded",
    },
    cli: {
      release: "3.3.0-native-quota.1",
      requires_exact_release_for_destructive_operations: true,
    },
  };
}

describe("native quota capability contract", () => {
  test("accepts the pinned fork contract", () => {
    const result = validateNativeQuotaCapability(compatibleCapability(), {
      production: true,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects an unknown capability document major", () => {
    const result = validateNativeQuotaCapability(
      { ...compatibleCapability(), format_version: 2 },
      { production: true },
    );
    expect(result).toMatchObject({
      ok: false,
      code: "unsupported_capability_major",
    });
  });

  test("rejects missing required fields", () => {
    const fixture = compatibleCapability();
    Reflect.deleteProperty(fixture, "error");
    const result = validateNativeQuotaCapability(fixture, { production: true });
    expect(result).toMatchObject({ ok: false, code: "invalid_document" });
  });

  test("rejects a vanilla SurrealDB response", () => {
    const result = validateNativeQuotaCapability(
      { version: "surrealdb-3.3.0" },
      { production: true },
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_document" });
  });

  test("associates app, image digest, SDK/CLI, contracts, formats and backend", () => {
    const validated = validateNativeQuotaCapability(compatibleCapability(), {
      production: true,
    });
    if (!validated.ok) throw new Error("fixture should be compatible");

    const manifest = createNativeQuotaCompatibilityManifest({
      appRelease: "0.1.0",
      forkImageDigest: `sha256:${"a".repeat(64)}`,
      capability: validated.capability,
    });

    expect(manifest).toMatchObject({
      app_release: "0.1.0",
      fork_image: {
        repository: "ghcr.io/mainlistactivity/surrealdb-native-quota",
        digest: `sha256:${"a".repeat(64)}`,
      },
      sdk: { package: "surrealdb", version: "2.0.8" },
      cli: { release: "3.3.0-native-quota.1" },
      contracts: { quota_major: 1, error_wire_code: -32010 },
      formats: { fork_storage_major: 32771, quota_catalog: 1, quota_usage: 1 },
      backend: { name: "rocksdb", certification_revision: "native-quota-contract-v1" },
    });
  });
});

describe("native quota structured errors", () => {
  const envelope = {
    code: "quota_exceeded",
    retryable: false,
    details: {
      database: "ws_demo",
      generation: 3,
      truncated: false,
      violations: [
        {
          resource: "record",
          table: "ent_case",
          rule_ids: ["ent_records"],
          limit: 2,
          current: 2,
          delta: 1,
          projected: 3,
          over_by: 1,
        },
      ],
    },
  };

  test("preserves an HTTP/RPC ServerError without parsing message text", () => {
    const error = parseRpcError({
      code: -32010,
      kind: "Quota",
      message: "this text is deliberately irrelevant",
      details: envelope,
    });
    expect(extractNativeQuotaError(error)).toEqual(envelope);
  });

  test("preserves a WebSocket query-result error without parsing message text", () => {
    const queryResult = {
      status: "ERR",
      time: "10µs",
      result: "a different irrelevant message",
      kind: "Quota",
      details: envelope,
    };
    expect(extractNativeQuotaError(queryResult)).toEqual(envelope);
  });
});

describe("native quota query DTOs", () => {
  test("parses exact/regex field, record and table rules from INFO STRUCTURE", () => {
    const info = NativeQuotaInfoSchema.parse({
      database: "ws_demo",
      format_version: 1,
      latest_change: null,
      ledger: { active_epoch: 1, state: "ready", usage_trusted: true },
      observed_at: "2026-07-25T12:00:00.000Z",
      policy: {
        generation: 1,
        rules: [
          {
            rule_id: "ent_fields",
            resource: "field",
            selector: { kind: "regex", pattern: "^ent_" },
            limit: { kind: "finite", value: 20 },
          },
          {
            rule_id: "ent_records",
            resource: "record",
            selector: { kind: "exact", table: "ent_case" },
            limit: { kind: "finite", value: 10_000n },
          },
          {
            rule_id: "ent_tables",
            resource: "table",
            selector: { kind: "regex", pattern: "^ent_" },
            limit: { kind: "finite", value: 5 },
          },
        ],
      },
      usage: {
        table_buckets: [],
        tables: [],
        unmatched: { table: [], field: [], record: [] },
      },
    });

    expect(info.policy?.rules.map((rule) => rule.resource)).toEqual([
      "field",
      "record",
      "table",
    ]);
    expect(info.policy?.rules[1]?.limit).toEqual({
      kind: "finite",
      value: 10_000n,
    });
  });

  test("parses policy and rebuild operation result variants", () => {
    expect(
      NativeQuotaOperationResultSchema.parse({
        format_version: 1,
        operation_id: "op-define",
        operation: "define_quota",
        database: "ws_demo",
        changed: true,
        before: {
          active_epoch: 1,
          generation: null,
          ledger_state: "ready",
        },
        after: {
          active_epoch: 1,
          generation: 1,
          ledger_state: "ready",
        },
      }).operation,
    ).toBe("define_quota");

    const rebuild = NativeQuotaOperationResultSchema.parse({
      format_version: 1,
      operation_id: "op-rebuild",
      operation: "rebuild_quota",
      database: "ws_demo",
      changed: true,
      before: {
        active_epoch: 1,
        generation: 1,
        ledger_state: "rebuilding",
      },
      after: {
        active_epoch: 2,
        generation: 1,
        ledger_state: "ready",
      },
      duration_ms: 12,
      scanned: { table: 3, field: 12, record: 100 },
    });
    expect(rebuild).toMatchObject({
      operation: "rebuild_quota",
      scanned: { table: 3, field: 12, record: 100 },
    });
  });
});
