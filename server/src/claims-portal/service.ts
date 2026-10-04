import { StringRecordId } from "surrealdb";
import { getRootDatabaseSession } from "../db/root-connection";
import { toStringRecordId } from "../db/surreal-values";
import { HttpError } from "../http-error";
import { resolveWorkspaceBySlug } from "../../ai/office/employee-service";
import { getClaimsAttachmentConfig, getClaimsPortalPepper } from "./config";
import {
  FAIL_THRESHOLD,
  FAIL_WINDOW_MS,
  LOCK_MS,
  OPEN_FAILURE_MESSAGE,
  SESSION_TTL_MS,
} from "./constants";
import { decodeSessionCookie, encodeSessionCookie, generateToken, hashToken } from "./crypto";
import {
  buildClaimsAttachmentKey,
  createAttachmentStorage,
  type ClaimsAttachmentStorage,
} from "./storage";
import {
  assertAttachmentMeta,
  normalizeDraft,
  type SubmissionDraftInput,
} from "./validation";

export type ClaimsQueryable = {
  query: (sql: string, vars?: Record<string, unknown>) => Promise<unknown>;
};

export type ClaimsPortalDeps = {
  getSession?: (workspaceDb: string) => Promise<ClaimsQueryable>;
  resolveWorkspace?: (slug: string) => Promise<{ dbName: string } | null>;
  getPepper?: () => string | null;
  getAttachmentConfig?: () => ReturnType<typeof getClaimsAttachmentConfig>;
  /** 注入存储实现；缺省按附件配置创建（CF API 或 S3）。 */
  createStorage?: (config: NonNullable<ReturnType<typeof getClaimsAttachmentConfig>>) => ClaimsAttachmentStorage;
  now?: () => number;
};

