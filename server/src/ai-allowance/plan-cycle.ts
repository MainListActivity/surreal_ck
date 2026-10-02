import { DateTime, StringRecordId } from "surrealdb";
import { stableSha256 } from "../quota/canonical";
import type { EntitlementDraft } from "../product-entitlement/resolve";
import { isRetryableTxnError, type Queryable } from "./service";

/**
 * LCA08 订阅驱动的套餐周期 AI 额度同步规则（版本化、不可变）。
 *
 * 规则版本 plan-cycle-rules-v3（相对 v2 的变化见"升级补发"与"试用终止"）：
 * - 额度来源：工作区当前绑定产品修订的 feature `ai_cycle_allowance`
 *   （enabled 且 limit_value > 0）。数值只来自已发布的不可变产品修订，
 *   生产启用必须使用获批修订，不从测试默认值推定。
 * - 周期身份：`period_key = "<baseSourceKind>:<baseSourceId>:<cycleFrom>"`，
 *   其中 cycleFrom 是订阅级付费周期起点（订阅 current_period_start，缺省
 *   回退 item 窗口起点）。周期身份独立于周期内升级产生的订阅项窗口：
 *   周期内升级/降级（换 item、改生效时间）不换 period_key，只有续期
 *   （订阅推进到新付费周期）或试用转付费才产生新 period_key → 新桶；
 *   周期额度不结转（旧桶保留自身到期时间，不延长、不复活、不回收）。
 * - 基础周期桶：每周期只在首次同步时按当时目标额度一次性授予，此后绝不为
 *   升级 UPDATE 其 total/available（升级差异走独立补发桶）。
 * - 升级补发（AC6，独立补发桶 + 精确整数折算）：
 *   维护周期内"已兑现最高完整周期额度 H"（基础授予与历史升级记录的高水位，
 *   不取当前余额）。仅当新确认目标 A > H 时产生未兑现提升：未取整累计补发
 *   R 追加 (A−H)*remaining，其中 remaining = clamp(周期end − 事件effectiveAt,
 *   0, 周期时长)/周期时长，effectiveAt 来自已确认商业事件（订阅项生效时间），
 *   重试不得改用 now。实际新授予 = max(0, floor(R) − 历史已授予升级额度)，
 *   统一向下取整到整数单位；每次合法补差形成独立补发桶，在当前周期末到期，
 *   携带 source/period/商业事件/规则版本审计。全部用精确整数（分子/分母）
 *   计算，无浮点。H 仅增长，不因降级/消费/重放降低；同一已确认事件、目标
 *   修订及周期事务唯一去重，并发总授予不超过该累计规则。
 *   折算规则版本 `lca08-upgrade-proration-test-v1` 仅用于测试报价与验收；
 *   生产真实商品修订需运营明确批准后另行启用。
 * - 降级：目标不高于 H 时不追回已授予额度，下个周期按新计划数量授予。
 * - 到期/保留模式（usable=false 或计划未配额度）：不授予、不补差、不触碰
 *   既有桶（保留模式暂停的是新的收费动作，不重置桶到期时间，也不暂停
 *   既有余额的消费）。
 * - 试用终止（AC5）：商业确认转付费生效时（baseSourceKind 翻转为
 *   subscription），当次关联旧试用桶（period_key 前缀 trial:<试用来源ID>:，
 *   其中试用来源ID是试用期的 quota_subscription 记录，与转付费后的新
 *   baseSourceId 不是同一行）立即失去新 reserve 与可消费 balance 资格：
 *   本工作区账本内一切未终止的 trial: 前缀 plan_cycle 桶写入幂等终止标记
 *   （terminated_at/terminated_note），不改金额、不延长期限、不删除或改写
 *   旧账本。其上既有预留仍可在有限执行窗口内按原桶/原费率结算；超时/取消/
 *   部分交付释放时只记 writeoff 冲销，绝不返成可消费余额（见 service.ts）。
 *   重复转换、恢复订阅、乱序旧事件不撤销标记、不复活试用。
 * - 幂等：基础桶 id 由 period_key 派生、补发桶 id 由 (period_key, 事件键)
 *   派生；重复同步最多建一次桶、补一次差额。
 */
export const AI_PLAN_CYCLE_RULE_VERSION = "plan-cycle-rules-v3" as const;

/** 升级折算规则版本：经理批准的不可变测试报价规则（非生产商品数值）。 */
export const AI_UPGRADE_PRORATION_RULE_VERSION = "lca08-upgrade-proration-test-v1" as const;

