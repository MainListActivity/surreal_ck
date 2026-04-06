export type SidebarPanel = 'none' | 'record' | 'graph' | 'recent' | 'setup' | 'admin';
export type TemplateKey = 'legal-entity-tracker' | 'case-management' | 'blank-workspace';
export type AppScenario = 'resume-workbook' | 'template-picker';

export interface TemplateSummary {
  key: TemplateKey;
  name: string;
  description: string;
  accent: string;
  entityTypes: string[];
  sampleForm: string;
  defaultSidebar: SidebarPanel;
}

export interface WorkbookRow {
  id: string;
  entity: string;
  jurisdiction: string;
  relationship: string;
  formula: string;
  owner: string;
  status: 'live' | 'draft' | 'new';
}

export interface WorkbookSummary {
  id: string;
  name: string;
  templateKey: TemplateKey;
  sheetLabel: string;
  updatedAt: string;
  syncStatus: 'LIVE SYNC' | 'RECONNECTING';
  rows: WorkbookRow[];
}

export interface GraphResult {
  label: string;
  recordId: string;
  entityType: string;
}

export interface RecentChange {
  id: string;
  actor: string;
  action: string;
  at: string;
}

export interface WorkspaceSeed {
  name: string;
  memberCount: number;
  userName: string;
  templates: TemplateSummary[];
  workbooks: WorkbookSummary[];
  graphResults: GraphResult[];
  recentChanges: RecentChange[];
}

export const templateCatalog: TemplateSummary[] = [
  {
    key: 'legal-entity-tracker',
    name: 'Legal Entity Tracker',
    description: 'Companies, people, trusts, and intake records wired for ownership-chain review.',
    accent: 'Owns, controls, filed_by',
    entityTypes: ['Company', 'Person', 'Trust'],
    sampleForm: 'New Client Intake',
    defaultSidebar: 'none',
  },
  {
    key: 'case-management',
    name: 'Case Management',
    description: 'Cases, clients, documents, and filing relationships tuned for matter operations.',
    accent: 'assigned_to, filed_in',
    entityTypes: ['Case', 'Client', 'Document'],
    sampleForm: 'Matter Intake',
    defaultSidebar: 'none',
  },
  {
    key: 'blank-workspace',
    name: 'Blank Workspace',
    description: 'Open an empty workbook immediately and guide the admin through the first three setup actions.',
    accent: 'Guided setup',
    entityTypes: [],
    sampleForm: 'No starter form',
    defaultSidebar: 'none',
  },
];

export const workspaceSeed: WorkspaceSeed = {
  name: 'Harbor Legal Ops',
  memberCount: 4,
  userName: 'YC Chen',
  templates: templateCatalog,
  workbooks: [
    {
      id: 'wb-legal-entities',
      name: 'Legal Entity Tracker',
      templateKey: 'legal-entity-tracker',
      sheetLabel: 'Action Sheet: Ownership Review',
      updatedAt: 'Updated 2 minutes ago',
      syncStatus: 'LIVE SYNC',
      rows: [
        {
          id: 'company:acme-holdings',
          entity: 'Acme Holdings',
          jurisdiction: 'Delaware',
          relationship: 'owns beta-llc',
          formula: '=GRAPH_TRAVERSE("company:acme-holdings", "owns", 2)',
          owner: 'A. Wong',
          status: 'live',
        },
        {
          id: 'company:beta-llc',
          entity: 'Beta LLC',
          jurisdiction: 'Hong Kong',
          relationship: 'controls gamma-inc',
          formula: 'company:beta-llc',
          owner: 'YC Chen',
          status: 'draft',
        },
        {
          id: 'company:gamma-inc',
          entity: 'Gamma Inc',
          jurisdiction: 'Singapore',
          relationship: 'filed_by intake:2026-04-05',
          formula: 'person:chen-wei',
          owner: 'A. Wong',
          status: 'new',
        },
      ],
    },
    {
      id: 'wb-case-ops',
      name: 'Case Management',
      templateKey: 'case-management',
      sheetLabel: 'Action Sheet: Filing Review',
      updatedAt: 'Updated 14 minutes ago',
      syncStatus: 'RECONNECTING',
      rows: [
        {
          id: 'case:redwood-v-triton',
          entity: 'Redwood v. Triton',
          jurisdiction: 'California',
          relationship: 'filed_in superior-court',
          formula: 'document:motion-42',
          owner: 'M. Rivera',
          status: 'live',
        },
        {
          id: 'document:motion-42',
          entity: 'Motion 42',
          jurisdiction: 'California',
          relationship: 'assigned_to redwood-team',
          formula: 'client:redwood',
          owner: 'YC Chen',
          status: 'draft',
        },
      ],
    },
  ],
  graphResults: [
    { label: 'Acme Holdings', recordId: 'company:acme-holdings', entityType: 'Company' },
    { label: 'Beta LLC', recordId: 'company:beta-llc', entityType: 'Company' },
    { label: 'Gamma Inc', recordId: 'company:gamma-inc', entityType: 'Company' },
  ],
  recentChanges: [
    { id: 'chg-1', actor: 'YC Chen', action: 'Updated ownership formula on row 12', at: 'Just now' },
    { id: 'chg-2', actor: 'A. Wong', action: 'Inserted relationship owns -> beta-llc', at: '2m ago' },
    { id: 'chg-3', actor: 'M. Rivera', action: 'Submitted New Client Intake form', at: '8m ago' },
  ],
};

export const blankWorkbook: WorkbookSummary = {
  id: 'wb-blank-workspace',
  name: 'Blank Workspace',
  templateKey: 'blank-workspace',
  sheetLabel: 'Action Sheet: First Setup',
  updatedAt: 'Created just now',
  syncStatus: 'LIVE SYNC',
  rows: [
    {
      id: 'draft:first-entity',
      entity: 'Create your first entity type',
      jurisdiction: 'Pending',
      relationship: 'Define one relationship type',
      formula: 'Launch setup panel',
      owner: 'Admin',
      status: 'new',
    },
  ],
};

export function getDefaultWorkbookId(): string {
  return workspaceSeed.workbooks[0]?.id ?? blankWorkbook.id;
}

export function findWorkbookById(workbookId: string): WorkbookSummary {
  return workspaceSeed.workbooks.find((workbook) => workbook.id === workbookId) ?? blankWorkbook;
}

export function resolveWorkbookForTemplate(templateKey: TemplateKey): WorkbookSummary {
  if (templateKey === 'blank-workspace') {
    return blankWorkbook;
  }

  return workspaceSeed.workbooks.find((workbook) => workbook.templateKey === templateKey) ?? workspaceSeed.workbooks[0] ?? blankWorkbook;
}

export function getDefaultPanelForTemplate(templateKey: TemplateKey): SidebarPanel {
  return 'none';
}
