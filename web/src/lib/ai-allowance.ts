import {
  AI_CHAT_ACTION_KEY,
  type AiAllowanceBucketView,
  type AiAllowanceLedgerView,
  type AiAllowanceSnapshot,
} from "@surreal-ck/shared";
import type { SurrealConn } from "./surreal";
import { recordValueToString } from "./record-id";

/** 账本条目对客户可读的类别名。 */
export const aiAllowanceLedgerKindLabels: Record<AiAllowanceLedgerView["kind"], string> = {
  grant: "授予",
  reserve: "预留",
  settle: "结算",
  release: "释放返还",
  expire: "到期失效",
  writeoff: "过期冲销",
};

/** 账本条目对可用额度的方向：授予与释放返还为入，其余为出。 */
export function aiAllowanceLedgerSign(kind: AiAllowanceLedgerView["kind"]): "+" | "-" {
  return kind === "grant" || kind === "release" ? "+" : "-";
}

/** 额度桶类别名。 */
export const aiAllowanceBucketKindLabels: Record<AiAllowanceBucketView["kind"], string> = {
  plan_cycle: "套餐周期",
  purchased: "购买加量",
  compensation: "人工补偿",
};

/** 账本/桶时间统一短格式（本地时区 MM-DD HH:mm）。 */
export function formatAllowanceTime(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(time));
}

/** 桶当前状态的可读标签：已过期 > 已终止（含来源切换失格）> 已暂停 > 生效中。 */
export function aiAllowanceBucketStatusLabel(
  bucket: Pick<AiAllowanceBucketView, "expired" | "status" | "terminated">
    & { unusableBySource?: boolean },
): string {
  if (bucket.expired) return "已过期";
  if (bucket.terminated || bucket.unusableBySource === true) return "已终止";
  if (bucket.status === "suspended") return "已暂停";
  return "生效中";
}

/**
 * LCA05 工作区共享 AI 额度：浏览器直连 workspace db 只读账本
 * （成员 FOR select 放行；写入全部由服务端 root 经门禁落账）。
 */

function asString(value: unknown): string {
  return String(recordValueToString(value) ?? "");
}

function asNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

function asDateMs(value: unknown): number {
  const t = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * LCA-14 返工 D2：与服务端 reserve（server/src/ai-allowance/service.ts
 * entitlementGate）同口径的读端门禁。plan_cycle 桶只有 period_key 以
 * `<baseKind>:<baseId>:` 开头才对齐当前有效商业来源；来源为 none 或快照
 * 缺失时传 planCyclePrefix = null——全部 plan_cycle 桶按不可消费计。
 * 未传 gate 时保持旧行为（不过滤），调用方应总是提供。
 */
export type AiAllowanceSourceGate = Readonly<{
  planCyclePrefix: string | null;
}>;

export function planCyclePrefixFor(baseSource: { kind: string; sourceId: string | null } | null | undefined): string | null {
  if (!baseSource) return null;
  if ((baseSource.kind === "trial" || baseSource.kind === "subscription") && baseSource.sourceId) {
    return `${baseSource.kind}:${baseSource.sourceId}:`;
  }
  return null;
}

export async function loadAiAllowanceSnapshot(
  conn: Pick<SurrealConn, "query">,
  gate?: AiAllowanceSourceGate,
): Promise<AiAllowanceSnapshot> {
  const [rateRows, bucketRows, entryRows, noticeRows] = await Promise.all([
    conn.query<Record<string, unknown>>(
      `SELECT id, amount, revision, revision_label, tier_label FROM ai_rate_card
       WHERE action_key = $action AND status = "active" ORDER BY revision DESC LIMIT 1`,
      { action: AI_CHAT_ACTION_KEY },
    ),
    conn.query<Record<string, unknown>>(
      `SELECT id, kind, label, period_key, total, available, reserved, settled, status,
              terminated_at, effective_from, expires_at
       FROM ai_allowance_bucket ORDER BY expires_at ASC`,
    ),
    conn.query<Record<string, unknown>>(
      `SELECT id, kind, amount, note, created_at FROM ai_ledger_entry ORDER BY created_at DESC LIMIT 20`,
    ),
    conn.query<Record<string, unknown>>(
      `SELECT id, period_key, threshold, message, created_at FROM ai_allowance_notice ORDER BY created_at DESC LIMIT 20`,
    ),
  ]);

  const now = Date.now();
  const buckets: AiAllowanceBucketView[] = bucketRows.map((row) => {
    const expiresAt = asIso(row.expires_at);
    const kind = String(row.kind) as AiAllowanceBucketView["kind"];
    const periodKey = asString(row.period_key);
    const unusableBySource = gate !== undefined
      && kind === "plan_cycle"
      && !(gate.planCyclePrefix !== null && periodKey.startsWith(gate.planCyclePrefix));
    return {
      id: asString(row.id),
      kind,
      label: typeof row.label === "string" ? row.label : "",
      period_key: periodKey,
      total: asNumber(row.total),
      available: asNumber(row.available),
      reserved: asNumber(row.reserved),
      settled: asNumber(row.settled),
      status: row.status === "suspended" ? "suspended" : "active",
      effective_from: asIso(row.effective_from),
      expires_at: expiresAt,
      expired: asDateMs(row.expires_at) <= now,
      terminated: row.terminated_at != null,
      unusableBySource,
    };
  });

  const rate = rateRows[0];
  const snapshot: AiAllowanceSnapshot = {
    metered: rate !== undefined,
    quote: rate
      ? {
          action: AI_CHAT_ACTION_KEY,
          amount: asNumber(rate.amount),
          revisionLabel: asString(rate.revision_label),
          tierLabel: typeof rate.tier_label === "string" ? rate.tier_label : "",
        }
      : null,
    available: 0,
    reserved: 0,
    suspended: 0,
    terminated: 0,
    expired: 0,
    buckets,
    entries: entryRows.map((row) => ({
      id: asString(row.id),
      kind: String(row.kind) as AiAllowanceLedgerView["kind"],
      amount: asNumber(row.amount),
      note: typeof row.note === "string" ? row.note : "",
      created_at: asIso(row.created_at),
    })),
    notices: noticeRows.map((row) => ({
      id: asString(row.id),
      period_key: asString(row.period_key),
      threshold: asNumber(row.threshold) as 50 | 80 | 100,
      message: typeof row.message === "string" ? row.message : "",
      created_at: asIso(row.created_at),
    })),
  };

  for (const bucket of buckets) {
    if (bucket.expired) snapshot.expired += bucket.available + bucket.reserved;
    else if (bucket.terminated || bucket.unusableBySource) snapshot.terminated += bucket.available + bucket.reserved;
    else if (bucket.status === "suspended") snapshot.suspended += bucket.available + bucket.reserved;
    else {
      snapshot.available += bucket.available;
      snapshot.reserved += bucket.reserved;
    }
  }
  return snapshot;
}
