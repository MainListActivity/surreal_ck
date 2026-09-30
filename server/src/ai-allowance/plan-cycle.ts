import { DateTime, StringRecordId } from "surrealdb";
import { stableSha256 } from "../quota/canonical";
import type { EntitlementDraft } from "../product-entitlement/resolve";
import { isRetryableTxnError, type Queryable } from "./service";

/**
 * LCA08 订阅驱动的套餐周期 AI 额度同步规则（版本化、不可变）。
 *
 * 规则版本 plan-cycle-rules-v2（相对 v1 的变化见"周期身份"）：
 * - 额度来源：工作区当前绑定产品修订的 feature `ai_cycle_allowance`
 *   （enabled 且 limit_value > 0）。数值只来自已发布的不可变产品修订，
 *   生产启用必须使用获批修订，不从测试默认值推定。
 * - 周期身份：`period_key = "<baseSourceKind>:<baseSourceId>:<cycleFrom>"`，
 *   其中 cycleFrom 是订阅级付费周期起点（订阅 current_period_start，缺省
 *   回退 item 窗口起点）。周期身份独立于周期内升级产生的订阅项窗口：
 *   周期内升级/降级（换 item、改生效时间）不换 period_key，只有续期
 *   （订阅推进到新付费周期）或试用转付费才产生新 period_key → 新桶；
 *   周期额度不结转（旧桶保留自身到期时间，不延长、不复活、不回收）。
 * - 升级补差：同周期内目标额度高于已授予额度时，一次性补发整数正差额
 *   （单位为整数额度，delta = target − granted，不做时间比例折算，无需
 *   取整）；桶的 expires_at 保持周期边界不变。
 * - 降级：差额非正时不追回已授予额度，下个周期按新计划数量授予。
 * - 到期/保留模式（usable=false 或计划未配额度）：不授予、不补差、不触碰
 *   既有桶（保留模式暂停的是新的收费动作，不重置桶到期时间，也不暂停
 *   既有余额的消费）。
 * - 试用转付费：baseSourceKind 从 trial 翻转为 subscription，period_key
 *   随之改变，付费周期新建桶，不复活旧试用余额。
 * - 幂等：桶使用由 period_key 派生的确定性 id；重复同步最多建一次桶、
 *   补一次差额（total 达到目标后 delta 恒为 0）。
 */
export const AI_PLAN_CYCLE_RULE_VERSION = "plan-cycle-rules-v2" as const;

/** 产品修订里承载套餐周期 AI 额度的 feature key。 */
export const AI_CYCLE_ALLOWANCE_FEATURE_KEY = "ai_cycle_allowance";

export type PlanCycleDirective = Readonly<{
  /** 目标 workspace database 名（账本所在库）。 */
  workspaceDb: string;
  /** 订阅基础来源当前可用（active/trialing 且在窗口内）。 */
  usable: boolean;
  periodKey: string;
  /** 本周期目标额度（整数单位）。 */
  cycleAllowance: number;
  /** 周期边界（桶到期时间）；无法确定时为 null，此时绝不授予。 */
  expiresAt: string;
  periodStart: string;
  label: string;
}>;

export type PlanCycleSyncOutcome = Readonly<{
  kind: "created" | "topup" | "none";
  delta?: number;
  bucketId?: string;
  ruleVersion: typeof AI_PLAN_CYCLE_RULE_VERSION;
}>;

type DraftFacts = Pick<
  EntitlementDraft,
  "baseSourceKind" | "baseSourceId" | "effectiveFrom" | "effectiveUntil" | "productPlanName" | "features"
>;

/** 订阅级付费周期身份（来自 SubscriptionFact，见 store.activeItem）。 */
export type CycleIdentity = Readonly<{
  cycleFrom: string | null;
  cycleUntil: string | null;
}>;

/**
 * 从权益草稿推导周期额度指令。base source 不可用（到期/无来源）或计划
 * 未配置周期额度时返回 null，同步器据此跳过（不授予也不改动既有桶）。
 * 周期身份由调用方从订阅事实传入（cycleFrom/cycleUntil，缺省回退 item
 * 窗口）；周期内升级（换 item）不改变周期身份，续期才换。
 */
export function planCycleDirective(
  workspaceDb: string | null,
  draft: DraftFacts,
  cycle: CycleIdentity | null,
): PlanCycleDirective | null {
  if (!workspaceDb) return null;
  if (draft.baseSourceKind === "none") return null;
  if (!draft.baseSourceId) return null;
  const periodFrom = cycle?.cycleFrom ?? draft.effectiveFrom;
  const periodUntil = cycle?.cycleUntil ?? draft.effectiveUntil;
  if (!periodFrom || !periodUntil) return null;
  const feature = draft.features.find((item) => item.key === AI_CYCLE_ALLOWANCE_FEATURE_KEY);
  if (!feature || !feature.enabled || feature.limit === null || feature.limit <= 0) return null;
  return Object.freeze({
    workspaceDb,
    usable: true,
    periodKey: `${draft.baseSourceKind}:${draft.baseSourceId}:${periodFrom}`,
    cycleAllowance: feature.limit,
    expiresAt: periodUntil,
    periodStart: periodFrom,
    label: `${draft.productPlanName ?? "套餐"}周期 AI 额度`,
  });
}

