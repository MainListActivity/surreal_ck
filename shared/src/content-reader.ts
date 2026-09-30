import { z } from "zod";
import { AI_TEMPLATE_ACTIONS, CONTENT_ACTIONS } from "./product-entitlement";

/** 与 platform-content `PublicIdSchema` 同一规则；该 schema 当前未导出。 */
const contentPublicIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !/\s/u.test(value), "公开 ID 不能包含空白字符")
  .refine((value) => !/^[A-Za-z_][A-Za-z0-9_]*:[^:]+$/u.test(value), "公开 ID 不能暴露数据库 RecordId 语法");

/**
 * SCK-LCA-03 任务 A 冻结的内容读取契约（content_reader.v1）。
 * 只声明 B/C 共同消费的字段、错误和时间上限，不签发凭证，也不读内容库。
 * 900 秒是凭证、lease、数据库会话和投影确认的共同上限，不是无限期授权。
 */
export const CONTENT_READER_CONTRACT_ID = "content_reader.v1" as const;

export const CONTENT_READER_ACCESS = "content_reader" as const;

export const CONTENT_PROJECTION_SYNC_ACCESS = "content_projection_sync" as const;

export const CONTENT_AUTHORIZATION_PROJECTION_TABLE = "content_authorization_projection" as const;

/** 当前 platform_content 迁移止于 005。B 只能追加 006，不能改已发布脚本。 */
export const CONTENT_READER_SCHEMA_BASELINE_VERSION = 5 as const;

/** 与 IdP `DEFAULT_CONTENT_READER_MAX_TTL_SECONDS`、publisher `15m` 对齐。 */
export const CONTENT_READER_BOUND_SECONDS = 900 as const;

export const CONTENT_READER_DB_TOKEN_DURATION = "15m" as const;

export const CONTENT_READER_DB_SESSION_DURATION = "15m" as const;

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type ContentAction = (typeof CONTENT_ACTIONS)[number];

export type AiReaderAction = (typeof AI_TEMPLATE_ACTIONS)[number];

export const IDP_CONTENT_READER_ERRORS = [
  "invalid_client",
  "invalid_grant",
  "invalid_scope",
  "invalid_lifetime",
  "invalid_request",
  "temporarily_unavailable",
] as const;

export type IdpContentReaderError = (typeof IDP_CONTENT_READER_ERRORS)[number];

export const CONTENT_READER_ERRORS = [
  "not_member",
  "member_removed",
  "workspace_inactive",
  "entitlement_absent",
  "entitlement_expired",
  "digest_mismatch",
  "revision_invalid",
  "revision_not_current",
  "client_authority_rejected",
  "lease_exceeds_validity",
  "invalid_lifetime",
  "license_unknown",
  "license_expired",
  "content_not_published",
  "content_withdrawn",
  "collection_denied",
  "action_denied",
  "metadata_only",
  "projection_incomplete",
  "projection_stale",
  "projection_closed",
  "idp_rejected",
] as const;

export type ContentReaderError = (typeof CONTENT_READER_ERRORS)[number];

export const contentReaderExchangeRequestSchema = z.object({
  contentPublicId: contentPublicIdSchema,
}).strict();

export type ContentReaderExchangeRequest = z.infer<typeof contentReaderExchangeRequestSchema>;

/** 浏览器不得提交这些字段；出现则 `client_authority_rejected`。 */
export const CLIENT_AUTHORITY_FIELDS = [
  "workspaceId",
  "workspace_id",
  "entitlementRevision",
  "entitlement_revision",
  "digest",
  "leaseEnd",
  "lease_end",
  "ac",
  "db",
  "subject",
] as const;

export type ContentReaderExchangeSuccess = {
  contractId: typeof CONTENT_READER_CONTRACT_ID;
  tokenType: "Bearer";
  accessToken: string;
  expiresInSeconds: number;
  namespace: string;
  database: string;
  workspaceId: string;
  entitlementRevision: string;
  digest: string;
  leaseEndSeconds: number;
  contentPublicId: string;
};

