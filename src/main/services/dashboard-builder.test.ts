import { describe, expect, test } from "bun:test";
import { compileDashboardBuilder, validateBuilderSpec } from "./dashboard-builder";
import { ServiceError } from "./errors";

describe("validateBuilderSpec", () => {
  test("拒绝非法表名", () => {
    expect(() =>
      validateBuilderSpec({
        sourceTables: ["workspace;DELETE"],
        baseTable: "workspace",
        metric: { op: "count" },
      }),
    ).toThrow(ServiceError);
  });
});

describe("compileDashboardBuilder", () => {
  test("编译单值 count 视图", () => {
    const compiled = compileDashboardBuilder({
      sourceTables: ["workbook"],
      baseTable: "workbook",
      metric: { op: "count" },
    });
    expect(compiled.resultContract).toBe("single_value");
    expect(compiled.viewType).toBe("kpi");
    expect(compiled.sql).toContain("SELECT count() AS value FROM workbook");
  });

  test("编译分类统计视图", () => {
    const compiled = compileDashboardBuilder({
      sourceTables: ["workbook"],
      baseTable: "workbook",
      metric: { op: "count" },
      dimensions: [{ field: "template_key" }],
      limit: 12,
    });
    expect(compiled.resultContract).toBe("category_breakdown");
    expect(compiled.viewType).toBe("bar");
    expect(compiled.sql).toContain("GROUP BY template_key");
    expect(compiled.sql).toContain("LIMIT 12");
  });

  test("编译时间序列视图", () => {
    const compiled = compileDashboardBuilder({
      sourceTables: ["workbook"],
      baseTable: "workbook",
      metric: { op: "count" },
      dimensions: [{ field: "updated_at", bucket: "day" }],
    });
    expect(compiled.resultContract).toBe("time_series");
    expect(compiled.viewType).toBe("line");
    expect(compiled.sql).toContain("AS x");
    expect(compiled.sql).toContain("ORDER BY x ASC");
  });
});
