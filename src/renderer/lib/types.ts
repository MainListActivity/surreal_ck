export type ScreenId =
  | "home"
  | "mydocs"
  | "dashboard"
  | "editor"
  | "form"
  | "form-success"
  | "templates"
  | "admin"
  | "admin-console"
  | "state-empty"
  | "state-offline"
  | "state-noperm";

export type Workbook = {
  id: number;
  name: string;
  template: string;
  modified: string;
  modifier: string;
  pinned?: boolean;
  fileType: "excel" | "word";
};

export type FolderNode = {
  id: string;
  name: string;
  children: string[];
  parent?: string;
};

export type CreditorRow = {
  id: number;
  name: string;
  idNo: string;
  contact: string;
  amount: string;
  type: string;
  date: string;
  docs: number;
  status: string;
  note: string;
};

export type TemplateItem = {
  id: number;
  name: string;
  desc: string;
  type: string;
  tags: string[];
};

export type RouteState = {
  screen: ScreenId;
  dashboardPageId?: string;
  workbookId?: string;
  sheetId?: string;
  folderId?: string;
  templateKey?: string;
};

export type Navigate = (screen: ScreenId, params?: Omit<RouteState, "screen">) => void;
