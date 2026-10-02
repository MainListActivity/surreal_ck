import { formatEntitlementRevision, type SessionUser } from "@surreal-ck/shared";
import type { Surreal } from "surrealdb";
import { getRootDatabaseSession } from "../db/root-connection";
import { env } from "../env";
import { HttpError } from "../http-error";
import { planContentReaderExchange, type ContentReaderEntitlement } from "../content/reader-exchange";
import { fetchContentReaderFactsByVersion } from "../content/reader-projection";
import { getContentProjectionSession } from "../content/reader-session";
import { SurrealProductEntitlementStore } from "../product-entitlement/store";
import type { SnapshotRecord } from "../product-entitlement/service";
import { createRolloutGateChecker, type RolloutGateChecker } from "../rollout/gate-check";
import { deniedDelivery, type DeliveryPlatformVerifier } from "./delivery-store";

type Queryable = Pick<Surreal, "query">;
type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) && Array.isArray(value[0]) ? value[0] as Row[] : [];

export type DeliveryVerifierDeps = {
  /** _system 控制面读会话（成员索引）；默认 root 池。 */
  systemSession?: () => Promise<Queryable>;
  /** workspace db 读会话（user 行）；默认 root 池。 */
  workspaceSession?: (db: string) => Promise<Queryable>;
  /** platform_content 事实读会话；默认 content_projection_sync。 */
  contentSession?: () => Promise<Queryable>;
  /** 当前权益快照读取；默认 SurrealProductEntitlementStore。 */
  currentSnapshot?: (workspaceRecordId: string) => Promise<SnapshotRecord | null>;
  rolloutGates?: RolloutGateChecker;
  now?: () => number;
};

/**
 * recover / WS 补取的交付复核工厂：替代原「重新开 content_reader 窗口」路径。
 * 窗口路径把成员索引、权益快照、目录扫描、IdP scope 换票与投影写全部塞进同步请求，
 * IdP 降级时 recover 必被连接层掐断（生产 AC2 的 ~9s 502）。复核不需要签发租约或写投影——
 * 用 content_projection_sync 读底层事实，复用 planContentReaderExchange 谓词重算门禁判定，
 * 语义与换票门禁完全一致且更鲜（绕过 content_read_gate 快照延迟），同步路径毫秒级收敛。
 * 授权失败 → 409 authorization_changed；基础设施失败 → 503 可重试。
 */
export function createDeliveryVerifierFactory(deps: DeliveryVerifierDeps = {}) {
  const systemSession = deps.systemSession
    ?? (async () => (await getRootDatabaseSession("_system", env.SURREAL_NS)) as unknown as Queryable);
  const workspaceSession = deps.workspaceSession
    ?? (async (db: string) => (await getRootDatabaseSession(db, env.SURREAL_NS)) as unknown as Queryable);
  const contentSession = deps.contentSession ?? getContentProjectionSession;
  const rolloutGates = deps.rolloutGates ?? createRolloutGateChecker();
  const entitlements = new SurrealProductEntitlementStore();
  const currentSnapshot = deps.currentSnapshot ?? ((id: string) => entitlements.currentSnapshot(id));
  const now = deps.now ?? Date.now;

  return (user: SessionUser): DeliveryPlatformVerifier => async (proofs) => {
    const workspaceDb = typeof user.raw?.db === "string" ? user.raw.db : "";
    const subjectExp = typeof user.raw?.exp === "number" ? Math.floor(user.raw.exp) : 0;
    if (!workspaceDb || user.raw?.ac === "content_reader") return deniedDelivery();
    const nowSeconds = Math.floor(now() / 1000);
    try {
      const [system, workspace, content] = await Promise.all([systemSession(), workspaceSession(workspaceDb), contentSession()]);
      const index = rows(await system.query(
        "SELECT subject, disabled_at, workspace FROM user_workspace_index WHERE db_name = $db FETCH workspace;",
        { db: workspaceDb },
      ));
      const member = index.find((row) => row.subject === user.subject);
      if (!member || member.disabled_at != null) return deniedDelivery();
      const workspaceRow = member.workspace as { id?: unknown; status?: unknown } | undefined;
      if (!workspaceRow?.id || workspaceRow.status !== "active") return deniedDelivery();
      const human = rows(await workspace.query(
        `SELECT id, disabled_at FROM user WHERE kind = "human"
          AND (subject = $subject OR (subject = NONE AND email = $email));`,
        { subject: user.subject, ...(user.email ? { email: user.email } : {}) },
      ));
      if (!human.some((row) => row.disabled_at == null)) return deniedDelivery();
      // LCA14：补取与换票一样受法律内容访问开关约束；读失败由外层 catch 归一为 503。
      if (await rolloutGates(workspaceDb, "legal_content_access") === "disabled") return deniedDelivery();
      const snapshot = await currentSnapshot(String(workspaceRow.id));
      if (!snapshot || !snapshot.digest.startsWith("sha256:")) return deniedDelivery();
      const revision = formatEntitlementRevision(snapshot.revision);
      if (!revision.ok) return deniedDelivery();
      const entitlement: ContentReaderEntitlement = {
        revision: snapshot.revision,
        digest: snapshot.digest,
        resolverVersion: snapshot.resolverVersion,
        effectiveUntilSeconds: snapshot.effectiveUntil === null ? null : Math.floor(Date.parse(snapshot.effectiveUntil) / 1000),
        collections: snapshot.collections.map((collection) => collection.key),
        contentActions: snapshot.actions,
        aiActions: snapshot.aiActions,
      };
      const activeSubjects = index.flatMap((row) => row.disabled_at == null && typeof row.subject === "string" ? [row.subject] : []);
      for (const proof of proofs) {
        if (proof.authorization.workspaceId !== workspaceDb) return deniedDelivery();
        if (proof.authorization.kind === "ready") {
          // 时代比对沿用原窗口语义：权益任何演进（含权限不变的重签发）都不能补取旧答案。
          if (proof.authorization.revision !== revision.entitlementRevision || proof.authorization.digest !== snapshot.digest) return deniedDelivery();
        } else {
          // 非 ready 授权不可能产出平台证据；出现即数据不可能态，按撤权拒绝。
          return deniedDelivery();
        }
        for (const item of proof.platform) {
          const facts = await fetchContentReaderFactsByVersion(content, item.versionId);
          if (!facts || facts.bodySha256 !== item.bodySha256 || !facts.publicId) return deniedDelivery();
          const planned = planContentReaderExchange({
            body: { contentPublicId: facts.publicId },
            subject: user.subject,
            workspaceDb,
            workspaceActive: true,
            membership: "active",
            activeSubjects,
            subjectExpiresAtSeconds: subjectExp,
            nowSeconds,
            subjectIsContentReader: false,
            database: env.CONTENT_DATABASE,
            namespace: env.SURREAL_NS,
            entitlement,
            content: facts,
          });
          if (!planned.ok) return deniedDelivery();
          // 与原窗口内 fn::content_reader_action 逐项断言一致：read + ai_use(+cite)。
          const gate = planned.plan.write;
          if (!gate.gateAiActions.length || !gate.gateActions.includes("read")
            || (item.cite && !gate.gateActions.includes("cite"))) return deniedDelivery();
        }
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "chat-delivery-verify-unavailable", "授权核验暂不可用，请稍后重试", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
