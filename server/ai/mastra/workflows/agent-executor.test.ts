import { describe, expect, test } from "bun:test";
import {
  deriveCitationsFromToolCalls,
  deriveConfirmedFromToolCalls,
  deriveSuspendSignalFromToolCalls,
} from "./agent-executor";
import type { AiToolCallRecord } from "@surreal-ck/shared";

describe("agent executor tool result translation", () => {
  test("记录关联资源的工具结果透传为可点击 citations", () => {
    const citations = deriveCitationsFromToolCalls([{
      toolName: "fetchRelatedRecords",
      result: {
        source: "record-resources",
        items: [],
        citations: [{
          index: 1,
          resourceId: "resource_item:r1",
          title: "网页判例",
          sourceUrl: "https://example.test/case",
          evidence: [{ order: 0, text: "法院认为担保债权应单独审查。" }],
        }],
      },
    }]);

    expect(citations).toEqual([{
      index: 1,
      resourceId: "resource_item:r1",
      title: "网页判例",
      sourceUrl: "https://example.test/case",
      evidence: [{ order: 0, text: "法院认为担保债权应单独审查。" }],
    }]);
  });

  test("ambiguous tool intent becomes a workflow suspend signal", () => {
    const signal = deriveSuspendSignalFromToolCalls([
      {
        toolName: "searchRecord",
        result: {
          intent: {
            type: "ambiguous",
            candidates: [
              { id: "ent_claim:1", label: "张三 / ZQ-1" },
              { id: "ent_claim:2", label: "张三 / ZQ-2" },
            ],
          },
        },
      },
    ]);

    expect(signal).toEqual({
      kind: "ambiguous",
      candidates: [
        { id: "ent_claim:1", label: "张三 / ZQ-1" },
        { id: "ent_claim:2", label: "张三 / ZQ-2" },
      ],
    });
  });

  test("write-side tool intent becomes await-write-confirm", () => {
    const signal = deriveSuspendSignalFromToolCalls([
      {
        toolName: "generateDashboardDraft",
        result: {
          intent: {
            type: "dashboard-draft",
            title: "债权趋势",
            description: "按月统计债权",
            explanation: "按月汇总。",
            widgetSpec: {
              sourceTables: ["ent_claim"],
              baseTable: "ent_claim",
              metric: { op: "sum", field: "amount" },
            },
            draft: {
              workspaceId: "workspace:demo",
              title: "债权趋势",
              queryMode: "builder",
              viewType: "line",
              resultContract: "time_series",
              builderSpec: {
                sourceTables: ["ent_claim"],
                baseTable: "ent_claim",
                metric: { op: "sum", field: "amount" },
              },
            },
          },
        },
      },
    ]);

    expect(signal?.kind).toBe("await-write-confirm");
    expect(signal && "intent" in signal ? signal.intent.type : null).toBe("dashboard-draft");
  });

  test("schema summary and resolved record are collected as confirmed context", () => {
    const calls: AiToolCallRecord[] = [
      {
        toolName: "inspectSchema",
        result: {
          schemaSummary: {
            tables: ["ent_claim"],
            fieldsByTable: { ent_claim: ["name", "amount"] },
          },
        },
      },
      {
        toolName: "searchRecord",
        result: {
          intent: {
            type: "open-record",
            workbookId: "workbook:demo",
            sheetId: "sheet:claims",
            recordId: "ent_claim:abc",
            label: "张三 / ZQ-1",
          },
        },
      },
    ];

    expect(deriveConfirmedFromToolCalls(calls)).toEqual({
      schemaSummary: {
        tables: ["ent_claim"],
        fieldsByTable: { ent_claim: ["name", "amount"] },
      },
      resolvedRecord: { id: "ent_claim:abc", label: "张三 / ZQ-1" },
    });
  });
});
