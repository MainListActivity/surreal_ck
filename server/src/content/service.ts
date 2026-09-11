import {
  IngestionBatchSchema,
  GetDataContractRequestSchema,
  GetDataContractResponseSchema,
  InspectBatchRequestSchema,
  InspectBatchResponseSchema,
  PublishBatchRequestSchema,
  PublishBatchResponseSchema,
  SearchContentResponseSchema,
  SearchContentRequestSchema,
  SubmitBatchResponseSchema,
  type IngestionBatch,
  type IngestionEntry,
  type GetDataContractResponse,
  type PlatformContentErrorCode,
  type PlatformContentIssue,
  type SearchContentItem,
  type SearchContentRequest,
  type SearchContentResponse,
  type PublishBatchRequest,
  type PublishBatchResponse,
  type SubmitBatchResponse,
} from "@surreal-ck/shared/platform-content";
import { PLATFORM_CONTENT_LIMITS, sha256Hex, validatePlatformContentBatch } from "@surreal-ck/shared/platform-content";

export type ContentOperator = Readonly<{
  subject: string;
  capabilities: readonly string[];
}>;

export type ContentSourceRegistration = Readonly<{
  sourceKey: string;
  label: string;
  status: "active" | "inactive";
  allowedActions: readonly ("submit" | "publish" | "withdraw" | "restore")[];
}>;

export type ContentSourceProvider = {
  list(): Promise<readonly ContentSourceRegistration[]>;
};

export type StoredContentBatch = {
  batchId: string;
  actorSubject: string;
  idempotencyKey: string;
  requestDigest: string;
  request: IngestionBatch;
  receivedAt: string;
  status: SubmitBatchResponse["status"] | "published";
  validationRevision: number;
  entries: Array<{
    entryKey: string;
    operation: IngestionEntry["operation"];
    status: "accepted" | "duplicate" | "rejected";
    issues: PlatformContentIssue[];
    publicationStatus?: "published" | "withdrawn" | null;
  }>;
};

export type StoredPublishedContent = SearchContentItem & {
  sourceRecordKey: string | null;
  bodySha256: string;
  publicationRevision: number;
};

export type PublicationApplyResult = Readonly<{
  status: "published" | "unchanged" | "blocked" | "failed";
  versionId: string | null;
  issues: PlatformContentIssue[];
}>;

export type PublicationReservation = Readonly<{
  publicationId: string;
  batchId: string;
  actorSubject: string;
  idempotencyKey: string;
  validationRevision: number;
  entryKeys: readonly string[];
}>;

export type PublicationReservationResult =
  | Readonly<{ kind: "created" | "resume"; reservation: PublicationReservation }>
  | Readonly<{ kind: "replay"; response: PublishBatchResponse }>
  | Readonly<{ kind: "conflict" }>;

export interface PlatformContentStore {
  findBatchByIdempotency(input: Readonly<{ actorSubject: string; idempotencyKey: string }>): Promise<StoredContentBatch | null>;
  saveBatch(batch: StoredContentBatch): Promise<void>;
  getBatch(batchId: string): Promise<StoredContentBatch | null>;
  findBySourceRecord(input: Readonly<{ sourceKey: string; recordKey: string }>): Promise<StoredPublishedContent | null>;
  searchPublished(input: SearchContentRequest): Promise<StoredPublishedContent[]>;
  applyPublication(input: Readonly<{
    batch: StoredContentBatch;
    entryKey: string;
    actorSubject: string;
    publicationId?: string;
  }>): Promise<PublicationApplyResult>;
  findPublicationByIdempotency(input: Readonly<{ actorSubject: string; idempotencyKey: string }>): Promise<PublishBatchResponse | null>;
  savePublication(input: Readonly<{ actorSubject: string; idempotencyKey: string; response: PublishBatchResponse }>): Promise<void>;
  /**
   * 预留发布请求的幂等键。持久化实现应借助唯一索引原子地创建 pending 行，
   * 这样进程中断后可以从同一 reservation 恢复，而不会重复生成版本/事件。
   */
  reservePublication?(input: Readonly<{
    reservation: PublicationReservation;
  }>): Promise<PublicationReservationResult>;
  /** 将逐项结果与批次状态一次性落盘，完成 pending reservation。 */
  completePublication?(input: Readonly<{
    reservation: PublicationReservation;
    response: PublishBatchResponse;
  }>): Promise<void>;
  listSources?(): Promise<readonly ContentSourceRegistration[]>;
}

