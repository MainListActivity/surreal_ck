/**
 * LCA09 引用状态的生产事实读取：成员索引 / 工作区状态 / 身份有效性 /
 * 权益快照 / 内容库 metadata 事实——与 content search/reader 换票相同的
 * 控制面读取路径（content_projection_sync 受限会话，仅 metadata，不读正文）。
 * 任何事实失败由调用方统一 fail closed，不区分泄漏细节。
 */
import type { SessionUser } from "@surreal-ck/shared";
import { env } from "../env";
import { getRootDatabaseSession } from "../db/root-connection";
import { SurrealProductEntitlementStore } from "../product-entitlement/store";
import type { ContentReaderEntitlement, ContentReaderTarget } from "../content/reader-exchange";
import { fetchContentReaderTarget } from "../content/reader-projection";
import { getContentProjectionSession } from "../content/reader-session";
import type { CallerFacts } from "./citation-status";

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) && Array.isArray(value[0]) ? value[0] as Row[] : [];

async function loadCallerFacts(caller: SessionUser): Promise<CallerFacts> {
  const workspaceDb = typeof caller.raw?.db === "string" ? caller.raw.db : "";
  const subjectExpiresAtSeconds = typeof caller.raw?.exp === "number" ? Math.floor(caller.raw.exp) : 0;
  if (!workspaceDb || caller.raw?.ac === "content_reader") {
    return { workspaceId: "", workspaceActive: false, membership: "absent", subjectInActiveIndex: false, subjectExpiresAtSeconds };
  }

  const system = await getRootDatabaseSession("_system", env.SURREAL_NS);
  const index = rows(await system.query(
    "SELECT subject, disabled_at, workspace FROM user_workspace_index WHERE db_name = $db FETCH workspace;",
    { db: workspaceDb },
  ));
  const member = index.find((row) => row.subject === caller.subject);
  if (!member || member.disabled_at != null) {
    return {
      workspaceId: "",
      workspaceActive: false,
      membership: member ? "removed" : "absent",
      subjectInActiveIndex: false,
      subjectExpiresAtSeconds,
    };
  }
  const workspace = member.workspace as { id?: unknown; status?: unknown } | undefined;
  if (!workspace?.id || workspace.status !== "active") {
    return { workspaceId: String(workspace?.id ?? ""), workspaceActive: false, membership: "active", subjectInActiveIndex: false, subjectExpiresAtSeconds };
  }

  const workspaceSession = await getRootDatabaseSession(workspaceDb, env.SURREAL_NS);
  const human = rows(await workspaceSession.query(
    `SELECT id, disabled_at FROM user WHERE kind = "human"
      AND (subject = $subject OR (subject = NONE AND email = $email));`,
    { subject: caller.subject, ...(caller.email ? { email: caller.email } : {}) },
  ));
  const subjectInActiveIndex = human.some((row) => row.disabled_at == null);
  if (!subjectInActiveIndex) {
    return { workspaceId: String(workspace.id), workspaceActive: true, membership: "removed", subjectInActiveIndex: false, subjectExpiresAtSeconds };
  }

  return {
    workspaceId: String(workspace.id),
    workspaceActive: true,
    membership: "active",
    subjectInActiveIndex: true,
    subjectExpiresAtSeconds,
  };
}

async function loadEntitlement(workspaceId: string): Promise<ContentReaderEntitlement | null> {
  if (!workspaceId) return null;
  const snapshot = await new SurrealProductEntitlementStore().currentSnapshot(workspaceId);
  if (!snapshot || !snapshot.digest.startsWith("sha256:")) return null;
  return {
    revision: snapshot.revision,
    digest: snapshot.digest,
    resolverVersion: snapshot.resolverVersion,
    effectiveUntilSeconds: snapshot.effectiveUntil === null ? null : Math.floor(Date.parse(snapshot.effectiveUntil) / 1000),
    collections: snapshot.collections.map((collection) => collection.key),
    contentActions: snapshot.actions,
    aiActions: snapshot.aiActions,
  };
}

async function fetchTarget(versionPublicId: string): Promise<ContentReaderTarget | null> {
  const content = await getContentProjectionSession();
  return fetchContentReaderTarget(content, versionPublicId);
}

export const defaultProductionFacts: {
  loadCallerFacts(caller: SessionUser): Promise<CallerFacts>;
  loadEntitlement(workspaceId: string): Promise<ContentReaderEntitlement | null>;
  fetchTarget(versionPublicId: string): Promise<ContentReaderTarget | null>;
} = {
  loadCallerFacts,
  loadEntitlement,
  fetchTarget,
};
