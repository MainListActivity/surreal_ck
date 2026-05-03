import type { Component } from "svelte";
import type { DashboardViewType } from "../../../../shared/rpc.types";
import KpiWidget from "../widgets/KpiWidget.svelte";
import TableWidget from "../widgets/TableWidget.svelte";
import CategoryBarWidget from "../widgets/CategoryBarWidget.svelte";
import TimeSeriesWidget from "../widgets/TimeSeriesWidget.svelte";

export type DashboardWidgetRegistration = {
  viewType: DashboardViewType;
  component: Component;
};

export const dashboardWidgetRegistry: DashboardWidgetRegistration[] = [
  { viewType: "kpi", component: KpiWidget },
  { viewType: "table", component: TableWidget },
  { viewType: "bar", component: CategoryBarWidget },
  { viewType: "line", component: TimeSeriesWidget },
];

export function getDashboardWidget(viewType: DashboardViewType): DashboardWidgetRegistration | undefined {
  return dashboardWidgetRegistry.find((item) => item.viewType === viewType);
}