export class ContentServiceError extends Error {
  constructor(
    readonly code: PlatformContentErrorCode,
    message: string,
    readonly details: Readonly<{ entryKey?: string; fieldPath?: string; retryable?: boolean }> = {},
  ) {
    super(message);
    this.name = "ContentServiceError";
  }
}

function issue(
  code: PlatformContentErrorCode,
  message: string,
  details: Readonly<{ entryKey?: string; fieldPath?: string; retryable?: boolean }> = {},
): PlatformContentIssue {
  return {
    code,
    ...details,
    message,
    retryable: details.retryable ?? false,
  };
}

function requireCapability(actor: ContentOperator, capability: string): void {
  if (!actor.subject.trim()) throw new ContentServiceError("forged_actor", "运营 actor subject 不能为空");
  if (!actor.capabilities.includes(capability)) {
    throw new ContentServiceError("source_not_authorized", `缺少 ${capability} 能力`, { retryable: false });
  }
}

function requestJson(request: IngestionBatch): string {
  return JSON.stringify(request);
}

function batchStatus(entries: StoredContentBatch["entries"]): StoredContentBatch["status"] {
  if (entries.every((entry) => entry.status === "rejected")) return "rejected";
  if (entries.some((entry) => entry.status === "rejected")) return "partially_validated";
  return "ready";
}

function responseFromBatch(batch: StoredContentBatch): SubmitBatchResponse {
  return SubmitBatchResponseSchema.parse({
    batchId: batch.batchId,
    receivedAt: batch.receivedAt,
    status: batch.status,
    entries: batch.entries.map((entry) => ({
      entryKey: entry.entryKey,
      status: entry.status,
      issues: entry.issues,
    })),
  });
}

export type PlatformContentServiceOptions = Readonly<{
  store: PlatformContentStore;
  sources?: readonly ContentSourceRegistration[];
  sourceProvider?: ContentSourceProvider;
  now?: () => Date;
  limits?: Partial<Parameters<typeof validatePlatformContentBatch>[1]>;
  idFactory?: (prefix: string) => string;
}>;

export class PlatformContentService {
  private readonly sourceMap: ReadonlyMap<string, ContentSourceRegistration>;
  private readonly now: () => Date;
  private readonly idFactory: (prefix: string) => string;

  constructor(private readonly options: PlatformContentServiceOptions) {
    this.sourceMap = new Map((options.sources ?? []).map((source) => [source.sourceKey, source]));
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? ((prefix) => `${prefix}_${crypto.randomUUID()}`);
  }

  private async currentSourceMap(): Promise<ReadonlyMap<string, ContentSourceRegistration>> {
    if (this.options.sourceProvider) {
      return new Map((await this.options.sourceProvider.list()).map((source) => [source.sourceKey, source]));
    }
    return this.sourceMap;
  }

  async getDataContract(actor: ContentOperator, requestInput: unknown = {}): Promise<GetDataContractResponse> {
    requireCapability(actor, "content.read");
    const request = GetDataContractRequestSchema.parse(requestInput);
    if (request.contractVersion !== null && request.contractVersion !== undefined && request.contractVersion !== "1") {
      throw new ContentServiceError("unsupported_contract", `不支持的数据契约版本 ${request.contractVersion}`);
    }
    const sources = await this.currentSourceMap();
    return GetDataContractResponseSchema.parse({
      contractVersion: "1",
      operations: ["get_data_contract", "search_content", "submit_batch", "inspect_batch", "publish_batch"],
      limits: { ...PLATFORM_CONTENT_LIMITS, ...this.options.limits },
      errorCodes: [
        "unsupported_contract", "invalid_request", "forged_actor", "payload_too_large",
        "source_not_registered", "source_not_authorized", "required_field_missing", "locator_mismatch",
        "identity_ambiguous", "stale_version", "validation_stale", "idempotency_conflict", "publish_failed",
        "duplicate_entry_key", "duplicate_target",
      ],
      sources: [...sources.values()].map((source) => ({ ...source, allowedActions: [...source.allowedActions] })),
      sourceNextCursor: null,
      examples: ["submit_batch: 合法的 IngestionBatch JSON", "inspect_batch: 使用返回的 batchId 与 validationRevision", "publish_batch: 先审阅条目后提交 entryKeys"],
    });
  }

