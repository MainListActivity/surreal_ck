import type {
  CreateDashboardViewResponse,
  DashboardViewDraftDTO,
  PreviewDashboardViewResponse,
  ReferenceTargetOption,
} from "../../shared/rpc.types";
import { createDashboardView, previewDashboardDraft } from "./dashboards";
import { listReferenceTargets } from "./references";

const SYSTEM_TARGETS: ReferenceTargetOption[] = [
  { table: "workspace", label: "系统：工作区", displayKeys: [] },
  { table: "workbook", label: "系统：工作簿", displayKeys: [] },
  { table: "sheet", label: "系统：Sheet", displayKeys: [] },
  { table: "folder", label: "系统：目录", displayKeys: [] },
];

export async function listDashboardGenerationTargets(): Promise<ReferenceTargetOption[]> {
  const res = await listReferenceTargets();
  return [
    ...SYSTEM_TARGETS,
    ...res.targets.filter((target) => !SYSTEM_TARGETS.some((item) => item.table === target.table)),
  ];
}

export async function previewGeneratedDashboardView(
  draft: DashboardViewDraftDTO,
): Promise<PreviewDashboardViewResponse> {
  return previewDashboardDraft(draft);
}

export async function saveGeneratedDashboardView(
  draft: DashboardViewDraftDTO,
): Promise<CreateDashboardViewResponse> {
  return createDashboardView({ draft });
}
