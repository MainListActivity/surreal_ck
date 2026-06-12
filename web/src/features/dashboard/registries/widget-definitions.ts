import type { DashboardViewType } from "@surreal-ck/shared/rpc.types";

export type DashboardWidgetDefinition = {
  viewType: DashboardViewType;
  componentName:
    | "KpiWidget"
    | "TableWidget"
    | "CategoryBarWidget"
    | "TimeSeriesWidget"
    | "PieWidget"
    | "AreaWidget";
};

export const dashboardWidgetDefinitions: DashboardWidgetDefinition[] = [
  { viewType: "kpi", componentName: "KpiWidget" },
  { viewType: "table", componentName: "TableWidget" },
  { viewType: "bar", componentName: "CategoryBarWidget" },
  { viewType: "line", componentName: "TimeSeriesWidget" },
  { viewType: "pie", componentName: "PieWidget" },
  { viewType: "area", componentName: "AreaWidget" },
];

export function getDashboardWidgetDefinition(
  viewType: DashboardViewType,
): DashboardWidgetDefinition | undefined {
  return dashboardWidgetDefinitions.find((item) => item.viewType === viewType);
}
