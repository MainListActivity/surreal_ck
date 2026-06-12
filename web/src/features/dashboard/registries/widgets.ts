import type { Component } from "svelte";
import type {
  DashboardNormalizedResult,
  DashboardViewType,
} from "@surreal-ck/shared/rpc.types";
import KpiWidget from "../widgets/KpiWidget.svelte";
import TableWidget from "../widgets/TableWidget.svelte";
import CategoryBarWidget from "../widgets/CategoryBarWidget.svelte";
import TimeSeriesWidget from "../widgets/TimeSeriesWidget.svelte";
import PieWidget from "../widgets/PieWidget.svelte";
import AreaWidget from "../widgets/AreaWidget.svelte";
import type { DashboardWidgetDefinition } from "./widget-definitions";

export type DashboardWidgetComponentProps = {
  title: string;
  result?: DashboardNormalizedResult;
  displaySpec?: Record<string, unknown>;
};

export type DashboardWidgetRegistration = DashboardWidgetDefinition & {
  component: Component<DashboardWidgetComponentProps>;
};

export const dashboardWidgetRegistry: DashboardWidgetRegistration[] = [
  { viewType: "kpi", componentName: "KpiWidget", component: KpiWidget },
  { viewType: "table", componentName: "TableWidget", component: TableWidget },
  { viewType: "bar", componentName: "CategoryBarWidget", component: CategoryBarWidget },
  { viewType: "line", componentName: "TimeSeriesWidget", component: TimeSeriesWidget },
  { viewType: "pie", componentName: "PieWidget", component: PieWidget },
  { viewType: "area", componentName: "AreaWidget", component: AreaWidget },
];

export function getDashboardWidget(viewType: DashboardViewType): DashboardWidgetRegistration | undefined {
  return dashboardWidgetRegistry.find((item) => item.viewType === viewType);
}
