import type { ProjectionVerification, WorkspaceProjectionFact } from "@surreal-ck/shared";
import { getContentProjectionSession, type ContentProjectionClient } from "./reader-session";

type Row = Record<string, unknown>;

/**
 * 核验输入：核验对象是「某工作区当前已交付快照指定的内容投影」，不是抽象集合统计。
 * workspaceDb 对应 content_authorization_projection.workspace_id（存的是数据库名）。
 */
export type ProjectionVerifyInput = {
  workspaceDb: string;
  /** 期望=当前已交付快照；null 表示尚无已交付快照可比对。 */
  expected: { revisionNumber: number; digest: string } | null;
  /** 当前权益声明的内容集合。 */
  collections: { key: string; label: string }[];
  /** 当前权益声明的内容动作，与许可动作求交集判定实际可读性。 */
  actions: string[];
};

type CollectionResult = ProjectionVerification["collections"][number];
type SourceVerdict = CollectionResult["sources"][number];
type SourceReason = SourceVerdict["reason"];

const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const recordId = (value: unknown): string | null => (value == null ? null : String(value));
const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const millisOf = (value: unknown): number | null => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (value && typeof value === "object" && "toISOString" in value && typeof (value as Date).toISOString === "function") {
    return Date.parse((value as Date).toISOString());
  }
  return null;
};
const iso = (value: unknown): string | null => {
  const ms = millisOf(value);
  return ms === null ? null : new Date(ms).toISOString();
};

/**
 * 单语句批量取数：集合内已发布条目（item→current_version→source）、涉及来源、
 * 每个来源的全部许可修订、本工作区授权投影行。最终结果取最后一条 RETURN，
 * 与 fetchContentReaderTarget 的 SDK 结果解析方式一致（数组形状取 .at(-1)）。
 */
const VERIFY_SQL = `
LET $rows = (
  SELECT id AS item, current_version AS version, current_version.source AS source
  FROM content_item
  WHERE publication_status = "published"
    AND id IN (SELECT VALUE item FROM content_collection_binding WHERE collections CONTAINS $key)
);
LET $srcs = (SELECT id, status FROM content_source WHERE id IN $rows.source);
LET $lics = (
  SELECT source, allowed_actions, effective_from, effective_until, \`revision\`
  FROM source_license_revision
  WHERE source IN $rows.source
  ORDER BY source, \`revision\` DESC
);
LET $proj = (
  SELECT revision, revision_number, digest, collections, confirmed_until, status
  FROM content_authorization_projection
  WHERE workspace_id = $ws LIMIT 1
)[0];
RETURN { items: $rows, sources: $srcs, licenses: $lics, projection: $proj };
`;

type VerifyOut = {
  items: Row[];
  sources: Row[];
  licenses: Row[];
  projection: Row | null;
};

function parseResult(result: unknown): VerifyOut {
  // SDK 多语句返回数组，最终 RETURN 在末尾；对象形状直接取用。
  const out = (Array.isArray(result) ? result.at(-1) : result) as Row | null | undefined;
  if (!out || typeof out !== "object") throw new Error("projection verify: unexpected result shape");
  const items = Array.isArray(out.items) ? out.items as Row[] : [];
  const sources = Array.isArray(out.sources) ? out.sources as Row[] : [];
  const licenses = Array.isArray(out.licenses) ? out.licenses as Row[] : [];
  const projection = out.projection && typeof out.projection === "object" ? out.projection as Row : null;
  return { items, sources, licenses, projection };
}

/** 逐来源许可矩阵：与 fn::content_reader_visible 的判定口径一致（fail closed）。 */
function reasonForItem(item: Row, sourceById: Map<string, Row>, licenseBySource: Map<string, Row>, now: number, entitledActions: string[]): SourceReason {
  if (!recordId(item.version)) return "version_missing";
  const sourceId = recordId(item.source);
  const source = sourceId ? sourceById.get(sourceId) : null;
  if (!source || asString(source.status) !== "active") return "source_inactive";
  const license = sourceId ? licenseBySource.get(sourceId) : null;
  if (!license) return "license_missing";
  const from = millisOf(license.effective_from);
  if (from === null || from > now) return "license_not_started";
  const until = millisOf(license.effective_until);
  if (until !== null && until <= now) return "license_expired";
  const licensed = stringsOf(license.allowed_actions);
  if (!entitledActions.some((action) => licensed.includes(action))) return "action_denied";
  return null;
}

function evalCollection(out: VerifyOut, collection: { key: string; label: string }, now: number, entitledActions: string[]): CollectionResult {
  const sourceById = new Map(out.sources.map((row) => [recordId(row.id) ?? "", row]));
  // $lics 已按 source+revision DESC 排序：每个来源取第一行=最新许可修订。
  const licenseBySource = new Map<string, Row>();
  for (const lic of out.licenses) {
    const sourceId = recordId(lic.source);
    if (sourceId && !licenseBySource.has(sourceId)) licenseBySource.set(sourceId, lic);
  }
  const bySource = new Map<string, SourceVerdict & { sourceRow: Row | null }>();
  let readable = 0;
  for (const item of out.items) {
    const sourceId = recordId(item.source) ?? "";
    const reason = reasonForItem(item, sourceById, licenseBySource, now, entitledActions);
    if (reason === null) readable += 1;
    let entry = bySource.get(sourceId);
    if (!entry) {
      const source = sourceById.get(sourceId) ?? null;
      const license = sourceId ? licenseBySource.get(sourceId) ?? null : null;
      entry = {
        sourceId: sourceId || "(未知来源)",
        sourceStatus: asString(source?.status) ?? "unknown",
        licenseFrom: license ? iso(license.effective_from) : null,
        licenseUntil: license ? iso(license.effective_until) : null,
        licenseActions: license ? stringsOf(license.allowed_actions) : [],
        items: 0,
        valid: true,
        reason: null,
        sourceRow: source,
      };
      bySource.set(sourceId, entry);
    }
    entry.items += 1;
    if (reason !== null && entry.reason === null) { entry.valid = false; entry.reason = reason; }
  }
  const sources = [...bySource.values()].map(({ sourceRow: _sourceRow, ...rest }) => rest);
  return {
    key: collection.key,
    label: collection.label,
    publishedItems: out.items.length,
    readableItems: readable,
    blockedItems: out.items.length - readable,
    sources,
  };
}

