import { describe, expect, test } from "bun:test";
import { createDashboardDraftIntent } from "./dashboard-draft";
import type { TableSchemaField } from "../../shared/rpc.types";

describe("createDashboardDraftIntent", () => {
  test("把按月金额趋势需求转换成可渲染的 builder 草稿", async () => {
    const fields: TableSchemaField[] = [
      { key: "creditor_name", label: "债权人", fieldType: "text", nullable: true },
      { key: "declared_amount", label: "债权申报金额", fieldType: "number", nullable: false },
      { key: "submitted_at", label: "申报日期", fieldType: "date", nullable: false },
    ];

    const intent = createDashboardDraftIntent({
      description: "按月统计债权申报金额趋势",
      workspaceId: "workspace:demo",
      workbookId: "workbook:demo",
      schemas: [
        {
          table: "ent_claim",
          label: "债权申报",
          fields,
        },
      ],
    });

    expect(intent.type).toBe("dashboard-draft");
    expect(intent.title).toContain("债权申报金额");
    expect(intent.explanation).toContain("按月");
    expect(intent.widgetSpec).toEqual({
      sourceTables: ["ent_claim"],
      baseTable: "ent_claim",
      metric: { op: "sum", field: "declared_amount" },
      dimensions: [{ field: "submitted_at", bucket: "month" }],
      limit: 24,
    });
    expect(intent.draft).toMatchObject({
      workspaceId: "workspace:demo",
      workbookId: "workbook:demo",
      queryMode: "builder",
      viewType: "line",
      resultContract: "time_series",
      builderSpec: intent.widgetSpec,
    });
  });
});