/** Search does not accept a client-chosen content pointer or authority fields. */
export type ContentSearchExchangeSuccess =
  | { status: "empty" }
  | (Omit<ContentReaderExchangeSuccess, "contentPublicId"> & { status: "ready" });

export type ContentReaderFailure = {
  ok: false;
  error: ContentReaderError;
  idpError?: IdpContentReaderError;
};

export type ContentExchangeErrorPrefix = "content-reader-" | "content-search-";

/**
 * 服务端统一错误信封 `{ error: { code: "<prefix><reason>", details? } }` → `ContentReaderFailure`。
 * 只认前缀内、且在 CONTENT_READER_ERRORS 里的 code；其余（oidc-*、internal、未知码）返回 null，
 * 由调用方落到自身兜底，避免把无关错误误映射成领域原因。
 */
export function contentExchangeFailure(
  payload: unknown,
  prefix: ContentExchangeErrorPrefix,
): ContentReaderFailure | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !code.startsWith(prefix)) return null;
  const reason = code.slice(prefix.length) as ContentReaderError;
  if (!(CONTENT_READER_ERRORS as readonly string[]).includes(reason)) return null;
  const details = (error as { details?: unknown }).details;
  const idpError = details && typeof details === "object"
    ? (details as { idpError?: unknown }).idpError
    : undefined;
  return {
    ok: false,
    error: reason,
    ...(typeof idpError === "string"
    && (IDP_CONTENT_READER_ERRORS as readonly string[]).includes(idpError)
      ? { idpError: idpError as IdpContentReaderError }
      : {}),
  };
}

export type ContentReaderPermissions = {
  /** browse 或 search 授予元数据，不由其他动作隐式授予。 */
  metadata: boolean;
  search: boolean;
  read: boolean;
  cite: boolean;
  export: boolean;
  aiUse: boolean;
  /** 只有 browse/search，没有 read、cite、export、AI。 */
  metadataOnly: boolean;
};

export type ContentReaderFieldClass = "metadata" | "body" | "excerpt" | "article" | "hidden";

function integerSeconds(value: number): boolean {
  return Number.isInteger(value);
}

export function formatEntitlementRevision(
  revision: number,
): { ok: true; entitlementRevision: string } | { ok: false; error: "revision_invalid" } {
  if (!integerSeconds(revision) || revision <= 0) return { ok: false, error: "revision_invalid" };
  const entitlementRevision = String(revision);
  if (!IDENTITY_PATTERN.test(entitlementRevision)) return { ok: false, error: "revision_invalid" };
  return { ok: true, entitlementRevision };
}

export function isContentReaderIdentity(value: string): boolean {
  return IDENTITY_PATTERN.test(value);
}

/**
 * lease_end = min(now+900, subject 到期, 权益到期（若有）, 当前内容许可到期（若有）)。
 * 到期时间为空只表示快照未写截止点，仍然受 900 秒上限约束。
 */