function planCycleBucketId(periodKey: string): string {
  return `pc_${stableSha256(periodKey).slice(0, 24)}`;
}

const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|duplicate|unique/iu.test(message);
}

type BucketState = { total: number; available: number };

async function readBucket(
  session: Queryable,
  bucket: StringRecordId,
): Promise<BucketState | null> {
  const rows = await session.query(
    `SELECT total, available FROM ONLY $bucket;`,
    { bucket },
  );
  const statement = Array.isArray(rows) ? rows[0] : rows;
  if (!statement || typeof statement !== "object") return null;
  const row = statement as Record<string, unknown>;
  const total = typeof row.total === "number" ? row.total : Number(row.total);
  const available = typeof row.available === "number" ? row.available : Number(row.available);
  if (!Number.isFinite(total) || !Number.isFinite(available)) return null;
  return { total, available };
}

/**
 * 把周期额度指令落到目标 workspace 的额度账本（root 会话）：周期内没有
 * plan_cycle 桶则按目标额度建桶，已有桶且目标更高则补发正差额；其余情况
 * 一律不动既有桶。重复调用与并发竞争都收敛到同一终态：桶 id 由 period_key
 * 确定性派生，目标回写在事务内以 `total < $target` 守卫，金额按事务内
 * 读到的既有 total 精确计算，绝不越过目标额度。
 */
export async function syncPlanCycleAllowance(input: {
  session: Queryable;
  directive: PlanCycleDirective;
  correlationId: string;
}): Promise<PlanCycleSyncOutcome> {
  const { directive } = input;
  if (!directive.usable || directive.cycleAllowance <= 0) {
    return { kind: "none", ruleVersion: AI_PLAN_CYCLE_RULE_VERSION };
  }
  const bucket = new StringRecordId(`ai_allowance_bucket:${planCycleBucketId(directive.periodKey)}`);
  const bindings = {
    bucket,
    label: directive.label,
    source: `lifecycle:${input.correlationId}`,
    period: directive.periodKey,
    target: directive.cycleAllowance,
    from: new DateTime(directive.periodStart),
    until: new DateTime(directive.expiresAt),
    note: `${AI_PLAN_CYCLE_RULE_VERSION} plan-cycle sync ${directive.periodKey}`,
  };
  for (let attempt = 0; ; attempt += 1) {
    const before = await readBucket(input.session, bucket);
    try {
      await input.session.query(
        `
        BEGIN;
        LET $pre = (SELECT total, available FROM ONLY $bucket);
        IF $pre = NONE {
          CREATE $bucket CONTENT {
            kind: "plan_cycle", label: $label, source: $source, period_key: $period,
            total: $target, available: $target, reserved: 0, settled: 0,
            effective_from: $from, expires_at: $until
          };
          CREATE ai_ledger_entry CONTENT {
            kind: "grant", bucket: $bucket, amount: $target,
            note: $note, resulting_available: $target
          };
        };
        IF $pre != NONE AND $pre.total < $target {
          UPDATE $bucket SET total = $target, available = available + ($target - $pre.total),
            updated_at = time::now();
          CREATE ai_ledger_entry CONTENT {
            kind: "grant", bucket: $bucket, amount: $target - $pre.total,
            note: $note, resulting_available: $pre.available + ($target - $pre.total)
          };
        };
        COMMIT;
        `,
        bindings,
      );
    } catch (error) {
      // 并发对手先建了同 id 桶 → 重读后走补差判断；可重试事务冲突 → 退避重试。
      if ((isConflict(error) || isRetryableTxnError(error)) && attempt + 1 < MAX_ATTEMPTS) {
        await sleep(5 + Math.random() * 20 * (attempt + 1));
        continue;
      }
      throw error;
    }
    const after = await readBucket(input.session, bucket);
    if (!after) throw new Error("plan cycle bucket missing after sync");
    if (before === null && after.total > 0) {
      return { kind: "created", delta: after.total, bucketId: bucket.toString(), ruleVersion: AI_PLAN_CYCLE_RULE_VERSION };
    }
    if (before !== null && after.total > before.total) {
      return { kind: "topup", delta: after.total - before.total, bucketId: bucket.toString(), ruleVersion: AI_PLAN_CYCLE_RULE_VERSION };
    }
    return { kind: "none", delta: 0, bucketId: bucket.toString(), ruleVersion: AI_PLAN_CYCLE_RULE_VERSION };
  }
}

/** 周期额度同步入口：按指令打开目标 workspace 账本会话并落规则。 */
export class AiAllowancePlanCycleSynchronizer {
  constructor(
    private readonly deps: Readonly<{
      workspaceSession(db: string): Promise<Queryable>;
    }>,
  ) {}

  async sync(
    directive: PlanCycleDirective,
    correlationId: string,
  ): Promise<PlanCycleSyncOutcome> {
    const session = await this.deps.workspaceSession(directive.workspaceDb);
    return await syncPlanCycleAllowance({ session, directive, correlationId });
  }
}
