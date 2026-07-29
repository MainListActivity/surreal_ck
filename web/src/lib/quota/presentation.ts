import type {
  PlatformOperatorCapability,
  QuotaApiCount,
  QuotaApiResource,
  QuotaApiStatuses,
  QuotaCapacityState,
  QuotaCompliance,
  QuotaOperatorIntentKind,
  QuotaOperatorIntentStatusView,
  QuotaServiceMode,
  QuotaSyncState,
} from "@surreal-ck/shared/native-quota";
import { QuotaApiError } from "./client";

export type QuotaTone =
  | "neutral"
  | "positive"
  | "warning"
  | "critical"
  | "unknown";

export type QuotaStatusPresentation = Readonly<{
  label: string;
  description: string;
  tone: QuotaTone;
}>;

export type QuotaOpsActionDefinition = Readonly<{
  kind: QuotaOperatorIntentKind;
  label: string;
  description: string;
  capability: PlatformOperatorCapability;
  impact: "normal" | "high";
}>;

export const QUOTA_OPS_ACTIONS: readonly QuotaOpsActionDefinition[] = [
  {
    kind: "subscription_upsert",
    label: "设置手工/合同计划",
    description: "创建版本化 subscription assignment，经调和后生效。",
    capability: "subscription.manage",
    impact: "high",
  },
  {
    kind: "subscription_end",
    label: "结束计划分配",
    description: "结束当前 subscription，数据不会被删除。",
    capability: "subscription.manage",
    impact: "high",
  },
  {
    kind: "override_schedule",
    label: "排期额度调整",
    description: "建立有期限的版本化 override。",
    capability: "override.manage",
    impact: "high",
  },
  {
    kind: "override_end",
    label: "结束额度调整",
    description: "停止当前 override，恢复基础计划。",
    capability: "override.manage",
    impact: "high",
  },
  {
    kind: "reconcile_now",
    label: "立即调和",
    description: "唤醒 resolver 与 native policy reconciler。",
    capability: "reconcile.audit",
    impact: "normal",
  },
  {
    kind: "audit_now",
    label: "立即审计",
    description: "重新读取 native INFO 并更新观测状态。",
    capability: "reconcile.audit",
    impact: "normal",
  },
  {
    kind: "materialization_retry",
    label: "重试应用",
    description: "重新排队最近失败的 materialization operation。",
    capability: "reconcile.audit",
    impact: "normal",
  },
  {
    kind: "auto_reconcile_pause",
    label: "暂停自动调和",
    description: "暂停自动策略修复；不会解除 native enforcement。",
    capability: "reconcile.audit",
    impact: "high",
  },
  {
    kind: "auto_reconcile_resume",
    label: "恢复自动调和",
    description: "恢复自动策略调和并立即进入 pending。",
    capability: "reconcile.audit",
    impact: "normal",
  },
  {
    kind: "drift_reapply",
    label: "重新应用 desired",
    description: "用控制面 desired policy 覆盖外部漂移。",
    capability: "drift.manage",
    impact: "high",
  },
  {
    kind: "drift_to_override",
    label: "将漂移转为 override",
    description: "把经审核的差异建模为正式临时调整。",
    capability: "drift.manage",
    impact: "high",
  },
  {
    kind: "ledger_rebuild",
    label: "重建配额账本",
    description: "重建期间用量不可确认，数据库保持 fail-closed。",
    capability: "ledger.rebuild",
    impact: "high",
  },
] as const;

export function availableQuotaOpsActions(
  capabilities: readonly PlatformOperatorCapability[],
): readonly QuotaOpsActionDefinition[] {
  const granted = new Set(capabilities);
  return QUOTA_OPS_ACTIONS.filter((action) => granted.has(action.capability));
}

export function semanticQuotaRuleKey(resource: QuotaApiResource): string {
  if (resource.selector.kind !== "regex") return resource.key;
  const matchedTable = resource.selector.matched_tables?.find((table) =>
    resource.key.endsWith(`:${table}`)
  );
  return matchedTable
    ? resource.key.slice(0, -(matchedTable.length + 1))
    : resource.key;
}

export function overrideRuleOptions(
  resources: readonly QuotaApiResource[],
): readonly Readonly<{ key: string; label: string }>[] {
  const options = new Map<string, string>();
  for (const resource of resources) {
    const key = semanticQuotaRuleKey(resource);
    if (!options.has(key)) {
      const selector = resource.selector.kind === "regex"
        ? `正则 ${resource.selector.pattern ?? resource.selector.description}`
        : resource.selector.description;
      options.set(key, `${resource.label} · ${selector}`);
    }
  }
  return [...options].map(([key, label]) => ({ key, label }));
}