  async submitBatch(actor: ContentOperator, requestInput: unknown): Promise<SubmitBatchResponse> {
    requireCapability(actor, "content.submit");
    const parsed = IngestionBatchSchema.safeParse(requestInput);
    if (!parsed.success) {
      const actorAttempt = parsed.error.issues.some((entry) => entry.path.includes("actor") || entry.path.includes("subject"));
      throw new ContentServiceError(actorAttempt ? "forged_actor" : "invalid_request", "成品批次不符合契约结构");
    }
    const request = parsed.data;
    const sourceMap = await this.currentSourceMap();
    const requestDigest = await sha256Hex(requestJson(request));
    const existing = await this.options.store.findBatchByIdempotency({
      actorSubject: actor.subject,
      idempotencyKey: request.idempotencyKey,
    });
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        throw new ContentServiceError("idempotency_conflict", "同一 actor 与幂等键对应了不同请求");
      }
      return responseFromBatch(existing);
    }

    const validation = await validatePlatformContentBatch(request, this.options.limits);
    if (!validation.ok && !validation.issues.some((entry) => entry.entryKey)) {
      throw new ContentServiceError(validation.code, validation.issues[0]?.message ?? "成品批次校验失败");
    }
    const issuesByEntry = new Map<string, PlatformContentIssue[]>();
    for (const validationIssue of validation.ok ? [] : validation.issues) {
      if (!validationIssue.entryKey) continue;
      const current = issuesByEntry.get(validationIssue.entryKey) ?? [];
      current.push({
        code: validationIssue.code,
        entryKey: validationIssue.entryKey,
        fieldPath: validationIssue.fieldPath,
        message: validationIssue.message,
        retryable: validationIssue.retryable,
      });
      issuesByEntry.set(validationIssue.entryKey, current);
    }

    const entries: StoredContentBatch["entries"] = [];
    for (const entry of request.items) {
      if (entry.operation === "withdraw") requireCapability(actor, "content.withdraw");
      if (entry.operation === "restore") requireCapability(actor, "content.restore");
      const entryIssues = [...(issuesByEntry.get(entry.entryKey) ?? [])];
      if (entry.operation === "upsert") {
        const source = sourceMap.get(entry.payload.source.sourceKey);
        if (!source) {
          entryIssues.push(issue("source_not_registered", `来源 ${entry.payload.source.sourceKey} 未登记`, { entryKey: entry.entryKey }));
        } else if (source.status !== "active" || !source.allowedActions.includes("submit")) {
          entryIssues.push(issue("source_not_authorized", `来源 ${entry.payload.source.sourceKey} 当前不允许提交`, { entryKey: entry.entryKey }));
        }
        if (entry.payload.source.recordKey) {
          const duplicate = await this.options.store.findBySourceRecord({
            sourceKey: entry.payload.source.sourceKey,
            recordKey: entry.payload.source.recordKey,
          });
          const submittedDigest = validation.ok ? validation.bodyDigests[entry.entryKey] : null;
          if (duplicate && submittedDigest && duplicate.bodySha256 === submittedDigest) {
            entries.push({ entryKey: entry.entryKey, operation: entry.operation, status: "duplicate", issues: [] });
            continue;
          }
        }
      }
      entries.push({
        entryKey: entry.entryKey,
        operation: entry.operation,
        status: entryIssues.some((entryIssue) => entryIssue.code !== "identity_ambiguous") ? "rejected" : "accepted",
        issues: entryIssues,
      });
    }

    const batch: StoredContentBatch = {
      batchId: this.idFactory("batch"),
      actorSubject: actor.subject,
      idempotencyKey: request.idempotencyKey,
      requestDigest,
      request,
      receivedAt: this.now().toISOString(),
      status: batchStatus(entries),
      validationRevision: 1,
      entries,
    };
    await this.options.store.saveBatch(batch);
    return responseFromBatch(batch);
  }

  async inspectBatch(actor: ContentOperator, batchId: string): Promise<StoredContentBatch> {
    requireCapability(actor, "content.read");
    const batch = await this.options.store.getBatch(batchId);
    if (!batch) throw new ContentServiceError("identity_ambiguous", "批次不存在或不可访问");
    return batch;
  }

  async inspectBatchResponse(actor: ContentOperator, requestInput: unknown): Promise<import("@surreal-ck/shared/platform-content").InspectBatchResponse> {
    const request = InspectBatchRequestSchema.parse(requestInput);
    const batch = await this.inspectBatch(actor, request.batchId);
    return InspectBatchResponseSchema.parse({
      batchId: batch.batchId,
      validationRevision: batch.validationRevision,
      status: batch.status,
      entries: batch.entries.slice(0, request.limit).map((entry) => ({
        entryKey: entry.entryKey,
        operation: entry.operation,
        status: entry.status === "rejected" ? "blocked" : entry.status === "duplicate" ? "unchanged" : entry.publicationStatus ? "published" : "ready",
        issues: entry.issues,
        diff: null,
        publicationStatus: entry.publicationStatus ?? null,
      })),
      nextCursor: null,
    });
  }

  async publishBatch(actor: ContentOperator, requestInput: unknown): Promise<PublishBatchResponse> {
    requireCapability(actor, "content.publish");
    const parsed = PublishBatchRequestSchema.safeParse(requestInput);
    if (!parsed.success) throw new ContentServiceError("invalid_request", "发布请求不符合契约结构");
    const request: PublishBatchRequest = parsed.data;
    const replay = await this.options.store.findPublicationByIdempotency({
      actorSubject: actor.subject,
      idempotencyKey: request.idempotencyKey,
    });
    if (replay) return replay;
    const batch = await this.options.store.getBatch(request.batchId);
    if (!batch) throw new ContentServiceError("identity_ambiguous", "批次不存在或不可访问");
    if (batch.validationRevision !== request.validationRevision) {
      throw new ContentServiceError("validation_stale", "批次校验修订已变化，请重新 inspect_batch");
    }

    let reservation = {
      publicationId: this.idFactory("publication"),
      batchId: request.batchId,
      actorSubject: actor.subject,
      idempotencyKey: request.idempotencyKey,
      validationRevision: request.validationRevision,
      entryKeys: request.entryKeys,
    };
    if (this.options.store.reservePublication) {
      const reserved = await this.options.store.reservePublication({ reservation });
      if (reserved.kind === "replay") return reserved.response;
      if (reserved.kind === "conflict") {
        throw new ContentServiceError("idempotency_conflict", "同一 actor 与幂等键对应了不同发布请求");
      }
      // 跨进程恢复时以持久化 reservation 的 publicationId 为准，避免生成第二个公开 ID。
      reservation.publicationId = reserved.reservation.publicationId;
    }
    const entriesByKey = new Map(batch.entries.map((entry) => [entry.entryKey, entry]));
    const sourceMap = await this.currentSourceMap();
    const resultEntries: PublishBatchResponse["entries"] = [];
    for (const entryKey of request.entryKeys) {
      const entry = entriesByKey.get(entryKey);
      if (!entry) {
        resultEntries.push({
          entryKey,
          status: "blocked",
          versionId: null,
          issues: [issue("identity_ambiguous", "entryKey 不属于该批次", { entryKey })],
        });
        continue;
      }
      if (entry.status === "rejected") {
        resultEntries.push({
          entryKey,
          status: "blocked",
          versionId: null,
          issues: entry.issues,
        });
        continue;
      }
      const requestEntry = batch.request.items.find((candidate) => candidate.entryKey === entryKey);
      if (requestEntry?.operation === "withdraw") requireCapability(actor, "content.withdraw");
      if (requestEntry?.operation === "restore") requireCapability(actor, "content.restore");
      if (requestEntry?.operation === "upsert") {
        const source = sourceMap.get(requestEntry.payload.source.sourceKey);
        if (source && !source.allowedActions.includes("publish")) {
          resultEntries.push({
            entryKey,
            status: "blocked",
            versionId: null,
            issues: [issue("source_not_authorized", `来源 ${requestEntry.payload.source.sourceKey} 当前不允许发布`, { entryKey })],
          });
          continue;
        }
      }
      const applied = await this.options.store.applyPublication({
        batch,
        entryKey,
        actorSubject: actor.subject,
        publicationId: reservation.publicationId,
      });
      resultEntries.push({
        entryKey,
        status: applied.status,
        versionId: applied.versionId,
        issues: applied.issues,
      });
    }
    const publishedCount = resultEntries.filter((entry) => entry.status === "published" || entry.status === "unchanged").length;
    const blockedCount = resultEntries.filter((entry) => entry.status === "blocked" || entry.status === "failed").length;
    const response = PublishBatchResponseSchema.parse({
      publicationId: reservation.publicationId,
      batchId: request.batchId,
      status: blockedCount === 0 ? "completed" : publishedCount === 0 ? "failed" : "partial",
      entries: resultEntries,
    });
    if (this.options.store.completePublication) {
      await this.options.store.completePublication({ reservation, response });
    } else {
      await this.options.store.savePublication({
        actorSubject: actor.subject,
        idempotencyKey: request.idempotencyKey,
        response,
      });
    }
    return response;
  }

  async searchContent(actor: ContentOperator, requestInput: unknown): Promise<SearchContentResponse> {
    requireCapability(actor, "content.read");
    const request = SearchContentRequestSchema.parse(requestInput);
    const items = await this.options.store.searchPublished(request);
    return SearchContentResponseSchema.parse({
      items: items.slice(0, request.limit ?? 20).map(({ sourceRecordKey: _sourceRecordKey, bodySha256: _bodySha256, publicationRevision: _publicationRevision, ...item }) => item),
      nextCursor: null,
    });
  }
}

