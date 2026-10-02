import {
  IDP_CONTENT_READER_ERRORS,
  contentReaderExchangeRequestSchema,
  type ContentReaderExchangeSuccess,
  type ContentReaderFailure,
  type IdpContentReaderError,
  type SessionUser,
} from "@surreal-ck/shared";
import { env } from "../env";
import { evaluateCapabilitySwitch, type CapabilitySwitchDecision } from "../capability/switch";
import { getRootDatabaseSession } from "../db/root-connection";
import { HttpError } from "../http-error";
import { SurrealProductEntitlementStore } from "../product-entitlement/store";
import { createIdpContentReaderScopeAdapter, type IdpContentReaderScopeAdapter } from "../workspaces/idp-scope-adapter";
import { exchangeContentReader, type ContentReaderEntitlement } from "./reader-exchange";
import { fetchContentReaderTarget, writeContentReaderProjection } from "./reader-projection";
import { getContentProjectionSession, type ContentProjectionClient } from "./reader-session";

type Queryable = { query(sql: string, params?: Record<string, unknown>): Promise<unknown> };

type Row = Record<string, unknown>;

export type ContentReaderExchangeDeps = {
  /** `_system` 控制面查询（成员索引、权益快照所在库）。 */
  getSystemDb?: () => Promise<Queryable>;
  /** 指定 workspace 数据库的会话（成员 user 表核验）。 */
  getWorkspaceDb?: (database: string) => Promise<Queryable>;
  /** 内容库受限控制面会话（事实读取与投影写入）。 */
  getContentDb?: () => Promise<ContentProjectionClient>;
  entitlementStore?: Pick<SurrealProductEntitlementStore, "currentSnapshot">;
  idpContentReader?: IdpContentReaderScopeAdapter;
  /** 内容库名（默认 env.CONTENT_DATABASE）。 */
  database?: string;
  namespace?: string;
  nowSeconds?: () => number;
};

const rows = (value: unknown): Row[] => (Array.isArray(value) && Array.isArray(value[0]) ? (value[0] as Row[]) : []);

type WorkspaceIndexRow = {
  subject?: unknown;
  disabled_at?: unknown;
  workspace?: { id?: unknown; status?: unknown } | unknown;
};

function toContentReaderEntitlement(snapshot: {
  revision: number;
  digest: string;
  resolverVersion: string;
  effectiveUntil: string | null;
  collections: readonly { key: string }[];
  actions: readonly string[];
  aiActions: readonly string[];
}): ContentReaderEntitlement {
  const until = snapshot.effectiveUntil === null ? null : Date.parse(snapshot.effectiveUntil);
  return {
    revision: snapshot.revision,
    digest: snapshot.digest,
    resolverVersion: snapshot.resolverVersion,
    effectiveUntilSeconds: until === null || Number.isNaN(until) ? null : Math.floor(until / 1000),
    collections: snapshot.collections.map((item) => item.key),
    contentActions: [...snapshot.actions],
    aiActions: [...snapshot.aiActions],
  };
}

function toIdpError(value: string): IdpContentReaderError {
  return (IDP_CONTENT_READER_ERRORS as readonly string[]).includes(value)
    ? (value as IdpContentReaderError)
    : "temporarily_unavailable";
}

/**
 * POST /api/session/content-reader 的真实实现：
 * _system 成员索引与工作区状态 → 权益快照 → 内容库事实（受限同步会话）→
 * 计划校验 → IdP content_reader 换票 → 受限会话 UPSERT 投影与门禁。
 * 未接线依赖抛 503；事实缺失一律按契约错误 fail closed。
 */
