import { describe, expect, test } from "bun:test";
import { SurrealNativeQuotaClient } from "./client";

function readyInfo(database: string) {
  return {
    database,
    format_version: 1,
    latest_change: null,
    ledger: {
      active_epoch: 1,
      state: "ready",
      usage_trusted: true,
    },
    observed_at: "2026-07-25T12:00:00.000Z",
    policy: null,
    usage: {
      table_buckets: [],
      tables: [],
      unmatched: { table: [], field: [], record: [] },
    },
  };
}

function policyResult(database: string, generation: number) {
  return {
    format_version: 1,
    operation_id: `quota-op-${generation}`,
    operation: generation === 1 ? "define_quota" : "alter_quota",
    database,
    changed: true,
    before: {
      active_epoch: 1,
      ...(generation === 1 ? {} : { generation: generation - 1 }),
      ledger_state: "ready",
    },
    after: {
      active_epoch: 1,
      generation,
      ledger_state: "ready",
    },
  };
}

function rebuildResult(database: string) {
  return {
    format_version: 1,
    operation_id: "quota-rebuild-1",
    operation: "rebuild_quota",
    database,
    changed: false,
    before: {
      active_epoch: 1,
      generation: 2,
      ledger_state: "ready",
    },
    after: {
      active_epoch: 1,
      generation: 2,
      ledger_state: "ready",
    },
    duration_ms: 0,
    scanned: { table: 0, field: 0, record: 0 },
  };
}

