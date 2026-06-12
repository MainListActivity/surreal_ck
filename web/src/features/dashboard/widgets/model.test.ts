import { describe, expect, test } from "bun:test";
import type { DashboardNormalizedResult } from "@surreal-ck/shared/rpc.types";
import {
  toCategoryChartModel,
  toKpiWidgetModel,
  toPieChartModel,
  toTableWidgetModel,
  toTimeSeriesChartModel,
} from "./model";

describe("dashboard widget view models", () => {
  test("KPI renders a single normalized value with display label and unit", () => {
    const result: DashboardNormalizedResult = { value: 42, label: "记录数", unit: "件" };

    expect(toKpiWidgetModel(result, {
      title: "债权数",
      displaySpec: { metricLabel: "已确认债权" },
    })).toEqual({
      label: "已确认债权",
      value: "42",
      unit: "件",
    });
  });

  test("category bar renders normalized breakdown rows", () => {
    const result: DashboardNormalizedResult = {
      rows: [
        { key: "approved", label: "已确认", value: 120 },
        { key: "pending", label: "待确认", value: Number.NaN },
      ],
    };

    expect(toCategoryChartModel(result).rows).toEqual([
      { key: "approved", label: "已确认", value: 120 },
      { key: "pending", label: "待确认", value: 0 },
    ]);
  });

  test("pie chart renders category rows with percentage labels", () => {
    const result: DashboardNormalizedResult = {
      rows: [
        { key: "secured", label: "有担保", value: 120 },
        { key: "ordinary", label: "普通", value: 80 },
      ],
    };

    expect(toPieChartModel(result).rows).toEqual([
      { key: "secured", label: "有担保", value: 120, share: 0.6, shareLabel: "60%" },
      { key: "ordinary", label: "普通", value: 80, share: 0.4, shareLabel: "40%" },
    ]);
  });

  test("time series renders x/y rows for line and area widgets", () => {
    const result: DashboardNormalizedResult = {
      rows: [
        { x: "2026-06-01", y: 3, series: "A" },
        { x: "2026-06-02", y: Number.NaN },
      ],
    };

    expect(toTimeSeriesChartModel(result).rows).toEqual([
      { x: "2026-06-01", y: 3, series: "A" },
      { x: "2026-06-02", y: 0 },
    ]);
  });

  test("table renders rows in declared column order with blank missing cells", () => {
    const result: DashboardNormalizedResult = {
      columns: [
        { key: "name", label: "债权人" },
        { key: "amount", label: "金额" },
      ],
      rows: [
        { name: "甲公司", amount: 100 },
        { name: "乙公司", amount: null },
      ],
    };

    expect(toTableWidgetModel(result)).toEqual({
      columns: [
        { key: "name", label: "债权人" },
        { key: "amount", label: "金额" },
      ],
      rows: [
        { cells: ["甲公司", "100"] },
        { cells: ["乙公司", ""] },
      ],
      emptyText: "暂无数据",
    });
  });

  test("wrong result shapes become placeholders or empty models without throwing", () => {
    const singleValue: DashboardNormalizedResult = { value: 1 };
    const category: DashboardNormalizedResult = {
      rows: [{ key: "approved", label: "已确认", value: 1 }],
    };

    expect(toKpiWidgetModel(category, { title: "总览" })).toEqual({ label: "总览", value: "—" });
    expect(toCategoryChartModel(singleValue)).toEqual({ rows: [], emptyText: "暂无数据" });
    expect(toPieChartModel(undefined)).toEqual({ rows: [], emptyText: "暂无数据" });
    expect(toTimeSeriesChartModel(category)).toEqual({ rows: [], emptyText: "暂无数据" });
    expect(toTableWidgetModel(category)).toEqual({ columns: [], rows: [], emptyText: "暂无数据" });
  });
});