/**
 * 单进程测试/本地 runner 使用的实现；生产可替换为同一接口的 Surreal adapter，
 * 因而 HTTP 与 MCP 不需要复制校验和幂等逻辑。
 */
export class InMemoryPlatformContentStore implements PlatformContentStore {
  private readonly batches = new Map<string, StoredContentBatch>();
  private readonly idempotency = new Map<string, string>();
  private readonly published: StoredPublishedContent[] = [];
  private readonly publications = new Map<string, {
    reservation: PublicationReservation;
    response: PublishBatchResponse | null;
  }>();
  private readonly publicationRevisions = new Map<string, number>();

  async findBatchByIdempotency(input: { actorSubject: string; idempotencyKey: string }): Promise<StoredContentBatch | null> {
    const batchId = this.idempotency.get(`${input.actorSubject}\u0000${input.idempotencyKey}`);
    return batchId ? this.batches.get(batchId) ?? null : null;
  }

  async saveBatch(batch: StoredContentBatch): Promise<void> {
    this.batches.set(batch.batchId, batch);
    this.idempotency.set(`${batch.actorSubject}\u0000${batch.idempotencyKey}`, batch.batchId);
  }

  async getBatch(batchId: string): Promise<StoredContentBatch | null> {
    return this.batches.get(batchId) ?? null;
  }