describe("SurrealNativeQuotaClient", () => {
  test("keeps quota grammar inside the adapter and returns a typed INFO DTO", async () => {
    const queries: string[] = [];
    const wireInfoWithoutNone: Partial<ReturnType<typeof readyInfo>> =
      structuredClone(readyInfo("_system"));
    delete wireInfoWithoutNone.latest_change;
    delete wireInfoWithoutNone.policy;
    const client = new SurrealNativeQuotaClient({
      async query(sql) {
        queries.push(sql);
        return [wireInfoWithoutNone];
      },
    });

    await expect(client.info("_system")).resolves.toEqual(readyInfo("_system"));
    expect(queries).toEqual([
      "INFO FOR QUOTA ON DATABASE _system STRUCTURE;",
    ]);
  });

  test("rejects database identifiers before constructing SurrealQL", async () => {
    const client = new SurrealNativeQuotaClient({
      async query() {
        throw new Error("must not query");
      },
    });

    await expect(client.info("ws_demo; REMOVE DATABASE _system")).rejects.toThrow(
      "Invalid native quota database identifier",
    );
  });

  test("defines and generation-overwrites a complete typed policy", async () => {
    const queries: string[] = [];
    const responses = [
      policyResult("ws_demo", 1),
      policyResult("ws_demo", 2),
    ];
    const client = new SurrealNativeQuotaClient({
      async query(sql) {
        queries.push(sql);
        return [responses.shift()];
      },
    });
    const rules = [
      {
        rule_id: "record/default",
        resource: "record" as const,
        selector: { kind: "regex" as const, pattern: "^ent_/.+$" },
        limit: { kind: "finite" as const, value: 100n },
      },
      {
        rule_id: "system",
        resource: "field" as const,
        selector: { kind: "exact" as const, table: "order`line" },
        limit: { kind: "unlimited" as const },
      },
    ];

    await expect(client.applyPolicy({
      database: "ws_demo",
      rules,
    })).resolves.toMatchObject({
      operation: "define_quota",
      before: { generation: null },
    });
    await expect(client.applyPolicy({
      database: "ws_demo",
      rules,
      expectedGeneration: 1,
    })).resolves.toMatchObject({ operation: "alter_quota" });

    expect(queries).toEqual([
      "DEFINE QUOTA ON DATABASE ws_demo RULE `record/default` FOR RECORD MATCH REGEX /^ent_\\/.+$/ LIMIT 100 RULE `system` FOR FIELD MATCH EXACT `order\\`line` LIMIT UNLIMITED;",
      "DEFINE QUOTA OVERWRITE ON DATABASE ws_demo EXPECT GENERATION 1 RULE `record/default` FOR RECORD MATCH REGEX /^ent_\\/.+$/ LIMIT 100 RULE `system` FOR FIELD MATCH EXACT `order\\`line` LIMIT UNLIMITED;",
    ]);
  });

  test("rebuilds only when needed and validates the operation result", async () => {
    const queries: string[] = [];
    const client = new SurrealNativeQuotaClient({
      async query(sql) {
        queries.push(sql);
        return [rebuildResult("ws_demo")];
      },
    });

    await expect(client.rebuild("ws_demo")).resolves.toMatchObject({
      operation: "rebuild_quota",
      changed: false,
    });
    expect(queries).toEqual([
      "REBUILD QUOTA IF NEEDED ON DATABASE ws_demo;",
    ]);
  });

  test("reasserts the same generation and removes every legacy event atomically", async () => {
    const queries: string[] = [];
    const client = new SurrealNativeQuotaClient({
      async query(sql) {
        queries.push(sql);
        if (sql.startsWith("RETURN")) return [true];
        return [
          [],
          [policyResult("ws_demo", 2)],
          [],
          [],
          [],
        ];
      },
    });
    const rules = [{
      rule_id: "records",
      resource: "record" as const,
      selector: { kind: "regex" as const, pattern: "^ent_" },
      limit: { kind: "finite" as const, value: 10 },
    }];

    await expect(client.readLegacyQuotaEvents(
      "ws_demo",
      ["sheet", "ent_case"],
    )).resolves.toEqual(new Map([
      ["ent_case", true],
      ["sheet", true],
    ]));
    await expect(client.cutoverLegacyQuotaEvents({
      database: "ws_demo",
      rules,
      expectedGeneration: 1,
      legacyEventTables: ["sheet", "ent_case", "ent_case"],
    })).resolves.toMatchObject({ operation: "alter_quota" });

    expect(queries.at(-1)).toContain("BEGIN TRANSACTION;");
    expect(queries.at(-1)).toContain(
      "DEFINE QUOTA OVERWRITE ON DATABASE ws_demo EXPECT GENERATION 1",
    );
    expect(queries.at(-1)).toContain(
      "REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE `ent_case`;",
    );
    expect(queries.at(-1)).toContain(
      "REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE `sheet`;",
    );
    expect(queries.at(-1)).toMatch(/COMMIT TRANSACTION;$/u);
  });

  test("rejects unsafe legacy event identifiers before the cutover transaction", async () => {
    const client = new SurrealNativeQuotaClient({
      async query() {
        throw new Error("must not query");
      },
    });
    await expect(client.cutoverLegacyQuotaEvents({
      database: "ws_demo",
      rules: [{
        rule_id: "records",
        resource: "record",
        selector: { kind: "regex", pattern: "^ent_" },
        limit: { kind: "unlimited" },
      }],
      expectedGeneration: 1,
      legacyEventTables: ["ent_ok; REMOVE DATABASE ws_demo"],
    })).rejects.toThrow("Invalid legacy quota event table identifier");
  });

  test("rejects empty policies and unsafe numeric guards before querying", async () => {
    const client = new SurrealNativeQuotaClient({
      async query() {
        throw new Error("must not query");
      },
    });

    await expect(client.applyPolicy({
      database: "ws_demo",
      rules: [],
    })).rejects.toThrow("at least one rule");
    await expect(client.applyPolicy({
      database: "ws_demo",
      rules: [{
        rule_id: "records",
        resource: "record",
        selector: { kind: "regex", pattern: ".*" },
        limit: { kind: "unlimited" },
      }],
      expectedGeneration: -1,
    })).rejects.toThrow("outside the native unsigned integer range");
  });

  test("preserves structured SDK quota errors without message parsing", async () => {
    const structured = Object.assign(new Error("unstable wording"), {
      kind: "Quota",
      details: {
        code: "quota_generation_mismatch",
        retryable: false,
        details: { expected: 1, actual: 2 },
      },
    });
    const client = new SurrealNativeQuotaClient({
      async query() {
        throw structured;
      },
    });

    await expect(client.applyPolicy({
      database: "ws_demo",
      rules: [{
        rule_id: "records",
        resource: "record",
        selector: { kind: "regex", pattern: ".*" },
        limit: { kind: "unlimited" },
      }],
      expectedGeneration: 1,
    })).rejects.toBe(structured);
  });
});
