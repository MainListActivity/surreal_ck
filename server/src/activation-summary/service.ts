import {
  activationSummarySchema,
  type ActivationSummaryPage,
  type ActivationSummary,
  type SharedActivationSummary,
} from "@surreal-ck/shared";

export type ActivationSummaryActor = Readonly<{
  subject: string;
  capabilities: readonly string[];
}>;

export type WorkspaceSummaryAuthority = Readonly<{
  workspaceId: string;
  workspaceSlug: string;
  dbName: string;
}>;

export type ActivationSummaryCursor = Readonly<{
  updatedAt: string;
  summaryId: string;
}>;

export interface ActivationSummaryStore {
  resolveAdmin(workspaceSlug: string, subject: string): Promise<WorkspaceSummaryAuthority | null>;
  findIdempotent(workspaceId: string, idempotencyKey: string): Promise<SharedActivationSummary | null>;
  share(input: Readonly<{
    authority: WorkspaceSummaryAuthority;
    actorSubject: string;
    summary: ActivationSummary;
    idempotencyKey: string;
  }>): Promise<SharedActivationSummary>;
  withdraw(input: Readonly<{
    authority: WorkspaceSummaryAuthority;
    actorSubject: string;
    idempotencyKey: string;
  }>): Promise<SharedActivationSummary>;
  list(input: Readonly<{ limit: number; cursor: ActivationSummaryCursor | null }>): Promise<SharedActivationSummary[]>;
  get(summaryId: string): Promise<SharedActivationSummary | null>;
}

export class ActivationSummaryServiceError extends Error {
  constructor(
    readonly code:
      | "forbidden"
      | "invalid_request"
      | "capability_missing"
      | "not_found"
      | "cursor_invalid",
    message: string,
  ) {
    super(message);
    this.name = "ActivationSummaryServiceError";
  }
}

function assertIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 256) {
    throw new ActivationSummaryServiceError("invalid_request", "幂等键长度必须在 8 到 256 之间");
  }
  return normalized;
}

function encodeCursor(cursor: ActivationSummaryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): ActivationSummaryCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof parsed.updatedAt !== "string"
      || Number.isNaN(Date.parse(parsed.updatedAt))
      || typeof parsed.summaryId !== "string"
      || !parsed.summaryId.startsWith("workspace_activation_summary:")
    ) throw new Error();
    return { updatedAt: parsed.updatedAt, summaryId: parsed.summaryId };
  } catch {
    throw new ActivationSummaryServiceError("cursor_invalid", "摘要分页游标无效");
  }
}

function requireReadCapability(actor: ActivationSummaryActor): void {
  if (!actor.capabilities.includes("activation.summary.read")) {
    throw new ActivationSummaryServiceError("capability_missing", "缺少 activation.summary.read 能力");
  }
}

export class ActivationSummaryService {
  constructor(private readonly store: ActivationSummaryStore) {}

  async share(input: Readonly<{
    workspaceSlug: string;
    actorSubject: string;
    summary: unknown;
    idempotencyKey: string;
  }>): Promise<SharedActivationSummary> {
    const authority = await this.store.resolveAdmin(input.workspaceSlug, input.actorSubject);
    if (!authority) throw new ActivationSummaryServiceError("forbidden", "仅当前工作区管理员可共享摘要");
    const parsed = activationSummarySchema.safeParse(input.summary);
    if (!parsed.success) {
      throw new ActivationSummaryServiceError("invalid_request", "摘要不符合 v1/v2 白名单契约");
    }
    const serializedSize = new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength;
    if (serializedSize > 16_384) {
      throw new ActivationSummaryServiceError("invalid_request", "摘要超过 16 KiB 大小限制");
    }
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const replay = await this.store.findIdempotent(authority.workspaceId, idempotencyKey);
    if (replay) return replay;
    return await this.store.share({
      authority,
      actorSubject: input.actorSubject,
      summary: parsed.data,
      idempotencyKey,
    });
  }

  async withdraw(input: Readonly<{
    workspaceSlug: string;
    actorSubject: string;
    idempotencyKey: string;
  }>): Promise<SharedActivationSummary> {
    const authority = await this.store.resolveAdmin(input.workspaceSlug, input.actorSubject);
    if (!authority) throw new ActivationSummaryServiceError("forbidden", "仅当前工作区管理员可撤回摘要");
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const replay = await this.store.findIdempotent(authority.workspaceId, idempotencyKey);
    if (replay) return replay;
    return await this.store.withdraw({ authority, actorSubject: input.actorSubject, idempotencyKey });
  }

  async list(actor: ActivationSummaryActor, input: Readonly<{
    limit?: number;
    cursor?: string;
  }>): Promise<ActivationSummaryPage> {
    requireReadCapability(actor);
    const requestedLimit = input.limit ?? 20;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new ActivationSummaryServiceError("invalid_request", "limit 必须是正整数");
    }
    const limit = Math.min(100, requestedLimit);
    const rows = await this.store.list({ limit: limit + 1, cursor: decodeCursor(input.cursor) });
    const items = rows.slice(0, limit);
    const tail = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && tail
        ? encodeCursor({ updatedAt: tail.updatedAt, summaryId: tail.summaryId })
        : null,
    };
  }

  async get(actor: ActivationSummaryActor, summaryId: string): Promise<SharedActivationSummary> {
    requireReadCapability(actor);
    const item = await this.store.get(summaryId);
    if (!item || item.status !== "active" || item.summary === null) {
      throw new ActivationSummaryServiceError("not_found", "摘要不存在或已撤回");
    }
    return item;
  }
}
