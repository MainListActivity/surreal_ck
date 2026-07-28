import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";

const migrationsDirectoryUrl = new URL("../../sql/system/", import.meta.url);

const quotaTables = [
  "billing_account",
  "billing_account_member",
  "quota_plan",
  "quota_plan_revision",
  "quota_subscription",
  "quota_subscription_item",
  "quota_override_revision",
  "workspace_quota_override",
  "resource_entitlement",
  "quota_policy_projection",
  "entitlement_operation",
  "quota_materialization_operation",
  "quota_materialization_attempt",
  "workspace_quota_runtime",
  "quota_sweep_cursor",
  "provider_event_inbox",
  "provider_event_state",
  "platform_operator",
  "platform_operator_capability",
  "quota_operator_intent",
  "quota_operator_intent_state",
  "quota_audit_event",
  "quota_alert_state",
  "quota_notification_outbox",
  "quota_notification_delivery",
] as const;

const immutableTables = [
  "quota_plan_revision",
  "quota_override_revision",
  "resource_entitlement",
  "quota_policy_projection",
  "entitlement_operation",
  "quota_materialization_attempt",
  "provider_event_inbox",
  "quota_operator_intent",
  "quota_audit_event",
  "quota_notification_outbox",
] as const;

function tableDefinition(sql: string, table: string): string {
  const match = sql.match(
    new RegExp(`DEFINE TABLE IF NOT EXISTS ${table}\\b[\\s\\S]*?;`, "u"),
  );
  if (!match) throw new Error(`missing table definition: ${table}`);
  return match[0];
}

