import {
  claimFollowUpSchema,
  createFollowUpSchema,
  updateFollowUpSchema,
  type ActivationOpportunity,
  type ActivationOpportunityPage,
  type FollowUpItem,
  type FollowUpPage,
  type FollowUpReason,
  type FollowUpStatus,
  type SharedActivationSummary,
} from "@surreal-ck/shared";
import { createHash } from "node:crypto";

export type OpsFollowUpActor = Readonly<{ subject: string; capabilities: readonly string[] }>;
export type FollowUpCursor = Readonly<{ updatedAt: string; followUpId: string }>;

export interface OpsFollowUpStore {
  listActiveSummaries(): Promise<SharedActivationSummary[]>;
  getSummary(summaryId: string): Promise<SharedActivationSummary | null>;
  findIdempotent(actorSubject: string, idempotencyKey: string): Promise<{ item: FollowUpItem; requestDigest: string } | null>;
  create(input: Readonly<{
    actorSubject: string;
    idempotencyKey: string;
    requestDigest: string;
    workspaceSlug: string;
    summaryId: string;
    reason: FollowUpReason;
    period: ActivationOpportunity["period"];
    dedupeKey: string;
    sourceContractVersion: "1" | "2";
    sourceUpdatedAt: string;
    dueCheckAt: string | null;
  }>): Promise<FollowUpItem>;
  list(input: Readonly<{ limit: number; cursor: FollowUpCursor | null }>): Promise<FollowUpItem[]>;
  get(followUpId: string): Promise<FollowUpItem | null>;
  claim(input: Readonly<{
    followUpId: string;
    actorSubject: string;
    expectedVersion: number;
    now: string;
    leaseExpiresAt: string;
    idempotencyKey: string;
    requestDigest: string;
  }>): Promise<FollowUpItem | null>;
  update(input: Readonly<{
    followUpId: string;
    actorSubject: string;
    expectedVersion: number;
    now: string;
    status: Extract<FollowUpStatus, "waiting" | "resolved" | "dismissed">;
    dueCheckAt: string | null;
    result: string | null;
    idempotencyKey: string;
    requestDigest: string;
  }>): Promise<FollowUpItem | null>;
}

export class OpsFollowUpServiceError extends Error {
  constructor(
    readonly code: "invalid_request" | "capability_missing" | "not_found" | "conflict" | "cursor_invalid",
    message: string,
  ) {
    super(message);
    this.name = "OpsFollowUpServiceError";
  }
}

const FRESH_MS = 30 * 24 * 60 * 60 * 1_000;

function requireRead(actor: OpsFollowUpActor): void {
  if (!actor.capabilities.includes("activation.followup.read")) {
    throw new OpsFollowUpServiceError("capability_missing", "缺少 activation.followup.read 能力");
  }
}

function requireWrite(actor: OpsFollowUpActor): void {
  requireRead(actor);
  if (!actor.capabilities.includes("activation.followup.write")) {
    throw new OpsFollowUpServiceError("capability_missing", "缺少 activation.followup.write 能力");
  }
}

function idempotencyKey(value: string): string {
  const key = value.trim();
  if (key.length < 8 || key.length > 256) {
    throw new OpsFollowUpServiceError("invalid_request", "幂等键长度必须在 8 到 256 之间");
  }
  return key;
}

function digest(action: string, input: object): string {
  return createHash("sha256").update(JSON.stringify({ action, input })).digest("hex");
}

function replayOrConflict(
  replay: { item: FollowUpItem; requestDigest: string } | null,
  requestDigest: string,
): FollowUpItem | null {
  if (!replay) return null;
  if (replay.requestDigest !== requestDigest) {
    throw new OpsFollowUpServiceError("conflict", "幂等键已用于不同的跟进动作");
  }
  return replay.item;
}

