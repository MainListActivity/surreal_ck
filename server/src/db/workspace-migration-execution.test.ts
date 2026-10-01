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

  describe("entity member permissions (043)", () => {
    const script = { version: 43, name: "043-entity-member-permissions.surql", sql: "-- marker" };

    function fakeDb(tableNames: string[], tables: Record<string, string>) {
      return {
        async query(sql: string) {
          if (sql.includes("FROM sheet")) return [tableNames];
          if (sql.includes("INFO FOR DB")) return [{ tables }];
          throw new Error(`unexpected query: ${sql}`);
        },
      };
    }

    test("registered entity tables without PERMISSIONS get the member DML clause", async () => {
      const sql = await materializeWorkspaceMigrationSql(
        fakeDb(
          ["ent_beta_main", "ent_alpha_main"],
          {
            ent_alpha_main: "DEFINE TABLE ent_alpha_main TYPE ANY SCHEMALESS CHANGEFEED 1w",
            ent_beta_main: "DEFINE TABLE ent_beta_main TYPE ANY SCHEMALESS CHANGEFEED 1w PERMISSIONS NONE",
          },
        ),
        script,
      );
      expect(sql).toContain("BEGIN TRANSACTION");
      expect(sql).toContain(
        "ALTER TABLE ent_alpha_main PERMISSIONS FOR select, create, update, delete WHERE fn::current_user() != NONE AND fn::current_user().disabled_at = NONE;",
      );
      expect(sql).toContain("ALTER TABLE ent_beta_main");
      expect(sql).toContain("COMMIT TRANSACTION");
    });

    test("custom PERMISSIONS are preserved untouched and reported", async () => {
      const sql = await materializeWorkspaceMigrationSql(
        fakeDb(
          ["ent_fixed", "ent_custom", "ent_full"],
          {
            ent_fixed: "DEFINE TABLE ent_fixed TYPE ANY SCHEMALESS",
            ent_custom: "DEFINE TABLE ent_custom TYPE ANY SCHEMALESS PERMISSIONS FOR select WHERE $auth.is_admin = true, FOR create, update, delete NONE",
            ent_full: "DEFINE TABLE ent_full TYPE ANY SCHEMALESS PERMISSIONS FULL",
          },
        ),
        script,
      );
      expect(sql).toContain("ALTER TABLE ent_fixed");
      expect(sql).not.toContain("ALTER TABLE ent_custom");
      expect(sql).not.toContain("ALTER TABLE ent_full");
    });

    test("unregistered tables are untouched; unsafe names and dangling registry rows are skipped", async () => {
      const sql = await materializeWorkspaceMigrationSql(
        fakeDb(
          ["ent_registered", "ent_missing", "bad; DROP TABLE user"],
          {
            ent_registered: "DEFINE TABLE ent_registered TYPE ANY SCHEMALESS",
            ent_unregistered: "DEFINE TABLE ent_unregistered TYPE ANY SCHEMALESS",
          },
        ),
        script,
      );
      expect(sql).toContain("ALTER TABLE ent_registered");
      expect(sql).not.toContain("ent_missing");
      expect(sql).not.toContain("ent_unregistered");
      expect(sql).not.toContain("DROP TABLE");
    });

    test("nothing to apply emits a harmless no-op marker", async () => {
      const sql = await materializeWorkspaceMigrationSql(
        fakeDb(["ent_custom"], {
          ent_custom: "DEFINE TABLE ent_custom TYPE ANY SCHEMALESS PERMISSIONS FOR select WHERE $auth != NONE",
        }),
        script,
      );
      expect(sql).toContain("RETURN");
      expect(sql).not.toContain("ALTER TABLE");
    });
  });
});