describe("_system native quota control-plane schema", () => {
  test("system migrations are continuous through the quota control plane", async () => {
    const entries = await readdir(migrationsDirectoryUrl);
    const versions = entries
      .filter((entry) => /^\d{3}-.+\.surql$/u.test(entry))
      .map((entry) => Number(entry.slice(0, 3)))
      .sort((left, right) => left - right);

    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test("every quota control-plane table is root-only", async () => {
    const sql = await Promise.all(
      [4, 5, 6, 11].map(async (version) => {
        const entries = await readdir(migrationsDirectoryUrl);
        const name = entries.find((entry) => entry.startsWith(`${String(version).padStart(3, "0")}-`));
        if (!name) throw new Error(`missing migration ${version}`);
        return await readFile(new URL(name, migrationsDirectoryUrl), "utf8");
      }),
    ).then((parts) => parts.join("\n"));

    for (const table of quotaTables) {
      expect(tableDefinition(sql, table)).toMatch(/\bPERMISSIONS\s+NONE\b/u);
    }
  });

  test("revision and audit records are append-only", async () => {
    const sql = await Promise.all([
      readFile(new URL("004-quota-commercial-authority.surql", migrationsDirectoryUrl), "utf8"),
      readFile(new URL("005-quota-entitlement-reconciliation.surql", migrationsDirectoryUrl), "utf8"),
      readFile(new URL("006-quota-operations-observability.surql", migrationsDirectoryUrl), "utf8"),
    ]).then((parts) => parts.join("\n"));

    for (const table of immutableTables) {
      expect(sql).toContain(`DEFINE EVENT IF NOT EXISTS ${table}_immutable ON TABLE ${table}`);
      expect(sql).toMatch(
        new RegExp(
          `DEFINE EVENT IF NOT EXISTS ${table}_immutable ON TABLE ${table}[\\s\\S]*?\\$event = "UPDATE"[\\s\\S]*?\\$event = "DELETE"`,
          "u",
        ),
      );
    }
  });

  test("subscription, override, provider and operation uniqueness is encoded in indexes", async () => {
    const sql = await Promise.all([
      readFile(new URL("004-quota-commercial-authority.surql", migrationsDirectoryUrl), "utf8"),
      readFile(new URL("005-quota-entitlement-reconciliation.surql", migrationsDirectoryUrl), "utf8"),
      readFile(new URL("006-quota-operations-observability.surql", migrationsDirectoryUrl), "utf8"),
    ]).then((parts) => parts.join("\n"));

    expect(sql).toMatch(
      /quota_subscription_item_active_workspace_unique[\s\S]*?COLUMNS active_workspace\s+UNIQUE/u,
    );
    expect(sql).toMatch(
      /workspace_quota_override_workspace_unique[\s\S]*?COLUMNS workspace\s+UNIQUE/u,
    );
    expect(sql).toMatch(
      /quota_plan_revision_unique[\s\S]*?COLUMNS plan, revision\s+UNIQUE/u,
    );
    expect(sql).toMatch(
      /provider_event_inbox_unique[\s\S]*?COLUMNS provider, event_id\s+UNIQUE/u,
    );
    expect(sql).toMatch(
      /entitlement_operation_idempotency_unique[\s\S]*?COLUMNS idempotency_key\s+UNIQUE/u,
    );
    expect(sql).toMatch(
      /quota_operator_intent_request_unique[\s\S]*?COLUMNS request_id\s+UNIQUE/u,
    );
    const lifecycleSql = await readFile(
      new URL("011-quota-lifecycle-intent-processing.surql", migrationsDirectoryUrl),
      "utf8",
    );
    expect(lifecycleSql).toMatch(
      /quota_subscription_item_scheduled_workspace_unique[\s\S]*?COLUMNS scheduled_workspace UNIQUE/u,
    );
    expect(lifecycleSql).toMatch(
      /quota_operator_intent_state_intent_unique[\s\S]*?COLUMNS intent UNIQUE/u,
    );
  });

  test("exact and regex selectors remain typed wildcard fields", async () => {
    const commercialSql = await readFile(
      new URL("004-quota-commercial-authority.surql", migrationsDirectoryUrl),
      "utf8",
    );
    const reconciliationSql = await readFile(
      new URL("005-quota-entitlement-reconciliation.surql", migrationsDirectoryUrl),
      "utf8",
    );
    const projectionUpgradeSql = await readFile(
      new URL("007-quota-projection-rule-labels.surql", migrationsDirectoryUrl),
      "utf8",
    );
    const recoverySql = await readFile(
      new URL("008-quota-reconciliation-recovery.surql", migrationsDirectoryUrl),
      "utf8",
    );

    expect(commercialSql).toContain("rules.*.selector.kind ON TABLE quota_plan_revision");
    expect(commercialSql).toContain("patches.*.selector.kind ON TABLE quota_override_revision");
    expect(reconciliationSql).toContain("rules.*.selector.kind ON TABLE resource_entitlement");
    expect(reconciliationSql).toContain("rules.*.selector.kind ON TABLE quota_policy_projection");
    expect(projectionUpgradeSql).toContain(
      "rules.*.selector.pattern ON TABLE quota_policy_projection",
    );
    expect(projectionUpgradeSql).toContain(
      "rules.*.selector.table ON TABLE quota_policy_projection",
    );
    expect(projectionUpgradeSql).toContain(
      "REMOVE FIELD IF EXISTS rules.*.selector.value ON TABLE quota_policy_projection",
    );
    expect(projectionUpgradeSql).toContain(
      "REMOVE FIELD IF EXISTS rules.*.rule_key ON TABLE quota_policy_projection",
    );
    expect(commercialSql).toContain('$value INSIDE ["exact", "regex"]');
    expect(recoverySql).toContain(
      'ASSERT $value INSIDE ["normal", "drift_reapply"]',
    );
    expect(recoverySql).toContain(
      "next_attempt_at ON TABLE quota_sweep_cursor",
    );
  });

  test("operator authority and causation are independent from workspace administration", async () => {
    const reconciliationSql = await readFile(
      new URL("005-quota-entitlement-reconciliation.surql", migrationsDirectoryUrl),
      "utf8",
    );
    const operationsSql = await readFile(
      new URL("006-quota-operations-observability.surql", migrationsDirectoryUrl),
      "utf8",
    );

    expect(operationsSql).toContain("DEFINE TABLE IF NOT EXISTS platform_operator ");
    expect(operationsSql).toContain("DEFINE TABLE IF NOT EXISTS platform_operator_capability ");
    expect(operationsSql).not.toContain("record<system_admin>");
    expect(operationsSql).not.toContain("record<workspace_member>");
    expect(reconciliationSql).toContain(
      "DEFINE FIELD IF NOT EXISTS causation_id ON TABLE entitlement_operation",
    );
    expect(reconciliationSql).toContain(
      "DEFINE FIELD IF NOT EXISTS causation_id ON TABLE quota_materialization_attempt",
    );
    expect(operationsSql).toContain(
      "DEFINE FIELD IF NOT EXISTS causation_id ON TABLE quota_audit_event",
    );
  });
});
