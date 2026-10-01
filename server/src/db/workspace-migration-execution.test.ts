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

  test("skips persisted table names that are not safe identifiers instead of aborting", async () => {
    const sql = await materializeWorkspaceMigrationSql(
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
    );

    expect(sql).toContain("ON TABLE ent_ok");
    expect(sql).not.toContain("REMOVE DATABASE main");
    expect(sql).toContain("REMOVE TABLE IF EXISTS workspace_resource_quota");
  });

  test("materializes the residual guard sweep for post-cleanup entity tables", async () => {
    const sql = await materializeWorkspaceMigrationSql(
      {
        async query() {
          return [["ent_beta_main", "ent_alpha_main"]];
        },
      },
      {
        version: 39,
        name: "039-legacy-quota-guard-residual.surql",
        sql: "-- marker",
      },
    );

    expect(sql).toContain("REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE ent_alpha_main");
    expect(sql).toContain("REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE ent_beta_main");
    expect(sql).toContain("REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE sheet");
    expect(sql).not.toContain("REMOVE TABLE");
  });

  test("residual sweep covers non-ent_ sheet tables and skips unsafe names", async () => {
    const sql = await materializeWorkspaceMigrationSql(
      {
        async query() {
          return [["qa_ver03_materials", "ent_ok", "bad name; DROP TABLE x"]];
        },
      },
      { version: 39, name: "039-legacy-quota-guard-residual.surql", sql: "-- marker" },
    );

    expect(sql).toContain(
      "REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE qa_ver03_materials",
    );
    expect(sql).toContain(
      "REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE ent_ok",
    );
    expect(sql).not.toContain("bad name");
    expect(sql).not.toContain("DROP TABLE x");
  });

  test("upgrades existing dynamic tables to record update activity evidence", async () => {
    const sql = await materializeWorkspaceMigrationSql(
      { async query() { return [["ent_beta_main", "ent_alpha_main"]]; } },
      { version: 29, name: "029-record-update-activity.surql", sql: "-- marker" },
    );
    expect(sql).toContain("ON TABLE ent_alpha_main");
    expect(sql).toContain('$event = "UPDATE"');
    expect(sql).toContain('ELSE { "record.write" }');
  });

  test("activity backfill covers non-ent_ sheet tables and skips unsafe names", async () => {
    const sql = await materializeWorkspaceMigrationSql(
      { async query() { return [["qa_ver03_materials", "ent_ok_main", "ent_bad; DELETE user"]]; } },
      { version: 29, name: "029-record-update-activity.surql", sql: "-- marker" },
    );
    expect(sql).toContain("ON TABLE ent_ok_main");
    expect(sql).toContain("ON TABLE qa_ver03_materials");
    expect(sql).not.toContain("ent_bad");
  });
});