function limit(value: number | undefined): number {
  const resolved = value ?? 20;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new OpsFollowUpServiceError("invalid_request", "limit 必须是正整数");
  }
  return Math.min(100, resolved);
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode<T extends Record<string, string>>(value: string | undefined, fields: readonly (keyof T)[], label: string): T | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
    if (!fields.every((field) => typeof parsed[field] === "string" && parsed[field].length > 0)) throw new Error();
    return parsed;
  } catch {
    throw new OpsFollowUpServiceError("cursor_invalid", `${label}分页游标无效`);
  }
}

function reasonOf(item: SharedActivationSummary): FollowUpReason | null {
  const content = item.summary;
  if (!content || content.stage === "unknown" || content.stage === "activated") {
    if (content?.contractVersion === "2") {
      if (content.outcomes.issueResolution.state === "incomplete" || content.outcomes.issueResolution.state === "failed") return "review_incomplete";
      if (content.outcomes.nextWeekUpdate.state === "incomplete" || content.outcomes.nextWeekUpdate.state === "failed") return "next_update_missing";
    }
    return null;
  }
  return content.stage === "failed" ? "activation_failed" : "activation_incomplete";
}

function opportunity(item: SharedActivationSummary, now: Date): ActivationOpportunity | null {
  if (item.status !== "active" || !item.summary) return null;
  const age = now.getTime() - Date.parse(item.updatedAt);
  if (!Number.isFinite(age) || age < 0 || age > FRESH_MS) return null;
  const reason = reasonOf(item);
  if (!reason) return null;
  const period = item.summary.period;
  return {
    opportunityId: `${item.workspaceSlug}:${reason}:${encode({ summaryId: item.summaryId, startedAt: period.startedAt, endedAt: period.endedAt })}`,
    workspaceSlug: item.workspaceSlug,
    summaryId: item.summaryId,
    reason,
    period,
    sourceContractVersion: item.contractVersion,
    sourceUpdatedAt: item.updatedAt,
    freshness: "fresh",
    freshnessEvaluatedAt: now.toISOString(),
    freshnessMaxAgeDays: 30,
    nextStep: "create_follow_up",
  };
}

function dedupeKey(item: ActivationOpportunity): string {
  return `${item.workspaceSlug}|${item.reason}|${item.period.startedAt}|${item.period.endedAt}`;
}

function publicItem(item: FollowUpItem, source: SharedActivationSummary | null, actor: OpsFollowUpActor, now: Date): FollowUpItem {
  const available = source?.status === "active" && source.summary !== null
    && source.updatedAt === item.sourceUpdatedAt;
  const terminal = item.status === "resolved" || item.status === "dismissed";
  const liveLease = item.leaseExpiresAt !== null && Date.parse(item.leaseExpiresAt) > now.getTime();
  const nextStep = terminal ? "none" : liveLease ? item.ownerSubject === actor.subject ? "update" : "none" : "claim";
  const sourceAge = source ? now.getTime() - Date.parse(source.updatedAt) : Number.NaN;
  const sourceFreshness = !available ? "unavailable" : !Number.isFinite(sourceAge) || sourceAge < 0 ? "unknown" : sourceAge > FRESH_MS ? "stale" : "fresh";
  return { ...item, sourceAvailable: available, sourceFreshness, nextStep };
}

export class OpsFollowUpService {
  constructor(private readonly store: OpsFollowUpStore, private readonly now: () => Date = () => new Date()) {}

  async listOpportunities(actor: OpsFollowUpActor, input: Readonly<{ limit?: number; cursor?: string }>): Promise<ActivationOpportunityPage> {
    requireRead(actor);
    const pageSize = limit(input.limit);
    const cursor = decode<{ sourceUpdatedAt: string; opportunityId: string }>(input.cursor, ["sourceUpdatedAt", "opportunityId"], "机会");
    const candidates = (await this.store.listActiveSummaries())
      .map((item) => opportunity(item, this.now()))
      .filter((item): item is ActivationOpportunity => item !== null)
      .sort((a, b) => b.sourceUpdatedAt.localeCompare(a.sourceUpdatedAt) || b.opportunityId.localeCompare(a.opportunityId))
      .filter((item) => !cursor || item.sourceUpdatedAt < cursor.sourceUpdatedAt || (item.sourceUpdatedAt === cursor.sourceUpdatedAt && item.opportunityId < cursor.opportunityId));
    const items = candidates.slice(0, pageSize);
    const tail = items.at(-1);
    return {
      items,
      nextCursor: candidates.length > pageSize && tail ? encode({ sourceUpdatedAt: tail.sourceUpdatedAt, opportunityId: tail.opportunityId }) : null,
    };
  }