export function capacityPresentation(
  value: QuotaCapacityState,
): QuotaStatusPresentation {
  const values: Record<QuotaCapacityState, QuotaStatusPresentation> = {
    normal: {
      label: "容量正常",
      description: "所有已知资源均低于 80%。",
      tone: "positive",
    },
    warning: {
      label: "接近上限",
      description: "至少一项资源已达到 80%。",
      tone: "warning",
    },
    critical: {
      label: "容量紧张",
      description: "至少一项资源已达到 90%。",
      tone: "critical",
    },
    at_limit: {
      label: "已用满",
      description: "已到上限但尚未超额，不能继续增加。",
      tone: "critical",
    },
    over_limit: {
      label: "已超额",
      description: "允许删除或减少用量，禁止继续恶化。",
      tone: "critical",
    },
    unknown: {
      label: "容量未知",
      description: "当前用量暂不可确认，不能将未知视为 0。",
      tone: "unknown",
    },
  };
  return values[value];
}

export function syncPresentation(
  value: QuotaSyncState,
): QuotaStatusPresentation {
  const values: Record<QuotaSyncState, QuotaStatusPresentation> = {
    pending: {
      label: "待应用",
      description: "desired 变更尚未通过 native INFO 读回。",
      tone: "warning",
    },
    applying: {
      label: "应用中",
      description: "调和器正在应用原生配额策略。",
      tone: "warning",
    },
    in_sync: {
      label: "已同步",
      description: "applied projection 与 native policy 一致。",
      tone: "positive",
    },
    error: {
      label: "同步失败",
      description: "最后一次调和失败，当前 applied 配额仍是有效边界。",
      tone: "critical",
    },
    external_drift: {
      label: "检测到漂移",
      description: "原生策略与 applied projection 不一致。",
      tone: "critical",
    },
    paused: {
      label: "自动调和已暂停",
      description: "原生 enforcement 仍然生效。",
      tone: "warning",
    },
  };
  return values[value];
}

export function compliancePresentation(
  value: QuotaCompliance,
): QuotaStatusPresentation {
  return value === "compliant"
    ? { label: "合规", description: "当前用量未超过有效上限。", tone: "positive" }
    : value === "over_limit"
      ? { label: "超额", description: "当前用量超过有效上限。", tone: "critical" }
      : { label: "未知", description: "账本尚未提供可信结论。", tone: "unknown" };
}

export function serviceModePresentation(
  value: QuotaServiceMode,
): QuotaStatusPresentation {
  return value === "standard"
    ? { label: "标准服务", description: "按当前 applied 权益运行。", tone: "positive" }
    : value === "grace"
      ? { label: "宽限期", description: "付款异常宽限中，请联系计费管理员。", tone: "warning" }
      : { label: "保留模式", description: "只保留最低恢复能力，不会自动删数。", tone: "critical" };
}

export function statusCards(statuses: QuotaApiStatuses) {
  return [
    { key: "capacity", title: "容量", ...capacityPresentation(statuses.capacity) },
    { key: "compliance", title: "合规", ...compliancePresentation(statuses.compliance) },
    { key: "sync", title: "策略同步", ...syncPresentation(statuses.sync) },
    { key: "service", title: "服务模式", ...serviceModePresentation(statuses.service_mode) },
  ] as const;
}

export function formatQuotaCount(value: QuotaApiCount | null): string {
  if (value === null) return "暂不可确认";
  const number = typeof value === "string" ? Number(value) : value;
  if (Number.isSafeInteger(number)) {
    return new Intl.NumberFormat("zh-CN").format(number);
  }
  return String(value);
}

export function formatQuotaDate(value: string | null): string {
  if (!value) return "尚未观测";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function quotaApiErrorMessage(error: unknown): string {
  if (!(error instanceof QuotaApiError)) {
    return error instanceof Error ? error.message : String(error);
  }
  if (error.status === 429) return "刷新过于频繁，请等待 10 秒后重试。";
  if (error.status === 404) return "对象不存在，或当前身份没有对应能力。";
  if (error.status === 403) return "当前运营能力不足。";
  if (error.code.includes("preflight")) {
    return "预检失败：目标、计划或运营能力已变化，请重新加载。";
  }
  return error.message || "配额控制面请求失败。";
}

export function isIntentTerminal(
  value: QuotaOperatorIntentStatusView["state"],
): boolean {
  return value === "processed" || value === "terminal_failed";
}
