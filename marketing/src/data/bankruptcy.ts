import type { ProductTone } from "./product";

export const bankruptcyNavigation = [
  { label: "产品能力", href: "#capabilities" },
  { label: "上手路径", href: "#workflow" },
  { label: "试用说明", href: "#trial" },
] as const;

export const capabilityCards: ReadonlyArray<{
  icon: "scale" | "fileSpreadsheet" | "listChecks" | "bookMarked";
  eyebrow: string;
  title: string;
  description: string;
}> = [
  {
    icon: "scale",
    eyebrow: "结构化建簿",
    title: "债权表按模板一次建好",
    description:
      "破产债权管理模板预置债权人表与债权申报表：债权性质、审查状态、申报金额与审定金额字段和表间引用开箱即用，可选样例数据用于团队演示。",
  },
  {
    icon: "fileSpreadsheet",
    eyebrow: "Excel 导入",
    title: "存量申报批量进入",
    description:
      "“债权人名称 / 申报人”等常见表头按列别名自动对位，金额、日期、单选按目标类型规整；导入前出校验报告，失败行带行号与原因，可只重导失败部分。",
  },
  {
    icon: "listChecks",
    eyebrow: "逐项核对",
    title: "AI 提案，人来确认",
    description:
      "选中一条申报记录，AI 检查缺失与矛盾、对审定金额给出依据说明；字段补全以提案形式呈现，经审查人确认后才写回，结论由人负责。",
  },
  {
    icon: "bookMarked",
    eyebrow: "AI 法律研究",
    title: "研究与引用留在工作台",
    description:
      "法律检索与研究在工作区内进行，研究结果连同引用与证据一并保存进资料库，与相关案件记录关联，随时回读出处。",
  },
];

export const claimRows: ReadonlyArray<{
  name: string;
  nature: string;
  declared: string;
  confirmed: string;
  status: string;
  tone: ProductTone;
}> = [
  { name: "示例·恒信建材", nature: "普通债权", declared: "¥ 1,860,000", confirmed: "待审定", status: "待审查", tone: "sand" },
  { name: "示例·瑞丰设备", nature: "有财产担保", declared: "¥ 3,420,000", confirmed: "¥ 3,420,000", status: "已确认", tone: "green" },
  { name: "示例·员工工资组", nature: "劳动债权", declared: "¥ 640,000", confirmed: "待审定", status: "待补材料", tone: "orange" },
  { name: "示例·税务申报", nature: "税款债权", declared: "¥ 512,300", confirmed: "¥ 512,300", status: "已确认", tone: "green" },
];

export const onboardingSteps = [
  {
    number: "01",
    title: "邀请人开通",
    description: "工作区与成员账号由邀请人创建并开通，无需自助注册。",
  },
  {
    number: "02",
    title: "建簿",
    description: "用破产债权管理模板一键建簿（可选样例数据），或把存量申报 Excel 直接导入。",
  },
  {
    number: "03",
    title: "债权核对",
    description: "按审查状态逐项推进，AI 行分析提案经确认后写回，每步保留操作人。",
  },
  {
    number: "04",
    title: "AI 研究与报告",
    description: "法律研究问题、结论与引用保存到资料库，形成可回溯的研究记录。",
  },
] as const;

export const trialPoints = [
  {
    title: "两条试用路径",
    description:
      "受邀客户的工作区与成员账号由邀请人开通；现有受邀试用维持其获批范围不变。具备显式试用资格的计费账户管理员，也可以登录后在产品内经显式确认启动七日 Pro 试用。产品暂不开放自助注册，并非所有新用户都能新建工作区。",
  },
  {
    title: "第一阶段免费",
    description:
      "当前阶段不收取费用、无需信用卡，也不会自动转为付费或自动扣款；转为正式使用需另行选择 Plus / Pro / Max 新商业来源与新周期，不沿用试用余额。",
  },
  {
    title: "七日与共享额度",
    description:
      "七日试用以服务端时钟为准，全体成员共享 AI 额度，表格与记录容量有限；到期后成果保留，全文与追问按当前权限重新核验。",
  },
  {
    title: "显式确认启动",
    description:
      "启动前展示完整试用范围（内容、额度、容量、期限），须人工勾选确认才开始计时；交付失败可按原请求重试，不重新计时。",
  },
  {
    title: "内部验收配置",
    description:
      "当前试用配置为内部验收用途（fixture），用于受控验证，不代表正式商业承诺；语义检索的销售范围需另行获批。",
  },
  {
    title: "反馈找邀请人",
    description: "使用中遇到问题或有建议，直接联系你的邀请人即可，我们会据此改进产品。",
  },
] as const;

export const factPoints = [
  "数据存放于云主机与 Cloudflare 边缘网络",
  "每个工作区拥有独立数据库边界，成员权限与数据操作由数据库统一执行",
  "所有操作保留真实身份归因",
] as const;

// 页脚合规链接位：文档上线前保持占位（href 为 null），文档就绪后填入实际路径即可。
export const legalLinks: ReadonlyArray<{ label: string; href: string | null }> = [
  { label: "隐私政策", href: null },
  { label: "用户协议", href: null },
];