  async create(actor: OpsFollowUpActor, input: Readonly<{ opportunityId: string; dueCheckAt: string | null; idempotencyKey: string }>): Promise<FollowUpItem> {
    requireWrite(actor);
    if (!createFollowUpSchema.safeParse(input).success) throw new OpsFollowUpServiceError("invalid_request", "创建跟进事项请求无效");
    const key = idempotencyKey(input.idempotencyKey);
    const requestDigest = digest("created", { opportunityId: input.opportunityId, dueCheckAt: input.dueCheckAt });
    const replay = replayOrConflict(await this.store.findIdempotent(actor.subject, key), requestDigest);
    if (replay) return publicItem(replay, await this.store.getSummary(replay.summaryId), actor, this.now());
    const all = await this.store.listActiveSummaries();
    const selected = all.map((item) => opportunity(item, this.now())).find((item) => item?.opportunityId === input.opportunityId) ?? null;
    if (!selected) throw new OpsFollowUpServiceError("not_found", "机会不存在、已过期或来源已撤回");
    if (input.dueCheckAt !== null && Number.isNaN(Date.parse(input.dueCheckAt))) throw new OpsFollowUpServiceError("invalid_request", "到期检查时间无效");
    let created: FollowUpItem;
    try {
      created = await this.store.create({
        actorSubject: actor.subject,
        idempotencyKey: key,
        requestDigest,
        workspaceSlug: selected.workspaceSlug,
        summaryId: selected.summaryId,
        reason: selected.reason,
        period: selected.period,
        dedupeKey: dedupeKey(selected),
        sourceContractVersion: selected.sourceContractVersion,
        sourceUpdatedAt: selected.sourceUpdatedAt,
        dueCheckAt: input.dueCheckAt,
      });
    } catch (error) {
      const concurrentReplay = replayOrConflict(await this.store.findIdempotent(actor.subject, key), requestDigest);
      if (concurrentReplay) return publicItem(concurrentReplay, await this.store.getSummary(concurrentReplay.summaryId), actor, this.now());
      const source = await this.store.getSummary(selected.summaryId);
      if (source?.status !== "active" || source.updatedAt !== selected.sourceUpdatedAt) {
        throw new OpsFollowUpServiceError("not_found", "机会来源已变化或撤回");
      }
      throw error;
    }
    return publicItem(created, await this.store.getSummary(created.summaryId), actor, this.now());
  }

  async listFollowUps(actor: OpsFollowUpActor, input: Readonly<{ limit?: number; cursor?: string }>): Promise<FollowUpPage> {
    requireRead(actor);
    const pageSize = limit(input.limit);
    const cursor = decode<FollowUpCursor>(input.cursor, ["updatedAt", "followUpId"], "跟进事项");
    const rows = await this.store.list({ limit: pageSize + 1, cursor });
    const items = await Promise.all(rows.slice(0, pageSize).map(async (item) => publicItem(item, await this.store.getSummary(item.summaryId), actor, this.now())));
    const tail = items.at(-1);
    return { items, nextCursor: rows.length > pageSize && tail ? encode({ updatedAt: tail.updatedAt, followUpId: tail.followUpId }) : null };
  }