/** 产品修订里承载套餐周期 AI 额度的 feature key。 */
export const AI_CYCLE_ALLOWANCE_FEATURE_KEY = "ai_cycle_allowance";

export type PlanCycleDirective = Readonly<{
  /** 目标 workspace database 名（账本所在库）。 */
  workspaceDb: string;
  /** 订阅基础来源当前可用（active/trialing 且在窗口内）。 */
  usable: boolean;
  /** 当前商业来源类型（非 none 时才是 subscription/trial 之一）。 */
  baseSourceKind: "subscription" | "trial";
  baseSourceId: string;
  periodKey: string;
  /** 本周期目标额度（整数单位）。 */
  cycleAllowance: number;
  /** 周期边界（桶到期时间）；无法确定时为 null，此时绝不授予。 */
  expiresAt: string;
  periodStart: string;
  /** 产生当前目标的已确认商业事件（订阅项）身份与生效时间（补发事件键/折算时点）。 */
  eventKey: string;
  eventEffectiveAt: string;
  label: string;
}>;

export type PlanCycleSyncOutcome = Readonly<{
  kind: "created" | "supplement" | "none";
  delta?: number;
  bucketId?: string;
  /** 本次同步标记终止的旧试用桶数量（仅诊断，幂等重跑为 0）。 */
  trialTerminated?: number;
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

/** 已确认商业事件身份（当前订阅项）：事件键 + 折算生效时间。 */
export type CycleEventIdentity = Readonly<{
  key: string;
  effectiveAt: string;
}>;

/**
 * 从权益草稿推导周期额度指令。base source 不可用（到期/无来源）或计划
 * 未配置周期额度时返回 null，同步器据此跳过（不授予也不改动既有桶）。
 * 周期身份与事件身份均由调用方从订阅事实传入：周期内升级（换 item）不
 * 改变周期身份，续期才换；事件身份（item id + item 生效时间）是升级补发
 * 的事件键与折算时点，来自已确认商业事件，重试不得改用 now。
 */
export function planCycleDirective(
  workspaceDb: string | null,
  draft: DraftFacts,
  cycle: CycleIdentity | null,
  event: CycleEventIdentity | null,
): PlanCycleDirective | null {
  if (!workspaceDb) return null;
  if (draft.baseSourceKind === "none") return null;
  if (!draft.baseSourceId) return null;
  if (!event || !event.key || !event.effectiveAt) return null;
  const periodFrom = cycle?.cycleFrom ?? draft.effectiveFrom;
  const periodUntil = cycle?.cycleUntil ?? draft.effectiveUntil;
  if (!periodFrom || !periodUntil) return null;
  const feature = draft.features.find((item) => item.key === AI_CYCLE_ALLOWANCE_FEATURE_KEY);
  if (!feature || !feature.enabled || feature.limit === null || feature.limit <= 0) return null;
  return Object.freeze({
    workspaceDb,
    usable: true,
    baseSourceKind: draft.baseSourceKind,
    baseSourceId: draft.baseSourceId,
    periodKey: `${draft.baseSourceKind}:${draft.baseSourceId}:${periodFrom}`,
    cycleAllowance: feature.limit,
    expiresAt: periodUntil,
    periodStart: periodFrom,
    eventKey: event.key,
    eventEffectiveAt: event.effectiveAt,
    label: `${draft.productPlanName ?? "套餐"}周期 AI 额度`,
  });
}

/**
 * 升级折算的纯计算（lca08-upgrade-proration-test-v1）：精确整数，无浮点。
 * 仅 A > H 时追加未取整累计 (A−H)*remainingMs；实际授予 = max(0,
 * floor(累计R/分母) − 历史已授予)。H 仅增长。remainingMs 由调用方用
 * clamp(周期end − 事件effectiveAt, 0, 周期时长) 传入。
 */
export function applyUpgradeProration(input: Readonly<{
  highWater: number;
  target: number;
  rNum: number;
  rDen: number;
  remainingMs: number;
  grantedTotal: number;
}>): Readonly<{ highWater: number; rNum: number; grantedTotal: number; grant: number }> {
  const { highWater, target, rNum, rDen, grantedTotal } = input;
  if (!(rDen > 0)) return { highWater, rNum, grantedTotal, grant: 0 };
  if (!Number.isSafeInteger(rNum) || !Number.isSafeInteger(grantedTotal) || !Number.isSafeInteger(target)) {
    throw new Error("upgrade proration inputs must be safe integers");
  }
  if (target <= highWater) return { highWater, rNum, grantedTotal, grant: 0 };
  const remainingMs = Math.min(Math.max(Math.trunc(input.remainingMs), 0), rDen);
  const nextNum = rNum + (target - highWater) * remainingMs;
  if (!Number.isSafeInteger(nextNum)) throw new Error("upgrade proration numerator overflow");
  // 非负整数 floor(a / b) = (a - a % b) / b，避免依赖引擎除法语义。
  const grant = Math.max(0, (nextNum - (nextNum % rDen)) / rDen - grantedTotal);
  return { highWater: target, rNum: nextNum, grantedTotal: grantedTotal + grant, grant };
}

function planCycleBucketId(periodKey: string): string {
  return `pc_${stableSha256(periodKey).slice(0, 24)}`;
}

/** 补发桶 id：由 (period_key, 事件键) 确定性派生，同一事件重试不重复建桶。 */
function planUpgradeBucketId(periodKey: string, eventKey: string): string {
  return `pcu_${stableSha256(`${periodKey}|${eventKey}`).slice(0, 24)}`;
}

/** 周期折算状态行 id：每周期一行，确定性派生。 */
function planUpgradeStateRowId(periodKey: string): string {
  return `pus_${stableSha256(periodKey).slice(0, 24)}`;
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

type StateRow = {
  high_water: number;
  r_num: number;
  r_den: number;
  granted_total: number;
  events: unknown;
};

async function readUpgradeState(session: Queryable, state: StringRecordId): Promise<StateRow | null> {
  const rows = await session.query(`SELECT high_water, r_num, r_den, granted_total, events FROM ONLY $state;`, { state });
  const statement = Array.isArray(rows) ? rows[0] : rows;
  if (!statement || typeof statement !== "object") return null;
  const row = statement as Record<string, unknown>;
  const numberField = (value: unknown): number | null => {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const highWater = numberField(row.high_water);
  const rNum = numberField(row.r_num);
  const rDen = numberField(row.r_den);
  const granted = numberField(row.granted_total);
  if (highWater === null || rNum === null || rDen === null || granted === null) return null;
  return { high_water: highWater, r_num: rNum, r_den: rDen, granted_total: granted, events: row.events };
}

/**
 * AC5：转付费商业确认生效时终止关联旧试用桶。只写幂等终止标记（含商业
 * 事件审计），不改金额、不延长期限、不删除或改写旧账本；购买/补偿桶与
 * 付费周期桶一概不触碰。返回本次新标记的桶数量。
 *
 * LCA-14 返工 D3：试用桶 period_key 内嵌的是试用期 quota_subscription
 * 记录 id（trial:<试用来源ID>:…），转付费后 directive.baseSourceId 已是新
 * 付费订阅 id——按 `trial:<新订阅ID>:` 过滤永远不匹配（生产实测残留
 * active 试用桶）。工作区账本内至多一条试用来源血统，凡未终止的 trial:
 * 前缀 plan_cycle 桶即"当次关联旧试用桶"，全部标记终止。
 */
async function terminateTrialSourceBuckets(
  session: Queryable,
  directive: PlanCycleDirective,
  correlationId: string,
): Promise<number> {
  const result = await session.query(
    `
    UPDATE ai_allowance_bucket SET
      terminated_at = $terminatedAt,
      terminated_note = $note,
      updated_at = time::now()
    WHERE kind = "plan_cycle" AND string::starts_with(period_key, "trial:") AND terminated_at = NONE;
    `,
    {
      terminatedAt: new DateTime(directive.periodStart),
      note: `${AI_PLAN_CYCLE_RULE_VERSION} trial source terminated on paid conversion; event ${directive.eventKey}; correlation ${correlationId}`,
    },
  );
  const statement = Array.isArray(result) ? result[0] : result;
  return Array.isArray(statement) ? statement.length : 0;
}

/**
 * 把周期额度指令落到目标 workspace 的额度账本（root 会话）：
 * 1. baseSourceKind = subscription 时先终止关联旧试用桶（AC5，幂等）；
 * 2. 周期内没有基础桶则按当时目标一次性建桶（此后不再 UPDATE 它）；
 * 3. 目标高于周期高水位 H 时按折算规则补发独立升级桶（AC6，幂等）。
 * 重复调用与并发竞争都收敛到同一终态：桶/状态行 id 确定性派生，状态行
 * 更新在单事务内按精确整数累计，冲突退避重试。
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
  const trialTerminated = directive.baseSourceKind === "subscription"
    ? await terminateTrialSourceBuckets(input.session, directive, input.correlationId)
    : 0;

  const baseBucket = new StringRecordId(`ai_allowance_bucket:${planCycleBucketId(directive.periodKey)}`);
  const baseBindings = {
    bucket: baseBucket,
    label: directive.label,
    source: `lifecycle:${input.correlationId}`,
    period: directive.periodKey,
    target: directive.cycleAllowance,
    from: new DateTime(directive.periodStart),
    until: new DateTime(directive.expiresAt),
    note: `${AI_PLAN_CYCLE_RULE_VERSION} plan-cycle base grant ${directive.periodKey}`,
  };
  const baseBefore = await readBucket(input.session, baseBucket);
  if (baseBefore === null) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await input.session.query(
          `
          BEGIN;
          LET $pre = (SELECT total FROM ONLY $bucket);
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
          COMMIT;
          `,
          baseBindings,
        );
        break;
      } catch (error) {
        // 并发对手先建了同 id 桶 → 重读后按存在跳过；可重试事务冲突 → 退避重试。
        if ((isConflict(error) || isRetryableTxnError(error)) && attempt + 1 < MAX_ATTEMPTS) {
          await sleep(5 + Math.random() * 20 * (attempt + 1));
          continue;
        }
        throw error;
      }
    }
  }

  const supplement = await syncUpgradeSupplement(input);
  if (supplement.kind === "supplement") {
    return { ...supplement, trialTerminated, ruleVersion: AI_PLAN_CYCLE_RULE_VERSION };
  }
  const baseAfter = baseBefore === null ? await readBucket(input.session, baseBucket) : baseBefore;
  if (baseBefore === null && baseAfter && baseAfter.total > 0) {
    return {
      kind: "created",
      delta: baseAfter.total,
      bucketId: baseBucket.toString(),
      trialTerminated,
      ruleVersion: AI_PLAN_CYCLE_RULE_VERSION,
    };
  }
  return { kind: "none", delta: 0, bucketId: baseBucket.toString(), trialTerminated, ruleVersion: AI_PLAN_CYCLE_RULE_VERSION };
}

/**
 * AC6 升级补发：目标 A 高于周期高水位 H 时，按已确认事件生效时间的剩余
 * 周期比例折算未取整差额，实际授予为累计 floor 减历史已授予，形成独立
 * 补发桶（当前周期末到期）。状态行单事务累计：并发竞争靠事务冲突退避
 * 串行化，总授予不超过累计规则；同一事件键重放被 events 去重跳过。
 */
async function syncUpgradeSupplement(input: {
  session: Queryable;
  directive: PlanCycleDirective;
  correlationId: string;
}): Promise<PlanCycleSyncOutcome> {
  const { session, directive } = input;
  const periodFromMs = Date.parse(directive.periodStart);
  const periodUntilMs = Date.parse(directive.expiresAt);
  const effectiveMs = Date.parse(directive.eventEffectiveAt);
  const rDen = periodUntilMs - periodFromMs;
  if (!Number.isFinite(rDen) || rDen <= 0 || !Number.isFinite(effectiveMs)) {
    return { kind: "none", ruleVersion: AI_PLAN_CYCLE_RULE_VERSION };
  }
  const remainingMs = Math.min(Math.max(periodUntilMs - effectiveMs, 0), rDen);

  const baseBucket = new StringRecordId(`ai_allowance_bucket:${planCycleBucketId(directive.periodKey)}`);
  const stateRow = new StringRecordId(`ai_plan_upgrade_state:${planUpgradeStateRowId(directive.periodKey)}`);
  const supplementBucket = new StringRecordId(
    `ai_allowance_bucket:${planUpgradeBucketId(directive.periodKey, directive.eventKey)}`,
  );

  for (let attempt = 0; ; attempt += 1) {
    const before = await readBucket(session, supplementBucket);
    if (before !== null) {
      // 同一事件已补发过：确定性桶 id 命中即幂等返回。
      return { kind: "none", delta: 0, bucketId: supplementBucket.toString(), ruleVersion: AI_PLAN_CYCLE_RULE_VERSION };
    }
    const state = await readUpgradeState(session, stateRow);
    const base = await readBucket(session, baseBucket);
    if (base === null) {
      return { kind: "none", ruleVersion: AI_PLAN_CYCLE_RULE_VERSION };
    }
    const highWater = state ? state.high_water : base.total;
    if (directive.cycleAllowance <= highWater) {
      return { kind: "none", ruleVersion: AI_PLAN_CYCLE_RULE_VERSION };
    }
    if (state && Array.isArray(state.events) && state.events.some((item) => String(item) === directive.eventKey)) {
      return { kind: "none", ruleVersion: AI_PLAN_CYCLE_RULE_VERSION };
    }
    try {
      await session.query(
        `
        BEGIN;
        LET $row = (SELECT high_water, r_num, granted_total, events FROM ONLY $state);
        LET $baseRow = (SELECT total FROM ONLY $base);
        LET $h0 = IF $row != NONE { $row.high_water } ELSE { $baseRow.total };
        IF $h0 != NONE AND $target > $h0 {
          IF $row = NONE {
            LET $num = ($target - $h0) * $remMs;
            LET $grant = ($num - ($num % $rDen)) / $rDen;
            CREATE $state CONTENT {
              period_key: $period, rule_version: $ruleVersion,
              high_water: $target, r_num: $num, r_den: $rDen,
              granted_total: $grant, events: [$eventKey]
            };
            IF $grant > 0 {
              CREATE $bucket CONTENT {
                kind: "plan_cycle", label: $label, source: $source, period_key: $period,
                upgrade_event_key: $eventKey, upgrade_target: $target,
                total: $grant, available: $grant, reserved: 0, settled: 0,
                effective_from: $from, expires_at: $until
              };
              CREATE ai_ledger_entry CONTENT {
                kind: "grant", bucket: $bucket, amount: $grant,
                note: $note, resulting_available: $grant
              };
            };
          };
          IF $row != NONE AND $row.r_den = $rDen AND $row.events CONTAINSNOT $eventKey {
            LET $num = $row.r_num + ($target - $h0) * $remMs;
            LET $grant = (($num - ($num % $rDen)) / $rDen) - $row.granted_total;
            UPDATE $state SET
              high_water = $target, r_num = $num, granted_total = $row.granted_total + $grant,
              events = array::append($row.events, $eventKey), updated_at = time::now();
            IF $grant > 0 {
              CREATE $bucket CONTENT {
                kind: "plan_cycle", label: $label, source: $source, period_key: $period,
                upgrade_event_key: $eventKey, upgrade_target: $target,
                total: $grant, available: $grant, reserved: 0, settled: 0,
                effective_from: $from, expires_at: $until
              };
              CREATE ai_ledger_entry CONTENT {
                kind: "grant", bucket: $bucket, amount: $grant,
                note: $note, resulting_available: $grant
              };
            };
          };
        };
        COMMIT;
        `,
        {
          state: stateRow,
          base: baseBucket,
          bucket: supplementBucket,
          eventKey: directive.eventKey,
          target: directive.cycleAllowance,
          remMs: remainingMs,
          rDen,
          period: directive.periodKey,
          ruleVersion: AI_UPGRADE_PRORATION_RULE_VERSION,
          label: `${directive.label}（升级补发）`,
          source: `lifecycle:${input.correlationId}`,
          from: new DateTime(directive.eventEffectiveAt),
          until: new DateTime(directive.expiresAt),
          note: `${AI_UPGRADE_PRORATION_RULE_VERSION} upgrade supplement ${directive.periodKey} event ${directive.eventKey} target ${directive.cycleAllowance} high ${highWater} remaining ${remainingMs}/${rDen}`,
        },
      );
    } catch (error) {
      // 并发对手先写了状态行/补发桶 → 重读后按去重与高水位判断；可重试事务
      // 冲突 → 退避重试（并发总授予仍受累计规则约束）。
      if ((isConflict(error) || isRetryableTxnError(error)) && attempt + 1 < MAX_ATTEMPTS) {
        await sleep(5 + Math.random() * 20 * (attempt + 1));
        continue;
      }
      throw error;
    }
    const after = await readBucket(session, supplementBucket);
    if (before === null && after && after.total > 0) {
      return {
        kind: "supplement",
        delta: after.total,
        bucketId: supplementBucket.toString(),
        ruleVersion: AI_PLAN_CYCLE_RULE_VERSION,
      };
    }
    return { kind: "none", delta: 0, bucketId: supplementBucket.toString(), ruleVersion: AI_PLAN_CYCLE_RULE_VERSION };
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
