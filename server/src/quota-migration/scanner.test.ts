import { describe, expect, test } from "bun:test";
import {
  SurrealLegacyQuotaInventoryReader,
  SurrealQuotaPhysicalScanner,
} from "./scanner";
import { physicalScanChecksum } from "./model";

describe("quota migration scanners", () => {
  test("independently scans table definitions, field catalog and records", async () => {
    const queries: string[] = [];
    const scanner = new SurrealQuotaPhysicalScanner({
      async query(sql) {
        queries.push(sql);
        if (sql === "INFO FOR DATABASE STRUCTURE;") {
          return [{ tables: [{ name: "sheet" }, { name: "ent_case" }] }];
        }
        if (sql.includes("`ent_case`")) {
          return [{ fields: [{ name: "a" }, { name: "b" }] }, [{ count: 4 }]];
        }
        return [{ fields: [{ name: "name" }] }, [{ count: 1 }]];
      },
    });

    const result = await scanner.scan();
    expect(result).toEqual({
      tables: [
        { table: "ent_case", field_count: "2", record_count: "4" },
        { table: "sheet", field_count: "1", record_count: "1" },
      ],
      totals: { table_count: "2", field_count: "3", record_count: "5" },
      scan_checksum: physicalScanChecksum([
        { table: "ent_case", field_count: "2", record_count: "4" },
        { table: "sheet", field_count: "1", record_count: "1" },
      ]),
    });
    expect(queries).toHaveLength(3);
  });

  test("legacy mutable values remain evidence and unsafe event targets block", async () => {
    const reader = new SurrealLegacyQuotaInventoryReader({
      async query(sql) {
        if (sql.includes("FROM resource_quota_plan")) {
          return [
            [{
              id: "resource_quota_plan:plus",
              key: "plus",
              max_sheets: 1,
              max_fields_per_sheet: 3,
              max_records_per_sheet: 2,
            }],
            [{
              plan: "resource_quota_plan:plus",
              sheet_count: 99,
            }],
            [{
              sheet: "sheet:case",
              record_count: 88,
            }],
            [
              { id: "sheet:case", table_name: "ent_case" },
              { id: "sheet:unsafe", table_name: "orders; REMOVE TABLE sheet" },
            ],
          ];
        }
        return [true];
      },
    });

    const result = await reader.read("ws_demo");
    expect(result.evidence.plan_binding?.plan_key).toBe("plus");
    expect(result.evidence.counters.sheet_count).toBe("99");
    expect(result.evidence.counters.per_sheet_records[0]?.record_count).toBe(
      "88",
    );
    expect(result.anomalies).toContainEqual({
      code: "legacy_event_target_invalid",
      severity: "blocker",
      details: { table: "orders; REMOVE TABLE sheet" },
    });
  });
});