  async findBySourceRecord(input: { sourceKey: string; recordKey: string }): Promise<StoredPublishedContent | null> {
    return this.published.find((item) => item.version.sourceKey === input.sourceKey && item.sourceRecordKey === input.recordKey) ?? null;
  }

  async searchPublished(input: SearchContentRequest): Promise<StoredPublishedContent[]> {
    const query = input.filters?.query?.toLocaleLowerCase();
    return this.published.filter((item) => {
      if (input.filters?.kind && item.kind !== input.filters.kind) return false;
      if (input.filters?.sourceKey && item.version.sourceKey !== input.filters.sourceKey) return false;
      const publicationStatus = input.filters?.publicationStatus ?? "published";
      if (item.version.publicationStatus !== publicationStatus) return false;
      if (input.filters?.caseNumber && item.judgment?.caseNumber !== input.filters.caseNumber) return false;
      if (query && !`${item.title}\n${item.bodyText}`.toLocaleLowerCase().includes(query)) return false;
      return true;
    });
  }

  seedPublished(item: StoredPublishedContent): void {
    this.published.push(item);
  }

  async applyPublication(input: {
    batch: StoredContentBatch;
    entryKey: string;
    actorSubject: string;
    publicationId?: string;
  }): Promise<PublicationApplyResult> {
    const entry = input.batch.entries.find((candidate) => candidate.entryKey === input.entryKey);
    const requestEntry = input.batch.request.items.find((candidate) => candidate.entryKey === input.entryKey);
    if (!entry || !requestEntry) {
      return { status: "blocked", versionId: null, issues: [issue("identity_ambiguous", "发布条目不存在")] };
    }
    if (entry.status === "rejected") return { status: "blocked", versionId: null, issues: entry.issues };
    if (requestEntry.operation === "upsert") {
      const bodySha256 = await sha256Hex(requestEntry.payload.document.bodyText);
      const sourceRecordKey = requestEntry.payload.source.recordKey;
      const existing = sourceRecordKey
        ? this.published.find((item) => item.version.sourceKey === requestEntry.payload.source.sourceKey && item.sourceRecordKey === sourceRecordKey)
        : undefined;
      if (existing && existing.bodySha256 === bodySha256) {
        return { status: "unchanged", versionId: existing.version.versionId, issues: [] };
      }
      const targetId = requestEntry.payload.target?.itemId;
      const target = targetId ? this.published.find((item) => item.itemId === targetId) : existing;
      if (target) {
        if (requestEntry.payload.target?.expectedVersionId && requestEntry.payload.target.expectedVersionId !== target.version.versionId) {
          return {
            status: "blocked",
            versionId: target.version.versionId,
            issues: [issue("stale_version", "目标内容版本已变化，请重新 inspect_batch")],
          };
        }
        if (
          requestEntry.payload.target?.expectedPublicationRevision !== undefined
          && requestEntry.payload.target.expectedPublicationRevision !== null
          && requestEntry.payload.target.expectedPublicationRevision !== target.publicationRevision
        ) {
          return {
            status: "blocked",
            versionId: target.version.versionId,
            issues: [issue("stale_version", "目标发布修订已变化，请重新 inspect_batch")],
          };
        }
        const next = this.published.find((item) => item.itemId === target.itemId);
        if (next) {
          const nextRevision = (this.publicationRevisions.get(target.itemId) ?? target.publicationRevision) + 1;
          const versionId = `version_${crypto.randomUUID().replaceAll("-", "")}`;
          const updated = this.toPublished(requestEntry, target.itemId, versionId, nextRevision, bodySha256);
          const index = this.published.indexOf(next);
          this.published[index] = updated;
          this.publicationRevisions.set(target.itemId, nextRevision);
          return { status: "published", versionId, issues: [] };
        }
      }
      const itemId = `item_${crypto.randomUUID().replaceAll("-", "")}`;
      const versionId = `version_${crypto.randomUUID().replaceAll("-", "")}`;
      const published = this.toPublished(requestEntry, itemId, versionId, 1, bodySha256);
      this.published.push(published);
      this.publicationRevisions.set(itemId, 1);
      return { status: "published", versionId, issues: [] };
    }
    const target = this.published.find((item) => item.itemId === requestEntry.payload.target.itemId);
    if (!target) return { status: "blocked", versionId: null, issues: [issue("identity_ambiguous", "目标内容不存在")] };
    const expectedVersionId = requestEntry.payload.target.expectedVersionId;
    const expectedPublicationRevision = requestEntry.payload.target.expectedPublicationRevision;
    const currentRevision = this.publicationRevisions.get(target.itemId) ?? target.publicationRevision;
    if ((expectedVersionId && expectedVersionId !== target.version.versionId) || expectedPublicationRevision === undefined || expectedPublicationRevision === null || expectedPublicationRevision !== currentRevision) {
      return { status: "blocked", versionId: target.version.versionId, issues: [issue("stale_version", "发布状态前提已变化，请重新 inspect_batch")] };
    }
    const nextStatus = requestEntry.operation === "withdraw" ? "withdrawn" : "published";
    const nextRevision = currentRevision + 1;
    const index = this.published.indexOf(target);
    this.published[index] = {
      ...target,
      version: { ...target.version, publicationStatus: nextStatus },
      publicationRevision: nextRevision,
    };
    this.publicationRevisions.set(target.itemId, nextRevision);
    return { status: "published", versionId: target.version.versionId, issues: [] };
  }

