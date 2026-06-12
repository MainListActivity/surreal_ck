import { describe, expect, test } from "bun:test";
import type { DashboardViewType } from "@surreal-ck/shared/rpc.types";
import {
  dashboardWidgetDefinitions,
  getDashboardWidgetDefinition,
} from "./widget-definitions";

describe("dashboard widget registry definitions", () => {
  test("covers every DashboardViewType and returns undefined for unknown keys", () => {
    const viewTypes: DashboardViewType[] = ["kpi", "table", "bar", "line", "pie", "area"];

    expect(dashboardWidgetDefinitions.map((item) => item.viewType).sort()).toEqual([...viewTypes].sort());
    for (const viewType of viewTypes) {
      expect(getDashboardWidgetDefinition(viewType)?.viewType).toBe(viewType);
    }
    expect(getDashboardWidgetDefinition("scatter" as DashboardViewType)).toBeUndefined();
  });
});
