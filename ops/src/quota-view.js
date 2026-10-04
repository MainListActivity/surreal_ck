/**
 * 配额运营工作区详情面板的字段路径与展示口径（纯函数，无 DOM，可单测）。
 *
 * 只按 GET /api/ops/quota/workspaces/:slug 的 operator view 真实响应形状读取
 * （契约见 shared/src/native-quota/api.ts，产出见
 * server/src/quota/quota-read-service.ts 的 operatorView）：
 * - 资源行：resource.usage.used / resource.usage.limit（finite），unlimited 只有 used；
 * - 当前计划：view.applied.plan_name（+ plan_revision）；
 * - 配额状态：view.statuses.capacity；
 * - 工作区 ID：view.operator.workspace_record（回落 view.workspace.id）；
 * - 时间线行：item.label / item.state / item.kind / item.occurred_at。
 *
 * 本模块只做读取与展示口径：不新增、不修改任何 API 契约，也不改变调用方式。
 */

/** 容量状态文案：覆盖 QuotaCapacityState 全部六态；缺失或未知如实显示，绝不默认成 normal。 */
const CAPACITY_LABELS = Object.freeze({
  normal: "正常",
  warning: "预警",
  critical: "危急",
  at_limit: "已达上限",
  over_limit: "已超上限",
  unknown: "未知",
});

export function capacityLabel(capacity) {
  return CAPACITY_LABELS[capacity] ?? "未知";
}

/**
 * 从 usage 对象取 used/limit。unlimited 只有 used（limit 为 null，展示“不限”）；
 * used 为 null 表示账本不可信/未观测，调用方按“—”展示，不猜 0。
 */
export function usageNumbers(usage) {
  if (!usage || typeof usage !== "object") {
    return { used: null, limit: null, unlimited: false };
  }
  if (usage.kind === "unlimited") {
    return { used: usage.used ?? null, limit: null, unlimited: true };
  }
  return { used: usage.used ?? null, limit: usage.limit ?? null, unlimited: false };
}

/** 当前计划文案：未绑定期返回 null（展示“—”），不猜套餐名。 */
export function planLabel(applied) {
  if (!applied || typeof applied !== "object" || !applied.plan_name) return null;
  const revision = applied.plan_revision;
  return revision === null || revision === undefined
    ? applied.plan_name
    : `${applied.plan_name} · r${revision}`;
}

/** 工作区记录 ID：优先运营视图的 workspace_record，缺失才回落 workspace.id。 */
export function workspaceRecordId(view) {
  const record = view?.operator?.workspace_record;
  if (typeof record === "string" && record) return record;
  const id = view?.workspace?.id;
  return typeof id === "string" && id ? id : null;
}

/** 时间线展示时间：ISO 串取到秒，非串原样返回（由调用方兜底“—”）。 */
export function timelineTime(occurredAt) {
  return typeof occurredAt === "string" && occurredAt.length >= 19
    ? occurredAt.slice(0, 19).replace("T", " ")
    : null;
}

/** 时间线行主文案：label（做了什么，缺失回落 kind）· state（结果）· 错误码（如有）。 */
export function timelineDetail(item) {
  const head = typeof item?.label === "string" && item.label ? item.label : item?.kind ?? null;
  const parts = [head, item?.state];
  if (item?.error_code) parts.push(`错误 ${item.error_code}`);
  const detail = parts.filter((part) => typeof part === "string" && part).join(" · ");
  return detail || null;
}
