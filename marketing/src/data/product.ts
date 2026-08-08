export type ProductIcon = "database" | "layout" | "sparkles";
export type ProductTone = "green" | "orange" | "purple" | "sand";

export const navigation = [
  { label: "产品能力", href: "#capabilities" },
  { label: "行业模板", href: "#templates" },
  { label: "工作方式", href: "#workflow" },
  { label: "安全与权限", href: "#security" },
] as const;

export const capabilityCards: ReadonlyArray<{
  icon: ProductIcon;
  eyebrow: string;
  title: string;
  description: string;
}> = [
  {
    icon: "database",
    eyebrow: "结构化数据",
    title: "表格的直觉，数据库的底气",
    description: "字段、关联与权限自然形成结构，数据越多，工作越清晰。",
  },
  {
    icon: "layout",
    eyebrow: "灵活工作视图",
    title: "同一份数据，多种工作方式",
    description: "表格、看板、画廊和表单随时切换，让每个角色都能快速上手。",
  },
  {
    icon: "sparkles",
    eyebrow: "AI 原生协作",
    title: "让 AI 参与真实工作",
    description: "AI 理解当前工作空间，在数据上下文中生成洞察、视图和下一步动作。",
  },
];

export const views = ["表格", "看板", "画廊", "表单"] as const;

export const workbookRows: ReadonlyArray<{
  name: string;
  amount: string;
  status: string;
  owner: string;
  tone: ProductTone;
}> = [
  { name: "华远供应链", amount: "¥ 680,000", status: "待核验", owner: "林澈", tone: "sand" },
  { name: "北辰实业", amount: "¥ 1,240,000", status: "复核中", owner: "陈越", tone: "orange" },
  { name: "知行科技", amount: "¥ 420,000", status: "已确认", owner: "周宁", tone: "green" },
  { name: "合信商贸", amount: "¥ 298,000", status: "材料补充", owner: "林澈", tone: "purple" },
];

export const templateCards: ReadonlyArray<{
  number: string;
  name: string;
  meta: string;
  tone: ProductTone;
}> = [
  { number: "01", name: "破产债权管理", meta: "债权申报 · 材料审查 · 清偿测算", tone: "green" },
  { number: "02", name: "项目交付管理", meta: "任务进度 · 团队协作 · 风险跟踪", tone: "orange" },
  { number: "03", name: "客户与线索管理", meta: "客户档案 · 跟进记录 · 转化分析", tone: "purple" },
  { number: "04", name: "研究资料库", meta: "文档归档 · 重点摘录 · 关联记录", tone: "sand" },
];

export const workflowSteps = [
  {
    number: "01",
    title: "导入已有资料",
    description: "Excel、CSV 或文档都能快速进入工作空间，保留团队已有的积累。",
  },
  {
    number: "02",
    title: "邀请团队一起工作",
    description: "按角色分享工作簿，实时协作、评论和更新，不再来回传递文件。",
  },
  {
    number: "03",
    title: "让 AI 继续推进",
    description: "从数据中提炼结论、生成视图，把重复整理变成可以复用的工作流。",
  },
] as const;
