import type { TemplateSummaryDTO } from "../../shared/rpc.types";

export type EntityDef = {
  key: string;
  label: string;
  columnDefs: Array<{
    key: string;
    label: string;
    field_type: string;
    required?: boolean;
    options?: string[];
  }>;
  position: number;
};

export type RelationDef = {
  key: string;
  label: string;
  fromEntityKey: string;
  toEntityKey: string;
  edgeProps?: Array<{ key: string; label: string; field_type: string }>;
};

export type TemplateDef = TemplateSummaryDTO & {
  entities: EntityDef[];
  relations: RelationDef[];
  hasSampleData: boolean;
};

const CATALOG: Record<string, TemplateDef> = {
  blank: {
    key: "blank",
    name: "空白工作簿",
    description: "从零开始，自由定义字段结构",
    tags: ["内置"],
    entities: [
      {
        key: "main",
        label: "Sheet 1",
        position: 0,
        columnDefs: [
          { key: "name",  label: "名称",  field_type: "text", required: true  },
          { key: "value", label: "值",    field_type: "text", required: false },
          { key: "note",  label: "备注",  field_type: "text", required: false },
        ],
      },
    ],
    relations: [],
    hasSampleData: false,
  },

  "case-management": {
    key: "case-management",
    name: "案件管理",
    description: "标准案件管理模板，含案件、当事人、文件三张表以及样例数据",
    tags: ["内置", "推荐"],
    entities: [
      {
        key: "case",
        label: "Cases",
        position: 0,
        columnDefs: [
          { key: "title",     label: "Case Title", field_type: "text",          required: true  },
          { key: "matter_id", label: "Matter ID",  field_type: "text",          required: false },
          { key: "status",    label: "Status",     field_type: "single_select", required: false, options: ["Open", "Pending", "Closed"] },
          { key: "opened_at", label: "Opened",     field_type: "date",          required: false },
        ],
      },
      {
        key: "client",
        label: "Clients",
        position: 1,
        columnDefs: [
          { key: "name",  label: "Client Name", field_type: "text", required: true  },
          { key: "email", label: "Email",        field_type: "text", required: false },
          { key: "phone", label: "Phone",        field_type: "text", required: false },
        ],
      },
      {
        key: "document",
        label: "Documents",
        position: 2,
        columnDefs: [
          { key: "title",    label: "Document Title", field_type: "text",          required: true  },
          { key: "doc_type", label: "Type",           field_type: "single_select", required: false, options: ["Motion", "Brief", "Order", "Contract", "Evidence"] },
          { key: "filed_at", label: "Filed",          field_type: "date",          required: false },
        ],
      },
    ],
    relations: [
      { key: "assigned_to", label: "Assigned To",  fromEntityKey: "case",     toEntityKey: "client" },
      { key: "filed_in",    label: "Filed In",     fromEntityKey: "case",     toEntityKey: "case"   },
      { key: "belongs_to",  label: "Belongs To",   fromEntityKey: "document", toEntityKey: "case"   },
    ],
    hasSampleData: true,
  },

  "legal-entity-tracker": {
    key: "legal-entity-tracker",
    name: "法律实体追踪",
    description: "追踪公司、人员、信托的股权与控制关系，含关系图谱支持",
    tags: ["内置"],
    entities: [
      {
        key: "company",
        label: "Companies",
        position: 0,
        columnDefs: [
          { key: "name",         label: "Name",         field_type: "text",          required: true  },
          { key: "jurisdiction", label: "Jurisdiction", field_type: "text",          required: false },
          { key: "status",       label: "Status",       field_type: "single_select", required: false, options: ["Active", "Dissolved", "Pending"] },
        ],
      },
      {
        key: "person",
        label: "People",
        position: 1,
        columnDefs: [
          { key: "name",  label: "Full Name", field_type: "text", required: true  },
          { key: "email", label: "Email",     field_type: "text", required: false },
          { key: "role",  label: "Role",      field_type: "text", required: false },
        ],
      },
      {
        key: "trust",
        label: "Trusts",
        position: 2,
        columnDefs: [
          { key: "name",       label: "Trust Name",   field_type: "text", required: true  },
          { key: "trustee",    label: "Trustee",      field_type: "text", required: false },
          { key: "settled_at", label: "Settled Date", field_type: "date", required: false },
        ],
      },
    ],
    relations: [
      { key: "owns",     label: "Owns",    fromEntityKey: "company", toEntityKey: "company", edgeProps: [{ key: "ownership_pct", label: "Ownership %", field_type: "decimal" }] },
      { key: "controls", label: "Controls", fromEntityKey: "company", toEntityKey: "company" },
      { key: "filed_by", label: "Filed By", fromEntityKey: "company", toEntityKey: "person"  },
    ],
    hasSampleData: true,
  },
};

export function getTemplateDef(key: string): TemplateDef | undefined {
  return CATALOG[key];
}

export function listTemplateSummaries(): TemplateSummaryDTO[] {
  return Object.values(CATALOG).map(({ key, name, description, tags }) => ({ key, name, description, tags }));
}
