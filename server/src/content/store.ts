import { StringRecordId } from "surrealdb";
import {
  PublishBatchResponseSchema,
  type ContentVersionSummary,
  type IngestionEntry,
  type PublishBatchResponse,
  type SearchContentItem,
  type SearchContentRequest,
} from "@surreal-ck/shared/platform-content";
import { sha256Hex } from "@surreal-ck/shared/platform-content";
import {
  applyCitationResolutionOverlays,
  loadCitationResolutionOverlays,
  reconcileCitationResolutions as reconcileStoredCitationResolutions,
  type CitationResolutionReconcileResult,
} from "./citation-resolution";
import type {
  PlatformContentStore,
  ContentSourceRegistration,
  ContentSourceRegistrationInput,
  ContentSourceLicenseRevision,
  ContentAuditEvent,
  ContentAuditPage,
  ContentBatchSummary,
  ContentBatchSummaryPage,
  PublicationApplyResult,
  PublicationReservation,
  PublicationReservationResult,
  StoredContentBatch,
  StoredPublishedContent,
} from "./service";

type Queryable = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rows(result: unknown): Row[] {
  if (!Array.isArray(result) || !Array.isArray(result[0])) return [];
  return result[0].filter(isRow);
}

function firstValue(result: unknown): unknown {
  if (!Array.isArray(result) || !Array.isArray(result[0])) return undefined;
  return result[0][0];
}

function internalRecordId(value: unknown, table: string): StringRecordId | null {
  if (value instanceof StringRecordId) return value.toString().startsWith(`${table}:`) ? value : null;
  if (typeof value === "string" && value.startsWith(`${table}:`)) return new StringRecordId(value);
  if (isRow(value)) {
    const nested = internalRecordId(value.id, table);
    if (nested) return nested;
  }
  if (value && typeof value === "object" && "toString" in value) {
    const text = String(value);
    if (text.startsWith(`${table}:`)) return new StringRecordId(text);
  }
  return null;
}

function iso(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "toString" in value) return String(value);
  throw new Error("platform content row contains an invalid timestamp");
}

