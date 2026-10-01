/**
 * LCA09 历史引用按当前权限展示的传输契约。
 *
 * 报告（用户成果）永远可见；平台引用逐项给出当前权限状态，只回状态与原因类别，
 * 绝不回传正文、摘录以外的内容或授权投影细节。
 * 摘录展示 = 捕获许可（引用登记的捕获时授权修订，经授权管道写入）∧ 当前留存
 * 展示约束（来源未撤回/许可未终止/删除要求，锁定态按保留模式保留已捕获摘录）；
 * 任一条件缺失或权限未知时不展示摘录。
 */
import { z } from "zod";

/** 单次核验的引用上限；超出由调用方分批。 */
export const CITATION_STATUS_MAX = 50;

export const citationStatusRequestSchema = z.strictObject({
  citations: z
    .array(
      z.strictObject({
        /** 前端引用列表里的 index（原样返回，便于回填）。 */
        index: z.number().int().positive(),
        versionPublicId: z.string().trim().min(1).max(160),
        /** 捕获时登记的授权修订（捕获许可依据）；缺失视为无留存依据。 */
        captureEntitlementRevision: z.string().regex(/^[1-9][0-9]*$/u).optional(),
      }),
    )
    .min(1)
    .max(CITATION_STATUS_MAX),
});

export type CitationStatusRequest = z.infer<typeof citationStatusRequestSchema>;

/** 引用当前展示状态：可核验 / 全文锁定 / 墓碑（撤回或删除）/ 暂不可核验。 */
export type CitationDisplayState = "verifiable" | "locked" | "tombstoned" | "unavailable";

/** 稳定原因类别：展示用，不携带平台内部细节。 */
export type CitationStatusReason =
  | "collection_not_covered"
  | "action_not_covered"
  | "entitlement_absent"
  | "entitlement_expired"
  | "license_unavailable"
  | "unpublished"
  | "deleted"
  | "member_removed"
  | "workspace_inactive"
  | "platform_unavailable";

export type CitationStatusEntry = {
  index: number;
  versionPublicId: string;
  state: CitationDisplayState;
  reason: CitationStatusReason | null;
  /** 当前授权含 read → 全文可打开（真正打开仍走当时的授权换票）。 */
  fulltextOpenable: boolean;
  /** 摘录当前可展示：捕获依据已登记 ∧ 来源未撤回/删除 ∧ 当前展示许可（cite）允许。 */
  excerptDisplayable: boolean;
};

export const citationStatusResponseSchema = z.strictObject({
  statuses: z.array(
    z.strictObject({
      index: z.number().int().positive(),
      versionPublicId: z.string(),
      state: z.enum(["verifiable", "locked", "tombstoned", "unavailable"]),
      reason: z.enum([
        "collection_not_covered",
        "action_not_covered",
        "entitlement_absent",
        "entitlement_expired",
        "license_unavailable",
        "unpublished",
        "deleted",
        "member_removed",
        "workspace_inactive",
        "platform_unavailable",
      ]).nullable(),
      fulltextOpenable: z.boolean(),
      excerptDisplayable: z.boolean(),
    }),
  ),
});

export type CitationStatusResponse = z.infer<typeof citationStatusResponseSchema>;

/** 每条状态的中文说明（前端与导出共用同一口径）。 */
export function citationStatusReasonLabel(reason: CitationStatusReason | null): string {
  switch (reason) {
    case "collection_not_covered":
      return "当前套餐集合不包含该内容";
    case "action_not_covered":
      return "当前套餐不包含所需访问动作";
    case "entitlement_absent":
      return "工作区当前没有有效内容授权（保留模式）";
    case "entitlement_expired":
      return "内容授权已到期";
    case "license_unavailable":
      return "来源许可已终止或未知";
    case "unpublished":
      return "来源已下架或撤回";
    case "deleted":
      return "内容版本已删除";
    case "member_removed":
      return "当前身份不是工作区有效成员";
    case "workspace_inactive":
      return "工作区已停用";
    case "platform_unavailable":
      return "平台服务暂不可用";
    default:
      return "权限状态未知";
  }
}
