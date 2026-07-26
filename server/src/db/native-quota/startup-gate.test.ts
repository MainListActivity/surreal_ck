import { describe, expect, test } from "bun:test";
import {
  NativeQuotaStartupGateError,
  nativeQuotaProbeUrls,
  probeNativeQuotaHttp,
  verifyNativeQuotaRootHandshake,
} from "./startup-gate";

function compatibleCapability() {
  return {
    format_version: 1,
    manifest_revision: "native-quota-v1.0",
    fork: {
      id: "mainlistactivity/surrealdb-native-quota",
      release: "3.3.0-native-quota.1",
    },
    build: { engine_version: "3.3.0", git_sha: "abcdef" },
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

function readyInfo(database = "_system") {
  return {
    database,
    format_version: 1,
    latest_change: null,
    ledger: { active_epoch: 1, state: "ready" as const, usage_trusted: true },
    observed_at: "2026-07-25T12:00:00.000Z",
    policy: null,
    usage: {
      table_buckets: [],
      tables: [],
      unmatched: { table: [], field: [], record: [] },
    },
  };
}

describe("native quota startup gate", () => {
  test("derives HTTP probe URLs from the WebSocket RPC URL", () => {
    const urls = nativeQuotaProbeUrls("wss://db.example.test/surreal/rpc");
    expect(urls.capability.toString()).toBe(
      "https://db.example.test/surreal/capabilities",
    );
    expect(urls.readiness.toString()).toBe(
      "https://db.example.test/surreal/ready?require=native-quota-v1",
    );
  });

  test("validates capability before required-capability readiness", async () => {
    const requests: string[] = [];
    const capability = await probeNativeQuotaHttp({
      surrealUrl: "ws://db.example.test:8000/rpc",
      production: true,
      fetcher: (async (input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        return url.includes("/capabilities")
          ? Response.json(compatibleCapability())
          : new Response(null, { status: 200 });
      }) as typeof fetch,
    });

    expect(capability.fork.id).toBe(
      "mainlistactivity/surrealdb-native-quota",
    );
    expect(requests).toEqual([
      "http://db.example.test:8000/capabilities",
      "http://db.example.test:8000/ready?require=native-quota-v1",
    ]);
  });

  test("does not call readiness for an incompatible capability", async () => {
    const requests: string[] = [];
    await expect(
      probeNativeQuotaHttp({
        surrealUrl: "ws://db.example.test:8000/rpc",
        production: true,
        fetcher: (async (input: string | URL | Request) => {
          requests.push(String(input));
          return Response.json({ version: "surrealdb-3.3.0" });
        }) as typeof fetch,
      }),
    ).rejects.toMatchObject({
      stage: "capability",
      diagnosticCode: "invalid_document",
    });
    expect(requests).toHaveLength(1);
  });

  test("requires a ready and trusted _system INFO ledger", async () => {
    await expect(
      verifyNativeQuotaRootHandshake({
        client: { async info() { return readyInfo(); } },
      }),
    ).resolves.toEqual(readyInfo());

    await expect(
      verifyNativeQuotaRootHandshake({
        client: {
          async info() {
            return {
              ...readyInfo(),
              ledger: {
                active_epoch: null,
                state: "rebuilding",
                usage_trusted: false,
              },
              usage: null,
            };
          },
        },
      }),
    ).rejects.toBeInstanceOf(NativeQuotaStartupGateError);
  });
});