function evalWorkspace(projection: Row | null, expected: ProjectionVerifyInput["expected"], now: number): WorkspaceProjectionFact {
  if (!projection) {
    return {
      state: "absent",
      revision: null,
      revisionNumber: null,
      matchesExpected: null,
      confirmedUntil: null,
      expectedRevisionNumber: expected?.revisionNumber ?? null,
    };
  }
  const confirmedUntil = iso(projection.confirmed_until);
  const expired = confirmedUntil !== null && Date.parse(confirmedUntil) <= now;
  const state: WorkspaceProjectionFact["state"] =
    asString(projection.status) === "closed" ? "closed" : expired ? "expired" : "active";
  const revisionNumber = asNumber(projection.revision_number);
  const matchesExpected = expected
    ? revisionNumber === expected.revisionNumber && asString(projection.digest) === expected.digest
    : null;
  return {
    state,
    revision: asString(projection.revision),
    revisionNumber,
    matchesExpected,
    confirmedUntil,
    expectedRevisionNumber: expected?.revisionNumber ?? null,
  };
}

/**
 * LCA13：工作区权益的内容投影核验。复用 content_projection_sync 同款受限会话
 * （运营不因此获得更高内容权限、不读正文），核验三层事实：
 * 1. 工作区授权投影行是否存在且与当前已交付快照 revision+digest 一致；
 * 2. 每个权益集合内已发布条目按其来源逐条过许可矩阵（来源状态/许可窗口/
 *    动作交集，口径与 fn::content_reader_visible 一致）；
 * 3. 目录事实完整性（已发布条目必须挂当前版本）。
 * 未知事实一律 fail closed，绝不把「查到若干 published」当作交付成功。
 */
export async function verifyContentProjection(input: ProjectionVerifyInput, client?: ContentProjectionClient): Promise<ProjectionVerification> {
  const checkedAt = new Date().toISOString();
  const now = Date.now();
  const db = client ?? await getContentProjectionSession();
  const collections: CollectionResult[] = [];
  const entitledActions = input.actions.length > 0 ? input.actions : ["read"];
  let workspace: WorkspaceProjectionFact = {
    state: "absent",
    revision: null,
    revisionNumber: null,
    matchesExpected: null,
    confirmedUntil: null,
    expectedRevisionNumber: input.expected?.revisionNumber ?? null,
  };
  let sawProjectionRow = false;
  for (const collection of input.collections) {
    const result = await db.query(VERIFY_SQL, { key: collection.key, ws: input.workspaceDb });
    const out = parseResult(result);
    if (out.projection) sawProjectionRow = true;
    workspace = evalWorkspace(out.projection, input.expected, now);
    collections.push(evalCollection(out, collection, now, entitledActions));
  }
  // 工作区无内容集合时只核投影行本身（一次无集合键的查询拿不到 binding 行，
  // 但投影行事实仍然有效）。
  if (input.collections.length === 0) {
    const result = await db.query(
      `RETURN (SELECT revision, revision_number, digest, collections, confirmed_until, status
       FROM content_authorization_projection WHERE workspace_id = $ws LIMIT 1)[0];`,
      { ws: input.workspaceDb },
    );
    const row = (Array.isArray(result) ? result.at(-1) : result) as Row | null | undefined;
    workspace = evalWorkspace(row && typeof row === "object" ? row : null, input.expected, now);
    sawProjectionRow = row != null;
  }
  const error = collections.some((item) => item.publishedItems > 0 && item.readableItems === 0
    && item.sources.every((source) => source.reason === "version_missing"));
  const blocked = collections.some((item) => item.publishedItems > 0 && item.readableItems === 0);
  const empty = collections.some((item) => item.publishedItems === 0);
  const stale = sawProjectionRow && input.expected
    ? workspace.state !== "active" || workspace.matchesExpected !== true
    : sawProjectionRow && workspace.state !== "active";
  const verdict: ProjectionVerification["verdict"] =
    error ? "projection_error"
    : stale ? "projection_stale"
    : blocked ? "license_blocked"
    : empty ? "empty_collection"
    : "ok";
  return { checkedAt, verdict, workspace, collections };
}

/** 生产装配：核验会话/查询失败返回 unavailable（核验不可用 ≠ 有故障结论），fail closed。 */
export function createProjectionVerifier(): (input: ProjectionVerifyInput) => Promise<ProjectionVerification | null> {
  return async (input) => {
    try {
      return await verifyContentProjection(input);
    } catch {
      return {
        checkedAt: new Date().toISOString(),
        verdict: "unavailable",
        workspace: {
          state: "absent",
          revision: null,
          revisionNumber: null,
          matchesExpected: null,
          confirmedUntil: null,
          expectedRevisionNumber: input.expected?.revisionNumber ?? null,
        },
        collections: [],
      };
    }
  };
}