type TokenRow = {
  id?: unknown;
  roster_id?: unknown;
  token_hash?: unknown;
  status?: unknown;
  opened_at?: unknown;
  last_attempt_at?: unknown;
  failure_count?: unknown;
  locked_until?: unknown;
  created_by?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

type RosterRow = {
  id?: unknown;
  name?: unknown;
  identity_code?: unknown;
};

type SubmissionRow = {
  id?: unknown;
  roster_id?: unknown;
  identity_code?: unknown;
  principal?: unknown;
  rate_segments?: unknown;
  interest_start?: unknown;
  interest_end?: unknown;
  interest_method?: unknown;
  penalty?: unknown;
  statement?: unknown;
  status?: unknown;
  submitted_at?: unknown;
  manager_note?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

type AttachmentRow = {
  id?: unknown;
  submission_id?: unknown;
  attachment_type?: unknown;
  file_name?: unknown;
  content_type?: unknown;
  byte_size?: unknown;
  storage_key?: unknown;
  uploaded_at?: unknown;
  created_at?: unknown;
};

function idOf(value: unknown): string | null {
  return toStringRecordId(value)?.toString() ?? (typeof value === "string" ? value : null);
}

function firstRow<T>(result: unknown): T | null {
  if (!Array.isArray(result)) return null;
  const batch = result[0];
  if (Array.isArray(batch)) return (batch[0] as T | undefined) ?? null;
  if (batch && typeof batch === "object") return batch as T;
  return null;
}

function rowsOf<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  const batch = result[0];
  return Array.isArray(batch) ? (batch as T[]) : batch ? [batch as T] : [];
}

function requirePepper(getPepper: () => string | null): string {
  const pepper = getPepper();
  if (!pepper) {
    throw new HttpError(501, "claims-portal-not-configured", "CLAIMS_PORTAL_TOKEN_PEPPER is not configured");
  }
  return pepper;
}

function requireAttachmentConfig(getConfig: () => ReturnType<typeof getClaimsAttachmentConfig>) {
  const config = getConfig();
  if (!config) {
    throw new HttpError(
      501,
      "attachment-storage-not-configured",
      "CLAIMS_ATTACHMENT_* env keys are incomplete",
    );
  }
  return config;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function asDateMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") {
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function portalPath(slug: string, token: string): string {
  return `/claims/${encodeURIComponent(slug)}/${encodeURIComponent(token)}`;
}

export class ClaimsPortalService {
  private readonly getSession: (workspaceDb: string) => Promise<ClaimsQueryable>;
  private readonly resolveWorkspace: (slug: string) => Promise<{ dbName: string } | null>;
  private readonly getPepper: () => string | null;
  private readonly getAttachmentConfig: () => ReturnType<typeof getClaimsAttachmentConfig>;
  private readonly createStorage: (
    config: NonNullable<ReturnType<typeof getClaimsAttachmentConfig>>,
  ) => ClaimsAttachmentStorage;
  private readonly now: () => number;

  constructor(deps: ClaimsPortalDeps = {}) {
    this.getSession = deps.getSession ?? ((db) => getRootDatabaseSession(db) as Promise<ClaimsQueryable>);
    this.resolveWorkspace = deps.resolveWorkspace ?? resolveWorkspaceBySlug;
    this.getPepper = deps.getPepper ?? (() => getClaimsPortalPepper());
    this.getAttachmentConfig = deps.getAttachmentConfig ?? (() => getClaimsAttachmentConfig());
    this.createStorage = deps.createStorage ?? createAttachmentStorage;
    this.now = deps.now ?? (() => Date.now());
  }

  async resolveWorkspaceDb(slug: string): Promise<string> {
    const workspace = await this.resolveWorkspace(slug);
    if (!workspace?.dbName) {
      throw new HttpError(404, "workspace-not-found", "Workspace does not exist or is not active");
    }
    return workspace.dbName;
  }

  async mintToken(input: {
    workspaceDb: string;
    slug: string;
    rosterId: string;
    createdBy: string;
  }): Promise<{ tokenPlaintext: string; tokenId: string; portalPath: string; status: string }> {
    const pepper = requirePepper(this.getPepper);
    const rosterId = idOf(input.rosterId) ?? input.rosterId;
    if (!rosterId.startsWith("creditor_roster:")) {
      throw new HttpError(400, "claims-roster-id-invalid", "rosterId must be creditor_roster:…");
    }

    const db = await this.getSession(input.workspaceDb);
    const roster = firstRow<RosterRow>(
      await db.query("SELECT id, name, identity_code FROM $id;", {
        id: new StringRecordId(rosterId),
      }),
    );
    if (!roster?.id) {
      throw new HttpError(404, "claims-roster-not-found", "Creditor roster row not found");
    }

    // 同一名册仅保留一条 active：旧 active 置为 revoked。
    await db.query(
      `UPDATE claim_access_token SET status = "revoked", updated_at = time::now()
       WHERE roster_id = $roster AND status = "active";`,
      { roster: new StringRecordId(rosterId) },
    );

    const tokenPlaintext = generateToken();
    const tokenHash = hashToken(tokenPlaintext, pepper);
    const created = firstRow<TokenRow>(
      await db.query(
        `CREATE claim_access_token CONTENT {
          roster_id: $roster,
          token_hash: $tokenHash,
          status: "active",
          opened_at: NONE,
          last_attempt_at: NONE,
          failure_count: 0,
          locked_until: NONE,
          created_by: $createdBy,
          created_at: time::now(),
          updated_at: time::now()
        };`,
        {
          roster: new StringRecordId(rosterId),
          tokenHash,
          createdBy: input.createdBy,
        },
      ),
    );
    const tokenId = idOf(created?.id);
    if (!tokenId) {
      throw new HttpError(500, "claims-token-create-failed", "Failed to create access token");
    }

    return {
      tokenPlaintext,
      tokenId,
      portalPath: portalPath(input.slug, tokenPlaintext),
      status: "active",
    };
  }

  async listTokens(input: { workspaceDb: string }): Promise<Array<{
    id: string;
    rosterId: string;
    status: string;
    openedAt: string | null;
    failureCount: number;
    lockedUntil: string | null;
    createdBy: string | null;
    createdAt: string | null;
  }>> {
    requirePepper(this.getPepper);
    const db = await this.getSession(input.workspaceDb);
    const rows = rowsOf<TokenRow>(
      await db.query(
        `SELECT id, roster_id, status, opened_at, failure_count, locked_until, created_by, created_at
         FROM claim_access_token ORDER BY created_at DESC;`,
      ),
    );
    return rows.flatMap((row) => {
      const id = idOf(row.id);
      const rosterId = idOf(row.roster_id);
      if (!id || !rosterId) return [];
      return [{
        id,
        rosterId,
        status: typeof row.status === "string" ? row.status : "unknown",
        openedAt: asDateMs(row.opened_at) !== null ? toIso(asDateMs(row.opened_at)!) : null,
        failureCount: typeof row.failure_count === "number" ? row.failure_count : 0,
        lockedUntil: asDateMs(row.locked_until) !== null ? toIso(asDateMs(row.locked_until)!) : null,
        createdBy: typeof row.created_by === "string" ? row.created_by : null,
        createdAt: asDateMs(row.created_at) !== null ? toIso(asDateMs(row.created_at)!) : null,
      }];
    });
  }

  async openSession(input: {
    workspaceDb: string;
    slug: string;
    tokenPlaintext: string;
    name: string;
    identityCode: string;
  }): Promise<{ cookieValue: string; rosterId: string; tokenId: string; exp: number }> {
    const pepper = requirePepper(this.getPepper);
    const now = this.now();
    const db = await this.getSession(input.workspaceDb);
    const tokenHash = hashToken(input.tokenPlaintext, pepper);

    const token = firstRow<TokenRow>(
      await db.query(
        `SELECT id, roster_id, token_hash, status, opened_at, last_attempt_at, failure_count, locked_until
         FROM claim_access_token WHERE token_hash = $tokenHash LIMIT 1;`,
        { tokenHash },
      ),
    );

    if (!token?.id || token.status !== "active") {
      throw new HttpError(401, "claims-open-failed", OPEN_FAILURE_MESSAGE);
    }

    const lockedUntilMs = asDateMs(token.locked_until);
    if (lockedUntilMs !== null && lockedUntilMs > now) {
      throw new HttpError(429, "claims-token-locked", OPEN_FAILURE_MESSAGE, {
        lockedUntil: toIso(lockedUntilMs),
      });
    }

    const rosterId = idOf(token.roster_id);
    const tokenId = idOf(token.id);
    if (!rosterId || !tokenId) {
      throw new HttpError(401, "claims-open-failed", OPEN_FAILURE_MESSAGE);
    }

    const roster = firstRow<RosterRow>(
      await db.query("SELECT id, name, identity_code FROM $id;", {
        id: new StringRecordId(rosterId),
      }),
    );

    const nameOk = typeof roster?.name === "string" && roster.name.trim() === input.name.trim();
    const codeOk =
      typeof roster?.identity_code === "string"
      && roster.identity_code.trim() === input.identityCode.trim();

    if (!nameOk || !codeOk) {
      await this.recordFailedAttempt(db, token, now);
      throw new HttpError(401, "claims-open-failed", OPEN_FAILURE_MESSAGE);
    }

    await db.query(
      `UPDATE $id SET opened_at = IF opened_at = NONE THEN type::datetime($now) ELSE opened_at END,
        last_attempt_at = type::datetime($now),
        failure_count = 0,
        locked_until = NONE,
        updated_at = time::now();`,
      { id: new StringRecordId(tokenId), now: toIso(now) },
    );

    // 确保有申报草稿行（每名册一行）。
    const existing = firstRow<SubmissionRow>(
      await db.query(
        `SELECT id FROM claim_submission WHERE roster_id = $roster LIMIT 1;`,
        { roster: new StringRecordId(rosterId) },
      ),
    );
    if (!existing?.id) {
      await db.query(
        `CREATE claim_submission CONTENT {
          roster_id: $roster,
          identity_code: $identityCode,
          principal: NONE,
          rate_segments: NONE,
          interest_start: NONE,
          interest_end: NONE,
          interest_method: NONE,
          penalty: NONE,
          statement: NONE,
          status: "draft",
          submitted_at: NONE,
          manager_note: NONE,
          created_at: time::now(),
          updated_at: time::now()
        };`,
        {
          roster: new StringRecordId(rosterId),
          identityCode: typeof roster?.identity_code === "string" ? roster.identity_code : input.identityCode,
        },
      );
    }

    const exp = now + SESSION_TTL_MS;
    const cookieValue = encodeSessionCookie({
      slug: input.slug,
      tokenId,
      rosterId,
      exp,
      pepper,
    });
    return { cookieValue, rosterId, tokenId, exp };
  }

  /** 供限速单测直接推进失败计数。 */
  async recordFailedAttemptForTest(db: ClaimsQueryable, token: TokenRow, nowMs: number): Promise<void> {
    await this.recordFailedAttempt(db, token, nowMs);
  }

  private async recordFailedAttempt(db: ClaimsQueryable, token: TokenRow, nowMs: number): Promise<void> {
    const tokenId = idOf(token.id);
    if (!tokenId) return;

    const lastAttemptMs = asDateMs(token.last_attempt_at);
    const prevCount = typeof token.failure_count === "number" ? token.failure_count : 0;
    const inWindow = lastAttemptMs !== null && nowMs - lastAttemptMs <= FAIL_WINDOW_MS;
    const nextCount = inWindow ? prevCount + 1 : 1;
    const lockedUntil = nextCount >= FAIL_THRESHOLD ? toIso(nowMs + LOCK_MS) : null;

    await db.query(
      `UPDATE $id SET
        last_attempt_at = type::datetime($now),
        failure_count = $failureCount,
        locked_until = IF $lockedUntil = NONE THEN NONE ELSE type::datetime($lockedUntil) END,
        updated_at = time::now();`,
      {
        id: new StringRecordId(tokenId),
        now: toIso(nowMs),
        failureCount: nextCount,
        lockedUntil,
      },
    );
  }

  verifyPortalSession(input: {
    cookieRaw: string | undefined;
    slug: string;
    tokenPlaintext: string;
  }): { tokenId: string; rosterId: string } {
    const pepper = requirePepper(this.getPepper);
    if (!input.cookieRaw) {
      throw new HttpError(401, "claims-session-required", "Portal session cookie is required");
    }
    const session = decodeSessionCookie(input.cookieRaw, pepper);
    if (!session || session.exp <= this.now()) {
      throw new HttpError(401, "claims-session-invalid", "Portal session is invalid or expired");
    }
    if (session.slug !== input.slug) {
      throw new HttpError(401, "claims-session-mismatch", "Portal session does not match this link");
    }
    // cookie 存 tokenId；与 URL token 的一致性在 assertTokenMatchesSession 中校验。
    return { tokenId: session.tokenId, rosterId: session.rosterId };
  }

  async assertTokenMatchesSession(input: {
    workspaceDb: string;
    tokenPlaintext: string;
    tokenId: string;
    rosterId: string;
  }): Promise<void> {
    const pepper = requirePepper(this.getPepper);
    const db = await this.getSession(input.workspaceDb);
    const token = firstRow<TokenRow>(
      await db.query(
        `SELECT id, roster_id, token_hash, status FROM $id;`,
        { id: new StringRecordId(input.tokenId) },
      ),
    );
    const tokenHash = hashToken(input.tokenPlaintext, pepper);
    if (
      !token
      || token.status !== "active"
      || idOf(token.id) !== input.tokenId
      || idOf(token.roster_id) !== input.rosterId
      || token.token_hash !== tokenHash
    ) {
      throw new HttpError(401, "claims-session-mismatch", "Portal session does not match this link");
    }
  }

  async getSubmission(input: {
    workspaceDb: string;
    rosterId: string;
  }): Promise<{
    submission: Record<string, unknown> | null;
    attachments: Array<Record<string, unknown>>;
  }> {
    const db = await this.getSession(input.workspaceDb);
    const submission = firstRow<SubmissionRow>(
      await db.query(
        `SELECT * FROM claim_submission WHERE roster_id = $roster LIMIT 1;`,
        { roster: new StringRecordId(input.rosterId) },
      ),
    );
    if (!submission?.id) {
      return { submission: null, attachments: [] };
    }
    const submissionId = idOf(submission.id)!;
    const attachments = rowsOf<AttachmentRow>(
      await db.query(
        `SELECT id, submission_id, attachment_type, file_name, content_type, byte_size, storage_key, uploaded_at, created_at
         FROM claim_attachment WHERE submission_id = $submission;`,
        { submission: new StringRecordId(submissionId) },
      ),
    );
    return {
      submission: this.serializeSubmission(submission),
      attachments: attachments.map((row) => this.serializeAttachment(row)),
    };
  }

  async saveDraft(input: {
    workspaceDb: string;
    rosterId: string;
    draft: SubmissionDraftInput;
  }): Promise<Record<string, unknown>> {
    const normalized = normalizeDraft(input.draft);
    const db = await this.getSession(input.workspaceDb);
    const existing = firstRow<SubmissionRow>(
      await db.query(
        `SELECT id, status FROM claim_submission WHERE roster_id = $roster LIMIT 1;`,
        { roster: new StringRecordId(input.rosterId) },
      ),
    );
    if (!existing?.id) {
      throw new HttpError(404, "claims-submission-not-found", "Submission draft not found");
    }
    if (existing.status === "submitted" || existing.status === "closed") {
      throw new HttpError(409, "claims-submission-locked", "Submitted claims cannot be edited as draft");
    }

    const updated = firstRow<SubmissionRow>(
      await db.query(
        `UPDATE $id SET
          principal = $principal,
          rate_segments = $rateSegments,
          interest_start = IF $interestStart = NONE THEN NONE ELSE type::datetime($interestStart) END,
          interest_end = IF $interestEnd = NONE THEN NONE ELSE type::datetime($interestEnd) END,
          interest_method = $interestMethod,
          penalty = $penalty,
          statement = $statement,
          status = "draft",
          updated_at = time::now()
        RETURN AFTER;`,
        {
          id: new StringRecordId(idOf(existing.id)!),
          principal: normalized.principal,
          rateSegments: normalized.rate_segments,
          interestStart: normalized.interest_start,
          interestEnd: normalized.interest_end,
          interestMethod: normalized.interest_method,
          penalty: normalized.penalty,
          statement: normalized.statement,
        },
      ),
    );
    if (!updated) {
      throw new HttpError(500, "claims-draft-save-failed", "Failed to save draft");
    }
    return this.serializeSubmission(updated);
  }

  async submit(input: {
    workspaceDb: string;
    rosterId: string;
  }): Promise<Record<string, unknown>> {
    const db = await this.getSession(input.workspaceDb);
    const existing = firstRow<SubmissionRow>(
      await db.query(
        `SELECT * FROM claim_submission WHERE roster_id = $roster LIMIT 1;`,
        { roster: new StringRecordId(input.rosterId) },
      ),
    );
    if (!existing?.id) {
      throw new HttpError(404, "claims-submission-not-found", "Submission not found");
    }
    if (typeof existing.principal !== "number") {
      throw new HttpError(400, "claims-submit-incomplete", "principal is required before submit");
    }
    const submissionId = idOf(existing.id)!;
    const attachments = rowsOf<AttachmentRow>(
      await db.query(
        `SELECT id FROM claim_attachment WHERE submission_id = $submission;`,
        { submission: new StringRecordId(submissionId) },
      ),
    );
    if (attachments.length < 1) {
      throw new HttpError(400, "claims-submit-needs-attachment", "At least one attachment is required");
    }

    const updated = firstRow<SubmissionRow>(
      await db.query(
        `UPDATE $id SET
          status = "submitted",
          submitted_at = IF submitted_at = NONE THEN time::now() ELSE submitted_at END,
          updated_at = time::now()
        RETURN AFTER;`,
        { id: new StringRecordId(submissionId) },
      ),
    );
    if (!updated) {
      throw new HttpError(500, "claims-submit-failed", "Failed to submit claim");
    }
    return this.serializeSubmission(updated);
  }

  /**
   * 仅写附件元数据（测试 / 无字节路径）。生产上传走 uploadBytes。
   */
  async registerAttachmentMetadata(input: {
    workspaceDb: string;
    rosterId: string;
    attachmentType: unknown;
    fileName: unknown;
    contentType: unknown;
    byteSize: unknown;
    /** 若提供 storageKey 则写入；否则生成占位键（仅元数据骨架）。 */
    storageKey?: string;
    /** 设为 true 时跳过「必须有附件存储配置」检查（仅单测元数据路径）。 */
    allowWithoutStorageConfig?: boolean;
  }): Promise<Record<string, unknown>> {
    if (!input.allowWithoutStorageConfig) {
      requireAttachmentConfig(this.getAttachmentConfig);
    }
    const meta = assertAttachmentMeta({
      attachmentType: input.attachmentType,
      fileName: input.fileName,
      contentType: input.contentType,
      byteSize: input.byteSize,
    });
    const db = await this.getSession(input.workspaceDb);
    const submission = firstRow<SubmissionRow>(
      await db.query(
        `SELECT id, status FROM claim_submission WHERE roster_id = $roster LIMIT 1;`,
        { roster: new StringRecordId(input.rosterId) },
      ),
    );
    if (!submission?.id) {
      throw new HttpError(404, "claims-submission-not-found", "Submission not found");
    }
    if (submission.status === "closed") {
      throw new HttpError(409, "claims-submission-locked", "Closed submissions cannot accept attachments");
    }
    const submissionId = idOf(submission.id)!;
    const storageKey =
      input.storageKey
      ?? `claims/${input.workspaceDb}/${submissionId}/pending/${encodeURIComponent(meta.fileName)}`;
    const nowIso = toIso(this.now());
    const created = firstRow<AttachmentRow>(
      await db.query(
        `CREATE claim_attachment CONTENT {
          submission_id: $submission,
          attachment_type: $attachmentType,
          file_name: $fileName,
          content_type: $contentType,
          byte_size: $byteSize,
          storage_key: $storageKey,
          uploaded_at: type::datetime($uploadedAt),
          created_at: time::now()
        };`,
        {
          submission: new StringRecordId(submissionId),
          attachmentType: meta.attachmentType,
          fileName: meta.fileName,
          contentType: meta.contentType,
          byteSize: meta.byteSize,
          storageKey,
          uploadedAt: nowIso,
        },
      ),
    );
    if (!created?.id) {
      throw new HttpError(500, "claims-attachment-create-failed", "Failed to register attachment metadata");
    }
    return this.serializeAttachment(created);
  }

  /** 附件存储配置门：路由在解析请求体之前调用，缺配置即 fail-closed。 */
  assertAttachmentStorageConfigured(): void {
    requireAttachmentConfig(this.getAttachmentConfig);
  }

  /**
   * 上传附件字节到 R2，并写入 claim_attachment 元数据。
   * 缺配置 → 501；无字节 → 400；对象键 claims/{ws}/{submission}/{attachmentId}/{file}。
   */
  async uploadBytes(input: {
    workspaceDb: string;
    rosterId: string;
    attachmentType: unknown;
    fileName: unknown;
    contentType: unknown;
    byteSize: unknown;
    bytes?: Uint8Array;
  }): Promise<Record<string, unknown>> {
    const config = requireAttachmentConfig(this.getAttachmentConfig);
    const meta = assertAttachmentMeta({
      attachmentType: input.attachmentType,
      fileName: input.fileName,
      contentType: input.contentType,
      byteSize: input.byteSize,
    });
    if (!input.bytes || input.bytes.byteLength === 0) {
      throw new HttpError(400, "attachment-bytes-required", "Attachment bytes are required");
    }
    if (input.bytes.byteLength !== meta.byteSize) {
      throw new HttpError(400, "claims-attachment-size-mismatch", "byte_size does not match uploaded bytes");
    }

    const db = await this.getSession(input.workspaceDb);
    const submission = firstRow<SubmissionRow>(
      await db.query(
        `SELECT id, status FROM claim_submission WHERE roster_id = $roster LIMIT 1;`,
        { roster: new StringRecordId(input.rosterId) },
      ),
    );
    if (!submission?.id) {
      throw new HttpError(404, "claims-submission-not-found", "Submission not found");
    }
    if (submission.status === "closed") {
      throw new HttpError(409, "claims-submission-locked", "Closed submissions cannot accept attachments");
    }
    const submissionId = idOf(submission.id)!;
    const attachmentId = crypto.randomUUID();
    const storageKey = buildClaimsAttachmentKey({
      workspaceDb: input.workspaceDb,
      submissionId,
      attachmentId,
      fileName: meta.fileName,
    });

    const storage = this.createStorage(config);
    await storage.putObject({
      key: storageKey,
      bytes: input.bytes,
      contentType: meta.contentType,
    });

    const nowIso = toIso(this.now());
    const created = firstRow<AttachmentRow>(
      await db.query(
        `CREATE claim_attachment CONTENT {
          submission_id: $submission,
          attachment_type: $attachmentType,
          file_name: $fileName,
          content_type: $contentType,
          byte_size: $byteSize,
          storage_key: $storageKey,
          uploaded_at: type::datetime($uploadedAt),
          created_at: time::now()
        };`,
        {
          submission: new StringRecordId(submissionId),
          attachmentType: meta.attachmentType,
          fileName: meta.fileName,
          contentType: meta.contentType,
          byteSize: meta.byteSize,
          storageKey,
          uploadedAt: nowIso,
        },
      ),
    );
    if (!created?.id) {
      throw new HttpError(500, "claims-attachment-create-failed", "Failed to register attachment metadata");
    }
    return this.serializeAttachment(created);
  }

  async managerListSubmissions(input: { workspaceDb: string }): Promise<Array<Record<string, unknown>>> {
    requirePepper(this.getPepper);
    const db = await this.getSession(input.workspaceDb);
    const rows = rowsOf<SubmissionRow>(
      await db.query(`SELECT * FROM claim_submission ORDER BY updated_at DESC;`),
    );
    return rows.map((row) => this.serializeSubmission(row));
  }

  /**
   * 管理人受控下载：经 Hono 代理读对象字节（非永久公开 URL）。
   */
  async managerDownload(input: {
    workspaceDb: string;
    attachmentId: string;
  }): Promise<{
    body: Uint8Array;
    contentType: string;
    fileName: string;
    byteSize: number;
  }> {
    const config = requireAttachmentConfig(this.getAttachmentConfig);
    const db = await this.getSession(input.workspaceDb);
    const row = firstRow<AttachmentRow>(
      await db.query(
        `SELECT id, submission_id, attachment_type, file_name, content_type, byte_size, storage_key, uploaded_at, created_at
         FROM $id;`,
        { id: new StringRecordId(input.attachmentId) },
      ),
    );
    if (!row?.id || typeof row.storage_key !== "string" || row.storage_key.length === 0) {
      throw new HttpError(404, "claims-attachment-not-found", "Attachment not found");
    }
    // 对象键必须属于本 workspace，防止跨库串读。
    const expectedPrefix = `claims/${input.workspaceDb}/`;
    if (!row.storage_key.startsWith(expectedPrefix)) {
      throw new HttpError(403, "claims-attachment-workspace-mismatch", "Attachment does not belong to this workspace");
    }

    const storage = this.createStorage(config);
    const object = await storage.getObject(row.storage_key);
    const fileName = typeof row.file_name === "string" && row.file_name.length > 0
      ? row.file_name
      : "attachment";
    return {
      body: object.body,
      contentType: typeof row.content_type === "string" && row.content_type.length > 0
        ? row.content_type
        : object.contentType,
      fileName,
      byteSize: object.contentLength,
    };
  }

  /** @deprecated 使用 managerDownload；保留别名兼容旧调用。 */
  async managerPresignedDownload(input: {
    workspaceDb: string;
    attachmentId: string;
  }): Promise<{
    body: Uint8Array;
    contentType: string;
    fileName: string;
    byteSize: number;
  }> {
    return this.managerDownload(input);
  }

  private serializeSubmission(row: SubmissionRow): Record<string, unknown> {
    return {
      id: idOf(row.id),
      rosterId: idOf(row.roster_id),
      identityCode: typeof row.identity_code === "string" ? row.identity_code : null,
      principal: typeof row.principal === "number" ? row.principal : null,
      rateSegments: Array.isArray(row.rate_segments) ? row.rate_segments : null,
      interestStart: asDateMs(row.interest_start) !== null ? toIso(asDateMs(row.interest_start)!) : null,
      interestEnd: asDateMs(row.interest_end) !== null ? toIso(asDateMs(row.interest_end)!) : null,
      interestMethod: typeof row.interest_method === "string" ? row.interest_method : null,
      penalty: typeof row.penalty === "number" ? row.penalty : null,
      statement: typeof row.statement === "string" ? row.statement : null,
      status: typeof row.status === "string" ? row.status : null,
      submittedAt: asDateMs(row.submitted_at) !== null ? toIso(asDateMs(row.submitted_at)!) : null,
      managerNote: typeof row.manager_note === "string" ? row.manager_note : null,
      createdAt: asDateMs(row.created_at) !== null ? toIso(asDateMs(row.created_at)!) : null,
      updatedAt: asDateMs(row.updated_at) !== null ? toIso(asDateMs(row.updated_at)!) : null,
    };
  }

  private serializeAttachment(row: AttachmentRow): Record<string, unknown> {
    return {
      id: idOf(row.id),
      submissionId: idOf(row.submission_id),
      attachmentType: typeof row.attachment_type === "string" ? row.attachment_type : null,
      fileName: typeof row.file_name === "string" ? row.file_name : null,
      contentType: typeof row.content_type === "string" ? row.content_type : null,
      byteSize: typeof row.byte_size === "number" ? row.byte_size : null,
      storageKey: typeof row.storage_key === "string" ? row.storage_key : null,
      uploadedAt: asDateMs(row.uploaded_at) !== null ? toIso(asDateMs(row.uploaded_at)!) : null,
      createdAt: asDateMs(row.created_at) !== null ? toIso(asDateMs(row.created_at)!) : null,
    };
  }
}

export { FAIL_THRESHOLD, FAIL_WINDOW_MS, LOCK_MS, OPEN_FAILURE_MESSAGE, MAX_ATTACHMENT_BYTES } from "./constants";