  async findPublicationByIdempotency(input: { actorSubject: string; idempotencyKey: string }): Promise<PublishBatchResponse | null> {
    const value = this.publications.get(`${input.actorSubject}\u0000${input.idempotencyKey}`);
    return value?.response ?? null;
  }

  async savePublication(input: { actorSubject: string; idempotencyKey: string; response: PublishBatchResponse }): Promise<void> {
    const key = `${input.actorSubject}\u0000${input.idempotencyKey}`;
    const existing = this.publications.get(key);
    this.publications.set(key, {
      reservation: existing?.reservation ?? {
        publicationId: input.response.publicationId,
        batchId: input.response.batchId,
        actorSubject: input.actorSubject,
        idempotencyKey: input.idempotencyKey,
        validationRevision: 1,
        entryKeys: input.response.entries.map((entry) => entry.entryKey),
      },
      response: input.response,
    });
  }

  async reservePublication(input: { reservation: PublicationReservation }): Promise<PublicationReservationResult> {
    const { reservation } = input;
    const key = `${reservation.actorSubject}\u0000${reservation.idempotencyKey}`;
    const existing = this.publications.get(key);
    if (!existing) {
      this.publications.set(key, { reservation, response: null });
      return { kind: "created", reservation };
    }
    if (
      existing.reservation.batchId !== reservation.batchId
      || existing.reservation.validationRevision !== reservation.validationRevision
      || existing.reservation.entryKeys.join("\u0000") !== reservation.entryKeys.join("\u0000")
    ) return { kind: "conflict" };
    if (existing.response) return { kind: "replay", response: existing.response };
    return { kind: "resume", reservation: existing.reservation };
  }

