export type SidebarPanel = 'none' | 'record' | 'graph' | 'history' | 'review' | 'ai' | 'admin';
export type TemplateKey = 'legal-entity-tracker' | 'case-management' | 'blank-workspace';

export interface TemplateSummary {
  key: TemplateKey;
  name: string;
  category: string;
  description: string;
  defaultWorkbookName: string;
  starterSheets: string;
  publishLabel: string;
  publishSlug: string | null;
}

export const templateCatalog: TemplateSummary[] = [
  {
    key: 'legal-entity-tracker',
    name: '债权申报总表',
    category: '破产债权',
    description: '围绕债权申报、材料补正、主体核验和口径复核组织工作簿。',
    defaultWorkbookName: '债权申报总表',
    starterSheets: 'Companies, People, Trusts',
    publishLabel: '发布债权申报表单',
    publishSlug: 'new-client-intake',
  },
  {
    key: 'case-management',
    name: '案件台账',
    category: '协作台账',
    description: '管理案件节点、沟通记录、资料清单和责任分工，适合辅助流程协作。',
    defaultWorkbookName: '案件台账',
    starterSheets: 'Cases, Clients, Documents',
    publishLabel: '发布案件信息表单',
    publishSlug: 'matter-intake',
  },
  {
    key: 'blank-workspace',
    name: '空白工作簿',
    category: '从空白开始',
    description: '保留腾讯文档式空白表格入口，适合从现有台账迁移后再补结构。',
    defaultWorkbookName: '空白工作簿',
    starterSheets: '无预置工作表',
    publishLabel: '先配置表单后再发布',
    publishSlug: null,
  },
];

export function findTemplate(templateKey: TemplateKey | null | undefined): TemplateSummary | null {
  if (!templateKey) {
    return null;
  }

  return templateCatalog.find((template) => template.key === templateKey) ?? null;
}

export function getPublishSlug(templateKey: TemplateKey | null | undefined): string | null {
  return findTemplate(templateKey)?.publishSlug ?? null;
}
