export type DashboardBuilderTemplate = {
  id: string;
  label: string;
  description: string;
  mode: "builder" | "sql";
  kind: "record_count" | "group_count" | "latest_rows" | "advanced_sql";
};

export const dashboardBuilderTemplates: DashboardBuilderTemplate[] = [
  {
    id: "record_count",
    label: "记录总数",
    description: "统计单张表的记录数量，适合 KPI 卡片。",
    mode: "builder",
    kind: "record_count",
  },
  {
    id: "group_count",
    label: "分类计数",
    description: "按某个字段分组统计数量，适合柱状图。",
    mode: "builder",
    kind: "group_count",
  },
  {
    id: "latest_rows",
    label: "最近记录",
    description: "按某个字段排序返回最近 N 条记录，适合表格。",
    mode: "sql",
    kind: "latest_rows",
  },
  {
    id: "advanced_sql",
    label: "高级 SQL",
    description: "直接编写只读 SQL，自定义结果契约与视图类型。",
    mode: "sql",
    kind: "advanced_sql",
  },
];