  async completePublication(input: { reservation: PublicationReservation; response: PublishBatchResponse }): Promise<void> {
    const key = `${input.reservation.actorSubject}\u0000${input.reservation.idempotencyKey}`;
    this.publications.set(key, { reservation: input.reservation, response: input.response });
    const batch = this.batches.get(input.reservation.batchId);
    if (!batch) return;
    const resultByEntry = new Map(input.response.entries.map((entry) => [entry.entryKey, entry]));
    for (const entry of batch.entries) {
      const result = resultByEntry.get(entry.entryKey);
      if (!result) continue;
      entry.status = result.status === "blocked" || result.status === "failed" ? "rejected" : "accepted";
      if (result.status === "published" || result.status === "unchanged") entry.publicationStatus = "published";
    }
    if (input.response.status === "completed") batch.status = "published";
  }

  private toPublished(
    entry: Extract<IngestionEntry, { operation: "upsert" }>,
    itemId: string,
    versionId: string,
    publicationRevision: number,
    bodySha256: string,
  ): StoredPublishedContent {
    const payload = entry.payload;
    return {
      itemId,
      kind: payload.kind,
      title: payload.document.title,
      version: {
        versionId,
        versionLabel: payload.kind === "legislation" ? payload.legislation.versionLabel : null,
        sourceKey: payload.source.sourceKey,
        sourceUrl: payload.source.url,
        publishedAt: payload.source.publishedAt,
        updatedAt: payload.source.updatedAt,
        bodyBytes: new TextEncoder().encode(payload.document.bodyText).byteLength,
        publicationStatus: "published",
      },
      bodyText: payload.document.bodyText,
      legislation: payload.kind === "legislation" ? payload.legislation : null,
      judgment: payload.kind === "judicial_document" ? payload.judgment : null,
      sourceRecordKey: payload.source.recordKey,
      bodySha256,
      publicationRevision,
    };
  }
}