export function createContentReaderExchangeHandler(deps: ContentReaderExchangeDeps = {}) {
  const ns = deps.namespace ?? env.SURREAL_NS;
  const getSystemDb = deps.getSystemDb ?? (() => getRootDatabaseSession("_system", ns));
  const getWorkspaceDb = deps.getWorkspaceDb ?? ((database: string) => getRootDatabaseSession(database, ns));
  const getContentDb = deps.getContentDb ?? (() => getContentProjectionSession());
  const entitlementStore = deps.entitlementStore ?? new SurrealProductEntitlementStore();
  const idp = deps.idpContentReader ?? createIdpContentReaderScopeAdapter();
  const database = deps.database ?? env.CONTENT_DATABASE;
  const namespace = ns;
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  return async (caller: SessionUser, body: unknown): Promise<ContentReaderExchangeSuccess | ContentReaderFailure> => {
    const raw = caller.raw ?? {};
    const workspaceDb = typeof raw.db === "string" ? raw.db : "";
    const subjectExpiresAtSeconds = typeof raw.exp === "number" && Number.isFinite(raw.exp) ? Math.floor(raw.exp) : 0;

    let systemDb: Queryable;
    let contentDb: ContentProjectionClient;
    try {
      [systemDb, contentDb] = await Promise.all([getSystemDb(), getContentDb()]);
    } catch {
      throw new HttpError(503, "content-reader-unavailable", "内容读取控制面暂不可用");
    }

    // LCA-14：内容能力灰度开关——off / 未入 cohort 白名单时拒绝签发新会话
    // （已有会话与成果不受影响）。开关读失败按不可用 fail closed。
    if (workspaceDb) {
      let decision: CapabilitySwitchDecision;
      try {
        decision = await evaluateCapabilitySwitch(systemDb, "content", workspaceDb);
      } catch {
        throw new HttpError(503, "content-reader-unavailable", "能力开关状态暂不可读");
      }
      if (!decision.allowed) return { ok: false, error: "capability_disabled" };
    }

    let indexRows: WorkspaceIndexRow[];
    try {
      indexRows = rows(await systemDb.query(
        `SELECT subject, disabled_at, workspace FROM user_workspace_index WHERE db_name = $db FETCH workspace;`,
        { db: workspaceDb },
      )) as WorkspaceIndexRow[];
    } catch {
      throw new HttpError(503, "content-reader-unavailable", "成员与工作区事实暂不可读");
    }

    const callerRow = indexRows.find((row) => row.subject === caller.subject);
    const workspace = (callerRow?.workspace ?? indexRows[0]?.workspace) as
      | { id?: unknown; status?: unknown }
      | undefined;
    let membership: "active" | "removed" | "absent" =
      !callerRow ? "absent" : callerRow.disabled_at == null ? "active" : "removed";
    if (membership === "active" && workspaceDb) {
      try {
        const workspaceDbSession = await getWorkspaceDb(workspaceDb);
        const userRows = rows(await workspaceDbSession.query(
          `SELECT id, disabled_at FROM user WHERE kind = "human"
            AND (subject = $subject OR (subject = NONE AND email = $email));`,
          { subject: caller.subject, ...(caller.email ? { email: caller.email } : {}) },
        ));
        if (!userRows.some((row) => row.disabled_at == null)) membership = "removed";
      } catch {
        throw new HttpError(503, "content-reader-unavailable", "成员与工作区事实暂不可读");
      }
    }
    const workspaceActive = workspace?.status === "active";
    const workspaceRecordId = workspace?.id == null ? null : String(workspace.id);
    const activeSubjects = indexRows.flatMap((row) =>
      row.disabled_at == null && typeof row.subject === "string" ? [row.subject] : []);

    let entitlement: ContentReaderEntitlement | null = null;
    let content: Awaited<ReturnType<typeof fetchContentReaderTarget>> = null;
    try {
      if (membership === "active" && workspaceActive && workspaceRecordId) {
        const snapshot = await entitlementStore.currentSnapshot(workspaceRecordId);
        if (snapshot) entitlement = toContentReaderEntitlement(snapshot);
      }
      const parsedBody = contentReaderExchangeRequestSchema.safeParse(body);
      if (parsedBody.success) {
        content = await fetchContentReaderTarget(contentDb, parsedBody.data.contentPublicId);
      }
    } catch {
      throw new HttpError(503, "content-reader-unavailable", "权益或内容事实暂不可读");
    }

    try {
      return await exchangeContentReader({
      body,
      subject: caller.subject,
      workspaceDb,
      workspaceActive,
      membership,
      activeSubjects,
      subjectExpiresAtSeconds,
      nowSeconds: nowSeconds(),
      subjectIsContentReader: raw.ac === "content_reader",
      database,
      namespace,
      entitlement,
      content,
      subjectToken: caller.rawToken,
      exchangeIdp: async (request) => {
        try {
          const issued = await idp.exchangeContentReaderScope({
            subjectToken: request.subjectToken,
            database: request.database,
            workspaceId: request.workspaceId,
            entitlementRevision: request.entitlementRevision,
            leaseEndSeconds: request.leaseEndSeconds,
          });
          if ("error" in issued) return { error: toIdpError(issued.error) };
          if (issued.expiresIn === null) return { error: "invalid_lifetime" };
          return { accessToken: issued.accessToken, expiresInSeconds: issued.expiresIn };
        } catch {
          return { error: "temporarily_unavailable" };
        }
      },
      writeProjection: (write) => writeContentReaderProjection(contentDb, write),
    });
    } catch {
      return { ok: false, error: "projection_incomplete" };
    }
  };
}
