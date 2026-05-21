import type { CreditorRow, FolderNode, TemplateItem, Workbook } from "./types";

export const workbooks: Workbook[] = [
  { id: 1, name: "华润置地·破产重整债权申报主表", template: "债权申报", modified: "10分钟前", modifier: "王晓明", pinned: true, fileType: "excel" },
  { id: 2, name: "2024年度债权人信息汇总", template: "信息汇总", modified: "2小时前", modifier: "李静", fileType: "excel" },
  { id: 3, name: "担保物评估清单（第三批）", template: "资产评估", modified: "昨天 16:30", modifier: "张磊", fileType: "word" },
  { id: 4, name: "职工债权申报统计", template: "债权申报", modified: "2026-04-18", modifier: "王晓明", fileType: "excel" },
  { id: 5, name: "关联方关系图谱数据源", template: "关系图谱", modified: "2026-04-15", modifier: "陈颖", fileType: "excel" },
  { id: 6, name: "审计凭证收集表", template: "资料收集", modified: "2026-04-10", modifier: "李静", fileType: "word" },
];

export const folders: FolderNode[] = [
  { id: "f1", name: "华润置地项目", children: ["f1-1", "f1-2"] },
  { id: "f1-1", name: "债权申报", children: [], parent: "f1" },
  { id: "f1-2", name: "资产评估", children: [], parent: "f1" },
  { id: "f2", name: "蓝鼎国际项目", children: [] },
];

export const folderDocs: Record<string, Workbook[]> = {
  f1: [workbooks[0], workbooks[1]],
  "f1-1": [workbooks[0], workbooks[3]],
  "f1-2": [workbooks[2]],
  f2: [workbooks[4], workbooks[5]],
  uncat: [workbooks[3], workbooks[5]],
};

export const templates: TemplateItem[] = [
  { id: 1, name: "债权申报主表", desc: "标准债权人信息收集与审核管理，含申报金额、债权类型、审核状态等字段", type: "债权申报", tags: ["内置", "推荐"] },
  { id: 2, name: "担保物评估清单", desc: "记录和追踪破产资产担保物的评估状态与价值", type: "资产评估", tags: ["内置"] },
  { id: 3, name: "职工债权统计表", desc: "专用于职工工资、经济补偿金等职工类债权的申报登记", type: "债权申报", tags: ["内置"] },
  { id: 4, name: "关联方关系汇总", desc: "梳理债务人及相关主体的关联关系，支持图谱视图导出", type: "关系图谱", tags: ["内置"] },
  { id: 5, name: "工程款对账表", desc: "施工单位工程款债权的月度对账与凭证归集", type: "工程款债权", tags: ["专业版"] },
  { id: 6, name: "资料收集工单", desc: "面向外部协作方发起的通用资料收集模板，支持附件上传", type: "资料收集", tags: ["内置"] },
];

export const members = [
  { name: "王晓明", email: "wang.xm@huarun.com", role: "管理员", status: "活跃" },
  { name: "李静", email: "li.jing@huarun.com", role: "编辑", status: "活跃" },
  { name: "张磊", email: "zhang.lei@deheng.com", role: "编辑", status: "活跃" },
  { name: "陈颖", email: "chen.ying@huarun.com", role: "查看", status: "已邀请" },
];

export const changes = [
  { user: "王晓明", action: "将第6行「申报金额」修改为 5,600,000.00", time: "5分钟前" },
  { user: "李静", action: "新增了第9行「赵丽华」", time: "23分钟前" },
  { user: "张磊", action: "将第7行状态改为「已退回」并填写备注", time: "1小时前" },
  { user: "王晓明", action: "上传了3份附件到第2行", time: "2小时前" },
];

const baseRows: CreditorRow[] = [
  { id: 1, name: "张伟", idNo: "110101197503154213", contact: "138-0011-2233", amount: "450,000.00", type: "普通债权", date: "2026-03-15", docs: 3, status: "待审核", note: "" },
  { id: 2, name: "北京光明贸易有限公司", idNo: "91110108MA0012AB3X", contact: "010-87651234", amount: "2,340,000.00", type: "有担保债权", date: "2026-03-16", docs: 8, status: "已通过", note: "已提供抵押合同" },
  { id: 3, name: "李秀英", idNo: "110102196811234567", contact: "139-8877-6655", amount: "78,000.00", type: "普通债权", date: "2026-03-17", docs: 2, status: "已通过", note: "" },
  { id: 4, name: "上海远航供应链管理有限公司", idNo: "9131000078901234XA", contact: "021-65432100", amount: "890,500.00", type: "职工债权", date: "2026-03-18", docs: 12, status: "审核中", note: "工资凭证补充中" },
  { id: 5, name: "王建国", idNo: "110105198209187654", contact: "186-5544-3322", amount: "125,000.00", type: "普通债权", date: "2026-03-19", docs: 4, status: "待审核", note: "" },
  { id: 6, name: "深圳市鑫远投资管理有限公司", idNo: "91440300MA5H7X123B", contact: "0755-88997766", amount: "5,600,000.00", type: "有担保债权", date: "2026-03-20", docs: 15, status: "已通过", note: "已核实担保物" },
  { id: 7, name: "陈志强", idNo: "110103197412308901", contact: "137-2233-4455", amount: "230,000.00", type: "普通债权", date: "2026-03-21", docs: 5, status: "已退回", note: "材料不完整，请补充银行流水" },
  { id: 8, name: "天津博远建筑工程有限公司", idNo: "91120116MA06HJ456X", contact: "022-34561234", amount: "1,120,000.00", type: "工程款债权", date: "2026-03-22", docs: 9, status: "审核中", note: "" },
  { id: 9, name: "赵丽华", idNo: "110104198507123456", contact: "159-6677-8899", amount: "67,500.00", type: "普通债权", date: "2026-03-23", docs: 1, status: "待审核", note: "" },
  { id: 10, name: "广州恒基置业有限公司", idNo: "9144010078901234XB", contact: "020-33445566", amount: "3,890,000.00", type: "有担保债权", date: "2026-03-24", docs: 11, status: "审核中", note: "" },
];

export function createCreditorRows(count = 2500): CreditorRow[] {
  return Array.from({ length: count }, (_, index) => {
    const base = baseRows[index % baseRows.length];
    const amount = Number(base.amount.replace(/,/g, "")) + Math.floor(index / baseRows.length) * 1730;
    return {
      ...base,
      id: index + 1,
      name: index < baseRows.length ? base.name : `${base.name}-${String(index + 1).padStart(4, "0")}`,
      amount: amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      docs: (base.docs + index) % 16,
    };
  });
}

export const templateColors: Record<string, string> = {
  债权申报: "#1664ff",
  信息汇总: "#7b61ff",
  资产评估: "#f5a623",
  关系图谱: "#54c07b",
  资料收集: "#e86b4f",
  工程款债权: "#ff7d00",
};
