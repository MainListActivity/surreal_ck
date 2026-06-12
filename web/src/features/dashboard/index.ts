export { default as DashboardWidgetFrame } from "./DashboardWidgetFrame.svelte";
export {
  dashboardWidgetRegistry,
  getDashboardWidget,
  type DashboardWidgetComponentProps,
  type DashboardWidgetRegistration,
} from "./registries/widgets";
export {
  dashboardWidgetDefinitions,
  getDashboardWidgetDefinition,
  type DashboardWidgetDefinition,
} from "./registries/widget-definitions";
