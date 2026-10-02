import {
  contentReaderPermissions,
  type ContentReaderFailure,
  type ContentSearchExchangeSuccess,
  type SessionUser,
} from "@surreal-ck/shared";
import { env } from "../env";
import { getRootDatabaseSession } from "../db/root-connection";
import { HttpError } from "../http-error";
import { SurrealProductEntitlementStore } from "../product-entitlement/store";
import { createRolloutGateChecker, type RolloutGateChecker } from "../rollout/gate-check";
import { createIdpContentReaderScopeAdapter } from "../workspaces/idp-scope-adapter";
import { planContentReaderExchange, type ContentReaderEntitlement, type PlannedContentReaderExchange } from "./reader-exchange";
import { fetchContentReaderTarget, writeContentReaderProjection } from "./reader-projection";
import { getContentProjectionSession } from "./reader-session";

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) && Array.isArray(value[0]) ? value[0] as Row[] : [];

// 3.3 引擎要求 ORDER BY 字段必须出现在 SELECT 投影（"Missing order idiom"），
// id 一并选出不改变下游（只读 public_id）。
export const CONTENT_CATALOG_SCAN_QUERY = `SELECT id, version.public_id AS public_id
  FROM content_publication_projection
  WHERE item.publication_status = "published" AND item.current_version = version
  ORDER BY id LIMIT 5001;`;

/**
 * Issue one short content_reader lease for an authorized catalog. All content
 * facts are inspected through content_projection_sync; the response contains
 * no unlicensed content metadata. The browser searches with this RECORD lease.
 */
export function createContentSearchExchangeHandler(deps: {
  /** LCA14 灰度开关检查；默认真实实现（_system 每请求新读，无缓存）。 */
  rolloutGates?: RolloutGateChecker;
} = {}) {
  const entitlementStore = new SurrealProductEntitlementStore();
  const idp = createIdpContentReaderScopeAdapter();
  const rolloutGates = deps.rolloutGates ?? createRolloutGateChecker();
  return async (caller: SessionUser, body: unknown): Promise<ContentSearchExchangeSuccess | ContentReaderFailure> => {
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
      return { ok: false, error: "client_authority_rejected" };
    }
    const workspaceDb = typeof caller.raw?.db === "string" ? caller.raw.db : "";
    const subjectExpiresAtSeconds = typeof caller.raw?.exp === "number" ? Math.floor(caller.raw.exp) : 0;
    if (!workspaceDb || caller.raw?.ac === "content_reader") return { ok: false, error: "not_member" };

    try {
      const [system, content] = await Promise.all([
        getRootDatabaseSession("_system", env.SURREAL_NS),
        getContentProjectionSession(),
      ]);
      const index = rows(await system.query(
        "SELECT subject, disabled_at, workspace FROM user_workspace_index WHERE db_name = $db FETCH workspace;",
        { db: workspaceDb },
      ));
      const member = index.find((row) => row.subject === caller.subject);
      if (!member || member.disabled_at != null) return { ok: false, error: member ? "member_removed" : "not_member" };
      const workspace = member.workspace as { id?: unknown; status?: unknown } | undefined;
      if (!workspace?.id || workspace.status !== "active") return { ok: false, error: "workspace_inactive" };
      const workspaceSession = await getRootDatabaseSession(workspaceDb, env.SURREAL_NS);
      const human = rows(await workspaceSession.query(
        `SELECT id, disabled_at FROM user WHERE kind = "human"
          AND (subject = $subject OR (subject = NONE AND email = $email));`,
        { subject: caller.subject, ...(caller.email ? { email: caller.email } : {}) },
      ));
      if (!human.some((row) => row.disabled_at == null)) return { ok: false, error: "member_removed" };

      // LCA14：运营灰度开关优先于权益签发新会话；读失败由外层 catch 归一为 503。
      if (await rolloutGates(workspaceDb, "legal_content_access") === "disabled") {
        return { ok: false, error: "feature_suspended" };
      }

      const snapshot = await entitlementStore.currentSnapshot(String(workspace.id));
      if (!snapshot || !snapshot.digest.startsWith("sha256:")) return { ok: false, error: "entitlement_absent" };
      const entitlement: ContentReaderEntitlement = {
        revision: snapshot.revision,
        digest: snapshot.digest,
        resolverVersion: snapshot.resolverVersion,
        effectiveUntilSeconds: snapshot.effectiveUntil === null ? null : Math.floor(Date.parse(snapshot.effectiveUntil) / 1000),
        collections: snapshot.collections.map((collection) => collection.key),
        contentActions: snapshot.actions,
        aiActions: snapshot.aiActions,
      };
      const permissions = contentReaderPermissions(entitlement);
      if (!permissions.ok) return { ok: false, error: permissions.error };
      if (!permissions.permissions.search) return { ok: false, error: "action_denied" };
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (entitlement.effectiveUntilSeconds !== null && entitlement.effectiveUntilSeconds <= nowSeconds) {
        return { ok: false, error: "entitlement_expired" };
      }
      if (subjectExpiresAtSeconds <= nowSeconds) return { ok: false, error: "invalid_lifetime" };

      // A bounded scan fails closed instead of silently providing partial coverage.
      const catalog = rows(await content.query(CONTENT_CATALOG_SCAN_QUERY));
      if (catalog.length > 5000) throw new Error("content search catalog exceeds safe scan bound");
      const activeSubjects = index.flatMap((row) => row.disabled_at == null && typeof row.subject === "string" ? [row.subject] : []);
      const plans: PlannedContentReaderExchange[] = [];
      for (const row of catalog) {
        if (typeof row.public_id !== "string") throw new Error("content search catalog has no public pointer");
        const target = await fetchContentReaderTarget(content, row.public_id);
        const planned = planContentReaderExchange({
          body: { contentPublicId: row.public_id }, subject: caller.subject, workspaceDb,
          workspaceActive: true, membership: "active", activeSubjects, subjectExpiresAtSeconds,
          nowSeconds, subjectIsContentReader: false, database: env.CONTENT_DATABASE,
          namespace: env.SURREAL_NS, entitlement, content: target,
        });
        if (planned.ok && planned.plan.write.gateActions.includes("search")) plans.push(planned.plan);
      }
      if (plans.length === 0) return { status: "empty" };
      const first = plans[0]!;
      const leaseEndSeconds = Math.min(...plans.map((plan) => plan.leaseEndSeconds));
      const issued = await idp.exchangeContentReaderScope({
        subjectToken: caller.rawToken,
        database: env.CONTENT_DATABASE,
        workspaceId: workspaceDb,
        entitlementRevision: first.idp.entitlementRevision,
        leaseEndSeconds,
      });
      if ("error" in issued || issued.expiresIn === null) return { ok: false, error: "idp_rejected" };
      if (issued.expiresIn <= 0 || issued.expiresIn > leaseEndSeconds - nowSeconds) {
        return { ok: false, error: "invalid_lifetime" };
      }
      for (const plan of plans) {
        await writeContentReaderProjection(content, { ...plan.write, confirmedUntilSeconds: leaseEndSeconds });
      }
      return {
        status: "ready", contractId: first.success.contractId, tokenType: "Bearer",
        accessToken: issued.accessToken, expiresInSeconds: issued.expiresIn,
        namespace: env.SURREAL_NS, database: env.CONTENT_DATABASE, workspaceId: workspaceDb,
        entitlementRevision: first.idp.entitlementRevision, digest: entitlement.digest, leaseEndSeconds,
      };
    } catch {
      throw new HttpError(503, "content-search-unavailable", "授权内容检索暂不可用");
    }
  };
}