  async claim(actor: OpsFollowUpActor, input: Readonly<{ followUpId: string; expectedVersion: number; leaseSeconds: number; idempotencyKey: string }>): Promise<FollowUpItem> {
    requireWrite(actor);
    if (!input.followUpId.startsWith("activation_follow_up:") || !claimFollowUpSchema.safeParse({ expectedVersion: input.expectedVersion, leaseSeconds: input.leaseSeconds, idempotencyKey: input.idempotencyKey }).success) {
      throw new OpsFollowUpServiceError("invalid_request", "认领请求无效");
    }
    const key = idempotencyKey(input.idempotencyKey);
    const requestDigest = digest("claimed", { followUpId: input.followUpId, expectedVersion: input.expectedVersion, leaseSeconds: input.leaseSeconds });
    const replay = replayOrConflict(await this.store.findIdempotent(actor.subject, key), requestDigest);
    if (replay) return publicItem(replay, await this.store.getSummary(replay.summaryId), actor, this.now());
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1 || !Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 30 || input.leaseSeconds > 3600) {
      throw new OpsFollowUpServiceError("invalid_request", "预期版本或租约时长无效");
    }
    const now = this.now();
    let changed: FollowUpItem | null;
    try {
      changed = await this.store.claim({
        followUpId: input.followUpId,
        actorSubject: actor.subject,
        expectedVersion: input.expectedVersion,
        now: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + input.leaseSeconds * 1_000).toISOString(),
        idempotencyKey: key,
        requestDigest,
      });
    } catch (error) {
      const concurrentReplay = replayOrConflict(await this.store.findIdempotent(actor.subject, key), requestDigest);
      if (concurrentReplay) return publicItem(concurrentReplay, await this.store.getSummary(concurrentReplay.summaryId), actor, this.now());
      throw error;
    }
    if (!changed) throw new OpsFollowUpServiceError("conflict", "事项版本已变化或租约仍由其他运营人员持有");
    return publicItem(changed, await this.store.getSummary(changed.summaryId), actor, this.now());
  }

  async update(actor: OpsFollowUpActor, input: Readonly<{ followUpId: string; expectedVersion: number; status: "waiting" | "resolved" | "dismissed"; dueCheckAt: string | null; result: string | null; idempotencyKey: string }>): Promise<FollowUpItem> {
    requireWrite(actor);
    if (!input.followUpId.startsWith("activation_follow_up:") || !updateFollowUpSchema.safeParse({ expectedVersion: input.expectedVersion, status: input.status, dueCheckAt: input.dueCheckAt, result: input.result, idempotencyKey: input.idempotencyKey }).success) {
      throw new OpsFollowUpServiceError("invalid_request", "更新请求无效");
    }
    const key = idempotencyKey(input.idempotencyKey);
    const requestDigest = digest("updated", { followUpId: input.followUpId, expectedVersion: input.expectedVersion, status: input.status, dueCheckAt: input.dueCheckAt, result: input.result });
    const replay = replayOrConflict(await this.store.findIdempotent(actor.subject, key), requestDigest);
    if (replay) return publicItem(replay, await this.store.getSummary(replay.summaryId), actor, this.now());
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1 || (input.dueCheckAt !== null && Number.isNaN(Date.parse(input.dueCheckAt)))) {
      throw new OpsFollowUpServiceError("invalid_request", "预期版本或到期检查时间无效");
    }
    let changed: FollowUpItem | null;
    try {
      changed = await this.store.update({ ...input, actorSubject: actor.subject, idempotencyKey: key, requestDigest, now: this.now().toISOString() });
    } catch (error) {
      const concurrentReplay = replayOrConflict(await this.store.findIdempotent(actor.subject, key), requestDigest);
      if (concurrentReplay) return publicItem(concurrentReplay, await this.store.getSummary(concurrentReplay.summaryId), actor, this.now());
      throw error;
    }
    if (!changed) throw new OpsFollowUpServiceError("conflict", "事项版本、持有人或租约已失效");
    return publicItem(changed, await this.store.getSummary(changed.summaryId), actor, this.now());
  }
}