export function contentReaderLeaseEnd(input: {
  nowSeconds: number;
  subjectExpiresAtSeconds: number;
  entitlementEffectiveUntilSeconds: number | null;
  licenseEffectiveUntilSeconds: number | null;
}): { ok: true; leaseEndSeconds: number } | { ok: false; error: "invalid_lifetime" | "lease_exceeds_validity" } {
  const { nowSeconds, subjectExpiresAtSeconds, entitlementEffectiveUntilSeconds, licenseEffectiveUntilSeconds } = input;
  if (!integerSeconds(nowSeconds) || !integerSeconds(subjectExpiresAtSeconds)) {
    return { ok: false, error: "invalid_lifetime" };
  }
  if (entitlementEffectiveUntilSeconds !== null && !integerSeconds(entitlementEffectiveUntilSeconds)) {
    return { ok: false, error: "invalid_lifetime" };
  }
  if (licenseEffectiveUntilSeconds !== null && !integerSeconds(licenseEffectiveUntilSeconds)) {
    return { ok: false, error: "invalid_lifetime" };
  }
  if (subjectExpiresAtSeconds <= nowSeconds) return { ok: false, error: "invalid_lifetime" };
  if (entitlementEffectiveUntilSeconds !== null && entitlementEffectiveUntilSeconds <= nowSeconds) {
    return { ok: false, error: "lease_exceeds_validity" };
  }
  if (licenseEffectiveUntilSeconds !== null && licenseEffectiveUntilSeconds <= nowSeconds) {
    return { ok: false, error: "lease_exceeds_validity" };
  }
  const caps = [nowSeconds + CONTENT_READER_BOUND_SECONDS, subjectExpiresAtSeconds];
  if (entitlementEffectiveUntilSeconds !== null) caps.push(entitlementEffectiveUntilSeconds);
  if (licenseEffectiveUntilSeconds !== null) caps.push(licenseEffectiveUntilSeconds);
  const leaseEndSeconds = Math.min(...caps);
  if (!integerSeconds(leaseEndSeconds) || leaseEndSeconds <= nowSeconds) {
    return { ok: false, error: "invalid_lifetime" };
  }
  return { ok: true, leaseEndSeconds };
}

/**
 * 撤权写失败时，新读取仍须在此剩余秒数内关闭。
 * 任一截止点超过 now + 900 秒返回 null（无效契约，调用方必须拒绝读取）。
 * 三个时间戳各自不得晚于其起点 + 900 秒；客户读取不得延后其中任何一个。
 */
export function remainingContentReaderCloseSeconds(input: {
  nowSeconds: number;
  tokenExpiresAtSeconds: number;
  sessionExpiresAtSeconds: number;
  projectionConfirmedUntilSeconds: number;
}): number | null {
  const values = [
    input.nowSeconds,
    input.tokenExpiresAtSeconds,
    input.sessionExpiresAtSeconds,
    input.projectionConfirmedUntilSeconds,
  ];
  if (values.some((value) => !integerSeconds(value))) return null;
  if (values.slice(1).some((value) => value - input.nowSeconds > CONTENT_READER_BOUND_SECONDS)) return null;
  const deadline = Math.min(
    input.tokenExpiresAtSeconds,
    input.sessionExpiresAtSeconds,
    input.projectionConfirmedUntilSeconds,
  );
  return Math.max(0, deadline - input.nowSeconds);
}

function knownActions(values: readonly string[], allowed: readonly string[]): boolean {
  return values.every((value) => allowed.includes(value));
}

export function contentReaderPermissions(input: {
  contentActions: readonly string[];
  aiActions: readonly string[];
}): { ok: true; permissions: ContentReaderPermissions } | { ok: false; error: "projection_incomplete" } {
  if (!knownActions(input.contentActions, CONTENT_ACTIONS) || !knownActions(input.aiActions, AI_TEMPLATE_ACTIONS)) {
    return { ok: false, error: "projection_incomplete" };
  }
  const read = input.contentActions.includes("read");
  const cite = input.contentActions.includes("cite");
  const search = input.contentActions.includes("search");
  const exportAllowed = input.contentActions.includes("export");
  const aiUse = input.aiActions.some((action) => action === "research" || action === "generate");
  const metadata = input.contentActions.includes("browse") || search;
  const metadataOnly = metadata
    && !read
    && !cite
    && !input.contentActions.includes("export")
    && !aiUse;
  return {
    ok: true,
    permissions: { metadata, search, read, cite, export: exportAllowed, aiUse, metadataOnly },
  };
}

export function contentReaderFieldAllowed(
  fieldClass: ContentReaderFieldClass,
  permissions: ContentReaderPermissions,
): boolean {
  if (fieldClass === "hidden") return false;
  if (fieldClass === "metadata") {
    return permissions.metadata;
  }
  if (fieldClass === "body" || fieldClass === "article") return permissions.read;
  if (fieldClass === "excerpt") return permissions.cite;
  return false;
}