function asObject(value: unknown): Row | null {
  return isRow(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function cursorOffset(cursor: string | null): number {
  if (!cursor) return 0;
  if (!/^o[0-9a-z]+$/u.test(cursor)) throw new Error("platform content pagination cursor is invalid");
  const offset = Number.parseInt(cursor.slice(1), 36);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("platform content pagination cursor is invalid");
  return offset;
}

function nextCursor(offset: number): string {
  return `o${offset.toString(36)}`;
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : asString(value);
}

function parseLicense(value: unknown): ContentSourceLicenseRevision | null {
  if (!isRow(value)) return null;
  const revision = typeof value.revision === "number" ? value.revision : Number(value.revision);
  const licenseKind = asString(value.license_kind) ?? asString(value.licenseKind);
  let effectiveFrom: string | null = null;
  try {
    const rawEffectiveFrom = value.effective_from ?? value.effectiveFrom;
    effectiveFrom = rawEffectiveFrom === undefined || rawEffectiveFrom === null ? null : iso(rawEffectiveFrom);
  } catch {
    effectiveFrom = null;
  }
  if (!Number.isSafeInteger(revision) || revision < 1 || !licenseKind || !effectiveFrom) return null;
  const rawAllowedActions = value.allowed_actions ?? value.allowedActions;
  const allowedActions = Array.isArray(rawAllowedActions)
    ? rawAllowedActions.filter((action): action is ContentSourceLicenseRevision["allowedActions"][number] => action === "submit" || action === "publish" || action === "withdraw" || action === "restore")
    : [];
  return {
    revision,
    licenseKind,
    allowedActions,
    effectiveFrom,
    effectiveUntil: asNullableString(value.effective_until ?? value.effectiveUntil),
    evidenceUrl: asNullableString(value.evidence_url ?? value.evidenceUrl),
    evidenceText: asNullableString(value.evidence_text ?? value.evidenceText),
    ...(asString(value.created_by_subject ?? value.createdBySubject) ? { createdBySubject: asString(value.created_by_subject ?? value.createdBySubject)! } : {}),
    ...(value.created_at !== undefined || value.createdAt !== undefined ? { createdAt: iso(value.created_at ?? value.createdAt) } : {}),
  };
}

function parseSource(row: Row, license?: ContentSourceLicenseRevision | null): ContentSourceRegistration | null {
  const sourceKey = asString(row.source_key);
  const label = asString(row.label);
  const status = row.status === "active" || row.status === "inactive" ? row.status : null;
  if (!sourceKey || !label || !status) return null;
  const allowedActions = Array.isArray(row.allowed_actions)
    ? row.allowed_actions.filter((action): action is ContentSourceRegistration["allowedActions"][number] => action === "submit" || action === "publish" || action === "withdraw" || action === "restore")
    : [];
  const effectiveAllowedActions = license
    ? allowedActions.filter((action) => license.allowedActions.includes(action))
    : allowedActions;
  return {
    sourceKey,
    label,
    status,
    allowedActions: effectiveAllowedActions,
    jurisdiction: asNullableString(row.jurisdiction),
    ...(asString(row.base_url) ? { baseUrl: asString(row.base_url)! } : {}),
    license: license ?? null,
  };
}

function summarizeBatch(batch: StoredContentBatch): ContentBatchSummary {
  const sourceKeys = new Set<string>();
  for (const item of batch.request.items) if (item.operation === "upsert") sourceKeys.add(item.payload.source.sourceKey);
  return {
    batchId: batch.batchId,
    actorSubject: batch.actorSubject,
    idempotencyKey: batch.idempotencyKey,
    requestDigest: batch.requestDigest,
    receivedAt: batch.receivedAt,
    status: batch.status,
    validationRevision: batch.validationRevision,
    entryCount: batch.entries.length,
    acceptedCount: batch.entries.filter((entry) => entry.status === "accepted").length,
    duplicateCount: batch.entries.filter((entry) => entry.status === "duplicate").length,
    rejectedCount: batch.entries.filter((entry) => entry.status === "rejected").length,
    publishedCount: batch.entries.filter((entry) => entry.publicationStatus === "published").length,
    sourceKeys: [...sourceKeys].sort(),
  };
}

function parseBatch(row: Row, entryRows: Row[]): StoredContentBatch {
  const batchId = asString(row.public_id);
  if (!batchId || typeof row.actor_subject !== "string" || typeof row.idempotency_key !== "string") {
    throw new Error("platform content batch row is malformed");
  }
  const status = row.status;
  if (
    status !== "received" && status !== "validating" && status !== "ready"
    && status !== "partially_validated" && status !== "rejected" && status !== "published"
  ) throw new Error("platform content batch has invalid status");
  if (!isRow(row.request)) throw new Error("platform content batch has no request");
  const sourceLicenseSnapshot: Record<string, ContentSourceLicenseRevision> = {};
  if (isRow(row.source_license_snapshot)) {
    for (const [sourceKey, rawLicense] of Object.entries(row.source_license_snapshot)) {
      const license = parseLicense(rawLicense);
      if (license) sourceLicenseSnapshot[sourceKey] = license;
    }
  }
  return {
    batchId,
    actorSubject: row.actor_subject,
    idempotencyKey: row.idempotency_key,
    requestDigest: typeof row.request_digest === "string" ? row.request_digest : "",
    request: row.request as StoredContentBatch["request"],
    receivedAt: iso(row.received_at),
    status,
    validationRevision: typeof row.validation_revision === "number" ? row.validation_revision : 1,
    sourceLicenseSnapshot,
    entries: entryRows.map((entry) => ({
      entryKey: String(entry.entry_key),
      operation: entry.operation as StoredContentBatch["entries"][number]["operation"],
      status: entry.status as StoredContentBatch["entries"][number]["status"],
      issues: Array.isArray(entry.issues) ? entry.issues as StoredContentBatch["entries"][number]["issues"] : [],
      publicationStatus:
        entry.publication_status === "published" || entry.publication_status === "withdrawn"
          ? entry.publication_status
          : null,
    })),
  };
}

function publicationRequestId(publicationId: string): StringRecordId {
  return new StringRecordId(`publication_request:${publicationId}`);
}

function itemRecordId(itemId: string): StringRecordId {
  return new StringRecordId(`content_item:${itemId}`);
}

function versionRecordId(versionId: string): StringRecordId {
  return new StringRecordId(`content_version:${versionId}`);
}

function issue(code: "stale_version" | "identity_ambiguous" | "source_not_registered" | "publish_failed", message: string, retryable = false) {
  return { code, message, retryable } as const;
}

/**
 * 平台内容持久化端口。所有写入都使用绑定参数和内部 RecordId，公开给调用者的
 * 只有契约中的 opaque public_id；MCP/浏览器不会得到 root 凭证或任意 DML 能力。
 */
export class SurrealPlatformContentStore implements PlatformContentStore {
  constructor(
    private readonly db: Queryable,
    private readonly idFactory: (prefix: string) => StringRecordId = (prefix) =>
      new StringRecordId(`${prefix}:${crypto.randomUUID().replaceAll("-", "")}`),
  ) {}

  async listSources(): Promise<readonly ContentSourceRegistration[]> {
    const result = await this.db.query("SELECT * FROM content_source ORDER BY source_key ASC;");
    const sourceRows = rows(result);
    const licenseResult = await this.db.query("SELECT * FROM source_license_revision ORDER BY revision DESC;");
    const licensesBySource = new Map<string, ContentSourceLicenseRevision>();
    for (const row of rows(licenseResult)) {
      const sourceId = internalRecordId(row.source, "content_source")?.toString();
      const license = parseLicense(row);
      if (sourceId && license && !licensesBySource.has(sourceId)) licensesBySource.set(sourceId, license);
    }
    return sourceRows.flatMap((row) => {
      const sourceId = internalRecordId(row.id, "content_source")?.toString();
      const source = parseSource(row, sourceId ? licensesBySource.get(sourceId) ?? null : null);
      return source ? [source] : [];
    });
  }

  async registerSource(input: { source: ContentSourceRegistrationInput; actorSubject: string }): Promise<ContentSourceRegistration> {
    const { source: registration, actorSubject } = input;
    const existingResult = await this.db.query("SELECT * FROM content_source WHERE source_key = $sourceKey LIMIT 1;", {
      sourceKey: registration.sourceKey,
    });
    const existing = rows(existingResult)[0];
    const source = existing ? internalRecordId(existing.id, "content_source") : this.idFactory("content_source");
    if (!source) throw new Error("platform content source record id is malformed");
    const revisionResult = await this.db.query(
      "SELECT VALUE revision FROM source_license_revision WHERE source = $source ORDER BY revision DESC LIMIT 1;",
      { source },
    );
    const currentRevisionValue = firstValue(revisionResult);
    const currentRevision = typeof currentRevisionValue === "number" ? currentRevisionValue : Number(currentRevisionValue ?? 0);
    if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) throw new Error("platform content source license revision is malformed");
    if (registration.expectedLicenseRevision !== undefined && registration.expectedLicenseRevision !== null && registration.expectedLicenseRevision !== currentRevision) {
      throw new Error("platform-content-stale-source");
    }
    const nextRevision = currentRevision + 1;
    const license = this.idFactory("source_license_revision");
    const statements: string[] = ["BEGIN TRANSACTION;"];
    const params: Record<string, unknown> = {
      source,
      license,
      sourceKey: registration.sourceKey,
      label: registration.label,
      jurisdiction: registration.jurisdiction ?? undefined,
      baseUrl: registration.baseUrl,
      status: registration.status,
      allowedActions: registration.allowedActions,
      revision: nextRevision,
      licenseKind: registration.license.licenseKind,
      licenseAllowedActions: registration.license.allowedActions,
      effectiveFrom: new Date(registration.license.effectiveFrom),
      effectiveUntil: registration.license.effectiveUntil ? new Date(registration.license.effectiveUntil) : undefined,
      evidenceUrl: registration.license.evidenceUrl ?? undefined,
      evidenceText: registration.license.evidenceText ?? undefined,
      actorSubject,
      auditKind: existing ? "source_updated" : "source_registered",
      auditDetails: {
        sourceKey: registration.sourceKey,
        licenseRevision: nextRevision,
        licenseKind: registration.license.licenseKind,
        allowedActions: registration.license.allowedActions,
      },
    };
    if (existing) {
      statements.push("UPDATE $source SET label = $label, jurisdiction = $jurisdiction, base_url = $baseUrl, status = $status, allowed_actions = $allowedActions, updated_at = time::now();");
    } else {
      statements.push("CREATE $source CONTENT { source_key: $sourceKey, label: $label, jurisdiction: $jurisdiction, base_url: $baseUrl, status: $status, allowed_actions: $allowedActions, created_at: time::now(), updated_at: time::now() };");
    }
    statements.push(
      "CREATE $license CONTENT { source: $source, revision: $revision, license_kind: $licenseKind, allowed_actions: $licenseAllowedActions, effective_from: $effectiveFrom, effective_until: $effectiveUntil, evidence_url: $evidenceUrl, evidence_text: $evidenceText, created_by_subject: $actorSubject, created_at: time::now() };",
      "CREATE platform_content_audit_event CONTENT { kind: $auditKind, actor_subject: $actorSubject, details: $auditDetails, occurred_at: time::now() };",
      "COMMIT TRANSACTION;",
    );
    try {
      await this.db.query(statements.join("\n"), params);
    } catch (error) {
      await this.db.query("CANCEL TRANSACTION;").catch(() => undefined);
      throw error;
    }
    const sources = await this.listSources();
    const result = sources.find((candidate) => candidate.sourceKey === registration.sourceKey);
    if (!result) throw new Error("platform content source was not readable after registration");
    return result;
  }

  async findBatchByIdempotency(input: { actorSubject: string; idempotencyKey: string }): Promise<StoredContentBatch | null> {
    const result = await this.db.query(
      `SELECT * FROM ingestion_batch
       WHERE actor_subject = $actorSubject AND idempotency_key = $idempotencyKey
       LIMIT 1;`,
      input,
    );
    const row = rows(result)[0];
    return row ? this.getBatch(asString(row.public_id) ?? "") : null;
  }

  async saveBatch(batch: StoredContentBatch): Promise<void> {
    const batchId = new StringRecordId(`ingestion_batch:${batch.batchId}`);
    const statements = ["BEGIN TRANSACTION;"];
    const params: Record<string, unknown> = {
      batch: batchId,
      publicId: batch.batchId,
      actorSubject: batch.actorSubject,
      idempotencyKey: batch.idempotencyKey,
      requestDigest: batch.requestDigest,
      contractVersion: batch.request.contractVersion,
      request: batch.request,
      status: batch.status,
      validationRevision: batch.validationRevision,
      sourceLicenseSnapshot: batch.sourceLicenseSnapshot ?? {},
      receivedAt: new Date(batch.receivedAt),
      entryCount: batch.entries.length,
    };
    statements.push(
      `CREATE $batch CONTENT {
        public_id: $publicId,
        actor_subject: $actorSubject,
        idempotency_key: $idempotencyKey,
        request_digest: $requestDigest,
        contract_version: $contractVersion,
        request: $request,
        status: $status,
        validation_revision: $validationRevision,
        source_license_snapshot: $sourceLicenseSnapshot,
        received_at: $receivedAt,
        updated_at: time::now()
      };`,
    );
    for (const entry of batch.entries) {
      const entryId = this.idFactory("ingestion_entry");
      const name = `entry_${params.entryCount}_${entry.entryKey.replace(/[^A-Za-z0-9_]/gu, "_")}`;
      params[name] = entryId;
      params[`${name}_key`] = entry.entryKey;
      params[`${name}_operation`] = entry.operation;
      params[`${name}_payload`] = batch.request.items.find((item) => item.entryKey === entry.entryKey);
      params[`${name}_status`] = entry.status;
      params[`${name}_issues`] = entry.issues;
      params[`${name}_publication_status`] = entry.publicationStatus ?? undefined;
      statements.push(
        `CREATE $${name} CONTENT {
          batch: $batch,
          entry_key: $${name}_key,
          operation: $${name}_operation,
          payload: $${name}_payload,
          status: $${name}_status,
          issues: $${name}_issues,
          publication_status: $${name}_publication_status,
          created_at: time::now()
        };`,
      );
    }
    statements.push(
      "CREATE platform_content_audit_event CONTENT { kind: \"batch_received\", batch: $batch, actor_subject: $actorSubject, details: { entry_count: $entryCount }, occurred_at: time::now() };",
      "COMMIT TRANSACTION;",
    );
    try {
      await this.db.query(statements.join("\n"), params);
    } catch (error) {
      await this.db.query("CANCEL TRANSACTION;").catch(() => undefined);
      throw error;
    }
  }

  async getBatch(batchId: string): Promise<StoredContentBatch | null> {
    if (!batchId || /^[A-Za-z_][A-Za-z0-9_]*:[^:]+$/u.test(batchId)) return null;
    const result = await this.db.query(
      "SELECT * FROM ingestion_batch WHERE public_id = $batchId LIMIT 1;",
      { batchId },
    );
    const batch = rows(result)[0];
    if (!batch) return null;
    const batchRecord = internalRecordId(batch.id, "ingestion_batch");
    if (!batchRecord) throw new Error("platform content batch record id is malformed");
    const entriesResult = await this.db.query(
      "SELECT * FROM ingestion_entry WHERE batch = $batch ORDER BY created_at ASC;",
      { batch: batchRecord },
    );
    return parseBatch(batch, rows(entriesResult));
  }

  async listBatchSummaries(input: { cursor: string | null; limit: number; status?: StoredContentBatch["status"] }): Promise<ContentBatchSummaryPage> {
    const offset = cursorOffset(input.cursor);
    const conditions = input.status ? "WHERE status = $status" : "";
    const result = await this.db.query(
      `SELECT public_id, received_at FROM ingestion_batch ${conditions} ORDER BY received_at DESC START $offset LIMIT $pageLimit;`,
      { ...(input.status ? { status: input.status } : {}), offset, pageLimit: input.limit + 1 },
    );
    const ids = rows(result).flatMap((row) => {
      const publicId = asString(row.public_id);
      return publicId ? [publicId] : [];
    });
    const pageIds = ids.slice(0, input.limit);
    const items: ContentBatchSummary[] = [];
    for (const batchId of pageIds) {
      const batch = await this.getBatch(batchId);
      if (batch) items.push(summarizeBatch(batch));
    }
    return {
      items,
      nextCursor: ids.length > input.limit ? nextCursor(offset + items.length) : null,
    };
  }

  async listAuditEvents(input: { cursor: string | null; limit: number; kind?: string; batchId?: string }): Promise<ContentAuditPage> {
    const offset = cursorOffset(input.cursor);
    const conditions: string[] = [];
    const params: Record<string, unknown> = { offset, pageLimit: input.limit + 1 };
    if (input.kind) {
      conditions.push("kind = $kind");
      params.kind = input.kind;
    }
    if (input.batchId) {
      conditions.push("batch IN (SELECT VALUE id FROM ingestion_batch WHERE public_id = $batchId)");
      params.batchId = input.batchId;
    }
    const result = await this.db.query(
      `SELECT * FROM platform_content_audit_event ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY occurred_at DESC START $offset LIMIT $pageLimit;`,
      params,
    );
    const rowsPage = rows(result);
    const items: ContentAuditEvent[] = rowsPage.slice(0, input.limit).flatMap((row) => {
      const eventId = row.id && typeof row.id === "object" ? String(row.id) : asString(row.id);
      const kind = asString(row.kind);
      const actorSubject = asString(row.actor_subject);
      if (!eventId || !kind || !actorSubject) return [];
      let occurredAt: string;
      try {
        occurredAt = iso(row.occurred_at);
      } catch {
        return [];
      }
      const batchObject = asObject(row.batch);
      const batchId = asString(batchObject?.public_id) ?? (typeof row.batch === "string" && row.batch.startsWith("ingestion_batch:") ? row.batch.slice("ingestion_batch:".length) : null);
      const entryObject = asObject(row.entry);
      const entryKey = asString(entryObject?.entry_key);
      return [{
        eventId,
        kind,
        actorSubject,
        occurredAt,
        batchId,
        entryKey,
        details: asObject(row.details) ?? {},
      }];
    });
    return {
      items,
      nextCursor: rowsPage.length > input.limit ? nextCursor(offset + items.length) : null,
    };
  }

  async findBySourceRecord(input: { sourceKey: string; recordKey: string }): Promise<StoredPublishedContent | null> {
    const result = await this.db.query(
      `SELECT * FROM content_publication_projection
       WHERE version.source.source_key = $sourceKey
         AND version.source_record_key = $recordKey
       LIMIT 1
       FETCH item, version, version.source;`,
      input,
    );
    const item = parsePublished(rows(result)[0]);
    if (!item) return null;
    const overlays = await loadCitationResolutionOverlays(this.db, [item.version.versionId]);
    return applyCitationResolutionOverlays([item], overlays)[0] ?? null;
  }

  async searchPublished(input: SearchContentRequest): Promise<StoredPublishedContent[]> {
    const conditions: string[] = ["item.publication_status = $publicationStatus"];
    const params: Record<string, unknown> = { publicationStatus: input.filters?.publicationStatus ?? "published" };
    if (input.filters?.kind) {
      conditions.push("item.kind = $kind");
      params.kind = input.filters.kind;
    }
    if (input.filters?.sourceKey) {
      conditions.push("version.source.source_key = $sourceKey");
      params.sourceKey = input.filters.sourceKey;
    }
    if (input.filters?.query) {
      conditions.push("searchable_text CONTAINS $query");
      params.query = input.filters.query;
    }
    if (input.filters?.caseNumber) {
      conditions.push("version.content_kind_payload.judgment.caseNumber = $caseNumber");
      params.caseNumber = input.filters.caseNumber;
    }
    const result = await this.db.query(
      `SELECT * FROM content_publication_projection
       WHERE ${conditions.join(" AND ")}
       ORDER BY indexed_at DESC LIMIT $limit
       FETCH item, version, version.source;`,
      { ...params, limit: input.limit },
    );
    const items = rows(result).flatMap((row) => {
      const item = parsePublished(row);
      return item ? [item] : [];
    });
    const overlays = await loadCitationResolutionOverlays(this.db, items.map((item) => item.version.versionId));
    return applyCitationResolutionOverlays(items, overlays);
  }

  async reconcileCitationResolutions(input: { actorSubject: string }): Promise<CitationResolutionReconcileResult> {
    return reconcileStoredCitationResolutions(this.db, input.actorSubject);
  }

  async reservePublication(input: { reservation: PublicationReservation }): Promise<PublicationReservationResult> {
    const { reservation } = input;
    const existingResult = await this.db.query(
      `SELECT * FROM publication_request
       WHERE actor_subject = $actorSubject AND idempotency_key = $idempotencyKey
       LIMIT 1;`,
      { actorSubject: reservation.actorSubject, idempotencyKey: reservation.idempotencyKey },
    );
    const existing = rows(existingResult)[0];
    if (existing) {
      const currentEntryKeys = Array.isArray(existing.entry_keys) ? existing.entry_keys.map(String) : [];
      const batchObject = asObject(existing.batch);
      const currentBatchId = asString(existing.batch_public_id) ?? asString(batchObject?.public_id);
      if (
        currentBatchId !== reservation.batchId
        || Number(existing.validation_revision) !== reservation.validationRevision
        || currentEntryKeys.join("\u0000") !== reservation.entryKeys.join("\u0000")
      ) return { kind: "conflict" };
      if (isRow(existing.response)) {
        return { kind: "replay", response: PublishBatchResponseSchema.parse(existing.response) };
      }
      const publicId = asString(existing.public_id);
      if (!publicId) throw new Error("publication request public id is missing");
      return { kind: "resume", reservation: { ...reservation, publicationId: publicId } };
    }

    const batchResult = await this.db.query(
      "SELECT VALUE id FROM ingestion_batch WHERE public_id = $batchId LIMIT 1;",
      { batchId: reservation.batchId },
    );
    const batchRecord = internalRecordId(firstValue(batchResult), "ingestion_batch");
    if (!batchRecord) return { kind: "conflict" };
    const requestId = publicationRequestId(reservation.publicationId);
    try {
      await this.db.query(
        `CREATE $request CONTENT {
          public_id: $publicId,
          batch: $batch,
          actor_subject: $actorSubject,
          validation_revision: $validationRevision,
          entry_keys: $entryKeys,
          idempotency_key: $idempotencyKey,
          status: "pending",
          response: NONE,
          created_at: time::now(),
          updated_at: time::now()
        };`,
        {
          request: requestId,
          publicId: reservation.publicationId,
          batch: batchRecord,
          actorSubject: reservation.actorSubject,
          validationRevision: reservation.validationRevision,
          entryKeys: reservation.entryKeys,
          idempotencyKey: reservation.idempotencyKey,
        },
      );
      return { kind: "created", reservation };
    } catch (error) {
      const retry = await this.db.query(
        "SELECT * FROM publication_request WHERE actor_subject = $actorSubject AND idempotency_key = $idempotencyKey LIMIT 1;",
        { actorSubject: reservation.actorSubject, idempotencyKey: reservation.idempotencyKey },
      );
      const row = rows(retry)[0];
      if (!row) throw error;
      const publicId = asString(row.public_id);
      if (!publicId) throw error;
      const currentEntryKeys = Array.isArray(row.entry_keys) ? row.entry_keys.map(String) : [];
      const batchObject = asObject(row.batch);
      if (
        (asString(row.batch_public_id) ?? asString(batchObject?.public_id)) !== reservation.batchId
        || Number(row.validation_revision) !== reservation.validationRevision
        || currentEntryKeys.join("\u0000") !== reservation.entryKeys.join("\u0000")
      ) return { kind: "conflict" };
      if (isRow(row.response)) return { kind: "replay", response: PublishBatchResponseSchema.parse(row.response) };
      return { kind: "resume", reservation: { ...reservation, publicationId: publicId } };
    }
  }

  async completePublication(input: { reservation: PublicationReservation; response: PublishBatchResponse }): Promise<void> {
    const status = input.response.status;
    const requestId = publicationRequestId(input.reservation.publicationId);
    await this.db.query(
      `UPDATE $request SET status = $status, response = $response, updated_at = time::now();
       UPDATE ingestion_batch SET status = IF $status = "completed" THEN "published" ELSE status END
         WHERE public_id = $batchId;
       CREATE platform_content_audit_event CONTENT {
         kind: "publication_completed",
         batch: (SELECT VALUE id FROM ingestion_batch WHERE public_id = $batchId LIMIT 1)[0],
         actor_subject: $actorSubject,
         details: { publication_id: $publicationId, status: $status },
         occurred_at: time::now()
       };`,
      {
        request: requestId,
        status,
        response: input.response,
        batchId: input.reservation.batchId,
        actorSubject: input.reservation.actorSubject,
        publicationId: input.reservation.publicationId,
      },
    );
  }

  async applyPublication(input: {
    batch: StoredContentBatch;
    entryKey: string;
    actorSubject: string;
    publicationId?: string;
  }): Promise<PublicationApplyResult> {
    const requestEntry = input.batch.request.items.find((candidate) => candidate.entryKey === input.entryKey);
    if (!requestEntry) return { status: "blocked", versionId: null, issues: [issue("identity_ambiguous", "发布条目不存在")] };
    if (requestEntry.operation === "upsert") return this.applyUpsert(input, requestEntry);
    return this.applyPublicationState(input, requestEntry);
  }

  async findPublicationByIdempotency(input: { actorSubject: string; idempotencyKey: string }): Promise<PublishBatchResponse | null> {
    const result = await this.db.query(
      "SELECT response FROM publication_request WHERE actor_subject = $actorSubject AND idempotency_key = $idempotencyKey LIMIT 1;",
      input,
    );
    const response = rows(result)[0]?.response;
    return isRow(response) ? PublishBatchResponseSchema.parse(response) : null;
  }

  async savePublication(input: { actorSubject: string; idempotencyKey: string; response: PublishBatchResponse }): Promise<void> {
    const result = await this.db.query(
      "SELECT * FROM publication_request WHERE actor_subject = $actorSubject AND idempotency_key = $idempotencyKey LIMIT 1;",
      input,
    );
    const row = rows(result)[0];
    const request = row ? internalRecordId(row.id, "publication_request") : null;
    if (!request) return;
    await this.db.query("UPDATE $request SET status = $status, response = $response, updated_at = time::now();", {
      request,
      status: input.response.status,
      response: input.response,
    });
  }

  private async applyUpsert(
    input: { batch: StoredContentBatch; entryKey: string; actorSubject: string; publicationId?: string },
    entry: Extract<IngestionEntry, { operation: "upsert" }>,
  ): Promise<PublicationApplyResult> {
    const payload = entry.payload;
    const sourceResult = await this.db.query("SELECT * FROM content_source WHERE source_key = $sourceKey LIMIT 1;", {
      sourceKey: payload.source.sourceKey,
    });
    const sourceRow = rows(sourceResult)[0];
    const source = sourceRow ? internalRecordId(sourceRow.id, "content_source") : null;
    if (!source) return { status: "blocked", versionId: null, issues: [issue("source_not_registered", `来源 ${payload.source.sourceKey} 未登记`)] };

    const bodySha256 = await sha256Hex(payload.document.bodyText);
    const existingBySource = payload.source.recordKey
      ? await this.findBySourceRecord({ sourceKey: payload.source.sourceKey, recordKey: payload.source.recordKey })
      : null;
    if (existingBySource && existingBySource.bodySha256 === bodySha256) {
      return { status: "unchanged", versionId: existingBySource.version.versionId, issues: [] };
    }

    const targetId = payload.target?.itemId ?? existingBySource?.itemId ?? null;
    const target = targetId ? await this.readItem(targetId) : null;
    if (target) {
      const expectedVersion = payload.target?.expectedVersionId;
      const expectedRevision = payload.target?.expectedPublicationRevision;
      if ((expectedVersion && expectedVersion !== target.versionId) || (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== target.publicationRevision)) {
        return { status: "blocked", versionId: target.versionId, issues: [issue("stale_version", "目标内容版本或发布修订已变化，请重新 inspect_batch")] };
      }
    }

    const itemId = targetId ?? `item_${crypto.randomUUID().replaceAll("-", "")}`;
    const versionId = `version_${crypto.randomUUID().replaceAll("-", "")}`;
    const itemRecord = itemRecordId(itemId);
    const versionRecord = versionRecordId(versionId);
    const nextRevision = target ? target.publicationRevision + 1 : 1;
    const entryRecord = await this.entryRecord(input.batch.batchId, input.entryKey);
    if (!entryRecord) return { status: "blocked", versionId: null, issues: [issue("identity_ambiguous", "发布条目的持久化记录不存在")] };

    const statements: string[] = ["BEGIN TRANSACTION;"];
    const binds: Record<string, unknown> = {
      item: itemRecord,
      version: versionRecord,
      itemId,
      versionId,
      revision: nextRevision,
      source,
      sourceUrl: payload.source.url,
      sourceRecordKey: payload.source.recordKey ?? undefined,
      fetchedAt: new Date(payload.source.fetchedAt),
      publishedAt: payload.source.publishedAt ? new Date(payload.source.publishedAt) : undefined,
      updatedAtSource: payload.source.updatedAt ? new Date(payload.source.updatedAt) : undefined,
      publishedOn: payload.source.publishedOn ?? undefined,
      updatedOn: payload.source.updatedOn ?? undefined,
      dateText: payload.source.dateText ?? undefined,
      title: payload.document.title,
      bodyText: payload.document.bodyText,
      bodySha256,
      sourceForm: payload.document.sourceForm,
      evidence: payload.document.evidence,
      fieldIssues: payload.document.fieldIssues,
      processing: payload.document.processing,
      contentKindPayload: payload.kind === "legislation"
        ? { kind: payload.kind, legislation: payload.legislation }
        : { kind: payload.kind, judgment: payload.judgment },
      kind: payload.kind,
      actorSubject: input.actorSubject,
      entry: entryRecord,
      publicationRequest: input.publicationId ? publicationRequestId(input.publicationId) : undefined,
      searchableText: [payload.document.title, payload.document.bodyText, JSON.stringify(payload.kind === "legislation" ? payload.legislation : payload.judgment)].join("\n"),
      entryKey: input.entryKey,
    };
    if (target) {
      binds.expectedRevision = target.publicationRevision;
    } else {
      // content_version.item and content_item.current_version form a cycle. Create the
      // item with NONE first, then attach the immutable version in the same transaction.
      statements.push("CREATE $item CONTENT { public_id: $itemId, kind: $kind, current_version: NONE, publication_status: \"published\", publication_revision: 1, created_at: time::now(), updated_at: time::now() };");
    }
    statements.push(
      "CREATE $version CONTENT { public_id: $versionId, item: $item, revision: $revision, version_label: $versionLabel, source: $source, source_url: $sourceUrl, source_record_key: $sourceRecordKey, fetched_at: $fetchedAt, published_at: $publishedAt, updated_at_source: $updatedAtSource, published_on: $publishedOn, updated_on: $updatedOn, source_date_text: $dateText, title: $title, body_text: $bodyText, body_sha256: $bodySha256, source_form: $sourceForm, evidence: $evidence, field_issues: $fieldIssues, processing: $processing, content_kind_payload: $contentKindPayload, created_by_subject: $actorSubject, created_at: time::now() };",
      target
        ? "LET $updated_item = UPDATE $item SET current_version = $version, publication_status = \"published\", publication_revision = $revision WHERE public_id = $itemId AND publication_revision = $expectedRevision;"
        : "LET $updated_item = UPDATE $item SET current_version = $version WHERE public_id = $itemId;",
      "IF $updated_item = [] { THROW \"platform-content-stale\" };",
    );
    if (payload.kind === "legislation") {
      for (const [index, article] of payload.legislation.articles.entries()) {
        const variable = `article_${index}`;
        const articleId = this.idFactory("legal_article_version");
        binds[variable] = articleId;
        binds[`${variable}_local_key`] = article.localKey;
        binds[`${variable}_label`] = article.label;
        binds[`${variable}_hierarchy_path`] = article.hierarchyPath;
        binds[`${variable}_body_text`] = article.bodyText;
        binds[`${variable}_locator`] = article.locator ?? undefined;
        binds[`${variable}_source_locator`] = article.sourceLocator ?? undefined;
        binds[`${variable}_effective_on`] = article.effectiveOn ?? undefined;
        statements.push(
          `CREATE $${variable} CONTENT { regulation_version: $version, local_key: $${variable}_local_key, label: $${variable}_label, hierarchy_path: $${variable}_hierarchy_path, body_text: $${variable}_body_text, locator: $${variable}_locator, source_locator: $${variable}_source_locator, effective_on: $${variable}_effective_on, created_at: time::now() };`,
        );
      }
    }
    if (payload.kind === "judicial_document") {
      for (const [index, citation] of payload.judgment.citations.entries()) {
        const variable = `citation_${index}`;
        const citationId = this.idFactory("content_citation");
        const resolutionId = this.idFactory("citation_resolution");
        binds[variable] = citationId;
        binds[`${variable}_local_key`] = citation.localCitationKey;
        binds[`${variable}_relation_kind`] = citation.relationKind;
        binds[`${variable}_speaker`] = citation.speaker;
        binds[`${variable}_quoted_text`] = citation.quotedText;
        binds[`${variable}_locator`] = citation.locator;
        binds[`${variable}_raw_law_name`] = citation.rawLawName ?? undefined;
        binds[`${variable}_raw_article_label`] = citation.rawArticleLabel ?? undefined;
        binds[`${variable}_resolution`] = citation.resolution;
        binds[`${variable}_candidates`] = citation.candidates;
        binds[`${variable}_treatment`] = citation.treatment ?? undefined;
        binds[`${variable}_treatment_evidence`] = citation.treatmentEvidence ?? undefined;
        binds[`${variable}_resolution_id`] = resolutionId;
        statements.push(
          `CREATE $${variable} CONTENT { document_version: $version, local_citation_key: $${variable}_local_key, relation_kind: $${variable}_relation_kind, speaker: $${variable}_speaker, quoted_text: $${variable}_quoted_text, locator: $${variable}_locator, raw_law_name: $${variable}_raw_law_name, raw_article_label: $${variable}_raw_article_label, resolution: $${variable}_resolution, candidates: $${variable}_candidates, treatment: $${variable}_treatment, treatment_evidence: $${variable}_treatment_evidence, created_at: time::now() };`,
          `CREATE $${variable}_resolution_id CONTENT { citation: $${variable}, revision: 1, status: $${variable}_resolution, candidates: $${variable}_candidates, evidence_ref: NONE, verified_by_subject: IF $${variable}_resolution = \"verified\" THEN $actorSubject ELSE NONE END, created_at: time::now() };`,
        );
      }
    }
    statements.push(
      "LET $source_record = SELECT VALUE id FROM content_source_record WHERE source = $source AND record_key = $sourceRecordKey LIMIT 1;",
      "IF $sourceRecordKey != NONE AND $source_record = [] { CREATE content_source_record CONTENT { source: $source, record_key: $sourceRecordKey, item: $item, source_url: $sourceUrl, first_seen_at: time::now(), last_seen_at: time::now() }; } ELSE IF $sourceRecordKey != NONE { UPDATE $source_record[0] SET item = $item, source_url = $sourceUrl, last_seen_at = time::now(); };",
      "LET $projection = SELECT VALUE id FROM content_publication_projection WHERE item = $item LIMIT 1;",
      "IF $projection = [] { CREATE content_publication_projection CONTENT { item: $item, version: $version, searchable_text: $searchableText, indexed_at: time::now(), publication_revision: $revision, created_at: time::now() }; } ELSE { UPDATE $projection[0] SET item = $item, version = $version, searchable_text = $searchableText, indexed_at = time::now(), publication_revision = $revision; };",
      "CREATE publication_event CONTENT { request: $publicationRequest, entry: $entry, item: $item, version: $version, event_kind: IF $revision = 1 THEN \"published\" ELSE \"corrected\" END, actor_subject: $actorSubject, reason: NONE, occurred_at: time::now() };",
      "UPSERT publication_item_result CONTENT { request: $publicationRequest, entry_key: $entryKey, status: \"published\", version: $version, issues: [], created_at: time::now() };",
      "UPDATE $entryRecord SET status = \"published\", publication_status = \"published\";",
      "COMMIT TRANSACTION;",
    );
    binds.versionLabel = payload.kind === "legislation" ? (payload.legislation.versionLabel ?? undefined) : undefined;
    binds.entryRecord = entryRecord;
    try {
      await this.db.query(statements.join("\n"), binds);
      return { status: "published", versionId, issues: [] };
    } catch (error) {
      if (String(error).includes("platform-content-stale")) {
        const current = await this.readItem(itemId);
        return { status: "blocked", versionId: current?.versionId ?? null, issues: [issue("stale_version", "目标内容版本或发布修订已变化，请重新 inspect_batch")] };
      }
      return { status: "failed", versionId: null, issues: [issue("publish_failed", String(error), true)] };
    }
  }

  private async applyPublicationState(
    input: { batch: StoredContentBatch; entryKey: string; actorSubject: string; publicationId?: string },
    entry: Extract<IngestionEntry, { operation: "withdraw" | "restore" }>,
  ): Promise<PublicationApplyResult> {
    const target = await this.readItem(entry.payload.target.itemId);
    if (!target) return { status: "blocked", versionId: null, issues: [issue("identity_ambiguous", "目标内容不存在")] };
    if (
      (entry.payload.target.expectedVersionId && entry.payload.target.expectedVersionId !== target.versionId)
      || entry.payload.target.expectedPublicationRevision === undefined
      || entry.payload.target.expectedPublicationRevision === null
      || entry.payload.target.expectedPublicationRevision !== target.publicationRevision
    ) return { status: "blocked", versionId: target.versionId, issues: [issue("stale_version", "发布状态前提已变化，请重新 inspect_batch")] };
    const entryRecord = await this.entryRecord(input.batch.batchId, input.entryKey);
    if (!entryRecord) return { status: "blocked", versionId: null, issues: [issue("identity_ambiguous", "发布条目的持久化记录不存在")] };
    const itemRecord = itemRecordId(entry.payload.target.itemId);
    const nextStatus = entry.operation === "withdraw" ? "withdrawn" : "published";
    const nextRevision = target.publicationRevision + 1;
    const requestRecord = input.publicationId ? publicationRequestId(input.publicationId) : undefined;
    const statements = [
      "BEGIN TRANSACTION;",
      "LET $updated_item = UPDATE $item SET publication_status = $status, publication_revision = $revision WHERE public_id = $itemId AND publication_revision = $expectedRevision;",
      "IF $updated_item = [] { THROW \"platform-content-stale\" };",
      "LET $projection = SELECT VALUE id FROM content_publication_projection WHERE item = $item LIMIT 1;",
      "IF $projection != [] { UPDATE $projection[0] SET publication_revision = $revision, indexed_at = time::now(); };",
      "CREATE publication_event CONTENT { request: $publicationRequest, entry: $entry, item: $item, version: $version, event_kind: $eventKind, actor_subject: $actorSubject, reason: $reason, occurred_at: time::now() };",
      "UPSERT publication_item_result CONTENT { request: $publicationRequest, entry_key: $entryKey, status: \"published\", version: $version, issues: [], created_at: time::now() };",
      "UPDATE $entryRecord SET status = \"published\", publication_status = $status;",
      "COMMIT TRANSACTION;",
    ];
    try {
      await this.db.query(statements.join("\n"), {
        item: itemRecord,
        itemId: entry.payload.target.itemId,
        status: nextStatus,
        revision: nextRevision,
        expectedRevision: target.publicationRevision,
        publicationRequest: requestRecord,
        entry: entryRecord,
        version: versionRecordId(target.versionId),
        eventKind: entry.operation === "withdraw" ? "withdrawn" : "restored",
        actorSubject: input.actorSubject,
        reason: entry.payload.reason,
        entryRecord,
        entryKey: input.entryKey,
      });
      return { status: "published", versionId: target.versionId, issues: [] };
    } catch (error) {
      if (String(error).includes("platform-content-stale")) {
        const current = await this.readItem(entry.payload.target.itemId);
        return { status: "blocked", versionId: current?.versionId ?? target.versionId, issues: [issue("stale_version", "发布状态前提已变化，请重新 inspect_batch")] };
      }
      return { status: "failed", versionId: target.versionId, issues: [issue("publish_failed", String(error), true)] };
    }
  }

  private async entryRecord(batchId: string, entryKey: string): Promise<StringRecordId | null> {
    const batchResult = await this.db.query("SELECT VALUE id FROM ingestion_batch WHERE public_id = $batchId LIMIT 1;", { batchId });
    const batch = internalRecordId(firstValue(batchResult), "ingestion_batch");
    if (!batch) return null;
    const result = await this.db.query("SELECT VALUE id FROM ingestion_entry WHERE batch = $batch AND entry_key = $entryKey LIMIT 1;", { batch, entryKey });
    return internalRecordId(firstValue(result), "ingestion_entry");
  }

  private async readItem(itemId: string): Promise<{ versionId: string; publicationRevision: number } | null> {
    const result = await this.db.query("SELECT * FROM content_item WHERE public_id = $itemId LIMIT 1 FETCH current_version, current_version.source;", { itemId });
    const row = rows(result)[0];
    if (!row) return null;
    const version = asObject(row.current_version);
    const versionId = asString(version?.public_id);
    if (!versionId) return null;
    return {
      versionId,
      publicationRevision: typeof row.publication_revision === "number" ? row.publication_revision : 1,
    };
  }
}

function parsePublished(row: Row | undefined): StoredPublishedContent | null {
  if (!row) return null;
  const item = asObject(row.item) ?? row;
  const version = asObject(row.version) ?? row;
  const source = asObject(version.source);
  const itemId = asString(item.public_id) ?? asString(row.item_public_id);
  const versionId = asString(version.public_id) ?? asString(row.version_public_id);
  const kind = item.kind === "legislation" || item.kind === "judicial_document" ? item.kind : null;
  const title = asString(version.title) ?? asString(item.title);
  const bodyText = asString(version.body_text) ?? asString(item.body_text);
  const sourceKey = asString(source?.source_key) ?? asString(version.source_key);
  if (!itemId || !versionId || !kind || !title || bodyText === null || !sourceKey) return null;
  const contentPayload = asObject(version.content_kind_payload);
  const versionSummary: ContentVersionSummary = {
    versionId,
    versionLabel: asString(version.version_label),
    sourceKey,
    sourceUrl: asString(version.source_url) ?? "https://example.invalid/unknown",
    publishedAt: asString(version.published_at),
    updatedAt: asString(version.updated_at_source),
    bodyBytes: typeof version.body_text_bytes === "number" ? version.body_text_bytes : new TextEncoder().encode(bodyText).byteLength,
    publicationStatus: item.publication_status === "withdrawn" ? "withdrawn" : "published",
  };
  return {
    itemId,
    kind,
    title,
    version: versionSummary,
    bodyText,
    legislation: kind === "legislation" && isRow(contentPayload?.legislation) ? contentPayload.legislation as SearchContentItem["legislation"] : null,
    judgment: kind === "judicial_document" && isRow(contentPayload?.judgment) ? contentPayload.judgment as SearchContentItem["judgment"] : null,
    sourceRecordKey: asString(version.source_record_key),
    bodySha256: asString(version.body_sha256) ?? "",
    publicationRevision: typeof item.publication_revision === "number" ? item.publication_revision : (typeof row.publication_revision === "number" ? row.publication_revision : 1),
  };
}
