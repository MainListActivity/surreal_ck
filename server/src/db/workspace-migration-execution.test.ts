import { describe, expect, test } from "bun:test";
import { materializeWorkspaceMigrationSql } from "./workspace-migration-execution";

describe("materializeWorkspaceMigrationSql", () => {
  test("builds one explicit transaction for every dynamic legacy guard", async () => {
    const sql = await materializeWorkspaceMigrationSql(
      {
        async query() {
          return [["ent_beta", "ent_alpha", "ent_alpha"]];
        },
      },
      {
        version: 21,
        name: "021-legacy-quota-cleanup.surql",
        sql: "-- marker",
      },
    );

    expect(sql).toContain("BEGIN TRANSACTION");
    expect(sql).toContain(
      "REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE ent_alpha",
    );
    expect(sql).toContain(
      "REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE ent_beta",
    );
    expect(sql).toContain("REMOVE TABLE IF EXISTS workspace_resource_quota");
    expect(sql).toContain("COMMIT TRANSACTION");
  });

  test("fails before cleanup when a persisted table name is not a safe entity identifier", async () => {
    await expect(
      materializeWorkspaceMigrationSql(
        {
          async query() {
            return [["ent_ok", "sheet; REMOVE DATABASE main"]];
          },
        },
        {
          version: 21,
          name: "021-legacy-quota-cleanup.surql",
          sql: "-- marker",
        },
      ),
    ).rejects.toThrow("invalid legacy quota entity table name");
  });
});
