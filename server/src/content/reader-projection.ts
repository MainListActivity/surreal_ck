import { DateTime, RecordId, StringRecordId } from "surrealdb";
import { toIsoDateTimeString, toSurrealNone } from "../db/surreal-values";
import type { ContentProjectionClient } from "./reader-session";
import type { ContentReaderProjectionWrite, ContentReaderTarget } from "./reader-exchange";

type Row = Record<string, unknown>;

const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const recordId = (value: unknown): string | null => (value == null ? null : String(value));
const secondsOf = (value: unknown): number | null => {
  const iso = toIsoDateTimeString(value);
  return iso === null ? null : Math.floor(Date.parse(iso) / 1000);
};
const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/**
 * 由 content_projection_sync 受限会话读取一条公开指针的事实快照。
 * 事实只含门禁所需字段，不读正文；任一部分缺失返回 null（由调用方 fail closed）。
 */
export async function fetchContentReaderTarget(
  db: ContentProjectionClient,
  publicId: string,
): Promise<ContentReaderTarget | null> {
  const result = await db.query(
    `
    LET $v = (SELECT id, item, source FROM content_version WHERE public_id = $pid LIMIT 1)[0];
    IF $v = NONE { RETURN NONE; };
    LET $item = (SELECT id, publication_status FROM content_item WHERE id = $v.item LIMIT 1)[0];
    IF $item = NONE { RETURN NONE; };
    LET $src = (SELECT id, status FROM content_source WHERE id = $v.source LIMIT 1)[0];
    LET $lic = (SELECT id, allowed_actions, effective_from, effective_until, \`revision\`
      FROM source_license_revision WHERE source = $v.source ORDER BY \`revision\` DESC LIMIT 1)[0];
    LET $bind = (SELECT collections FROM content_collection_binding WHERE item = $v.item LIMIT 1)[0];
    RETURN {
      version: $v.id,
      item: $v.item,
      source_status: $src.status ?? "inactive",
      publication_status: $item.publication_status ?? "unknown",
      license: $lic.id,
      license_actions: $lic.allowed_actions ?? [],
      license_from: $lic.effective_from,
      license_until: $lic.effective_until,
      collections: $bind.collections ?? []
    };
    `,
    { pid: publicId },
  );
  const row = (Array.isArray(result) ? result.at(-1) : result) as Row | null | undefined;
  if (!row || typeof row !== "object") return null;
  const versionId = recordId(row.version);
  const itemId = recordId(row.item);
  if (!versionId || !itemId) return null;
  return {
    versionId,
    itemId,
    licenseId: recordId(row.license) ?? "",
    sourceActive: row.source_status === "active",
    publicationStatus: asString(row.publication_status) ?? "unknown",
    collectionKeys: stringsOf(row.collections),
    licenseFromSeconds: secondsOf(row.license_from),
    licenseUntilSeconds: secondsOf(row.license_until),
    licenseActions: stringsOf(row.license_actions),
  };
}

const PROJECTION_SQL = `
BEGIN;
UPSERT $projectionId CONTENT {
  workspace_id: $workspaceId,
  revision: $revision,
  revision_number: $revisionNumber,
  digest: $digest,
  resolver_version: $resolverVersion,
  collections: $collections,
  content_actions: $contentActions,
  ai_actions: $aiActions,
  allowed_subjects: $allowedSubjects,
  confirmed_at: time::now(),
  confirmed_until: $confirmedUntil,
  status: "active"
};
UPSERT $gateId CONTENT {
  version: $version,
  item: $item,
  license: $license,
  workspace_id: $workspaceId,
  revision: $revision,
  actions: $gateActions,
  ai_actions: $gateAiActions,
  source_status: $sourceStatus,
  publication_status: $publicationStatus,
  license_from: $licenseFrom,
  license_until: $licenseUntil,
  license_actions: $licenseActions,
  collection_matched: $collectionMatched,
  allowed_subjects: $allowedSubjects,
  status: "active"
};
COMMIT;
`;

const MAX_ATTEMPTS = 3;

/**
 * 由 content_projection_sync 受限会话把一次成功换票投影到内容库。
 * 记录 ID 由 workspace（+version）派生：同 workspace 的重复/并发换票原子收敛到
 * 同一行 active 投影，同一内容版本收敛到同一行门禁；写失败整体回滚、不扩大访问。
 */
export async function writeContentReaderProjection(
  db: ContentProjectionClient,
  write: ContentReaderProjectionWrite,
): Promise<void> {
  const params = {
    projectionId: new RecordId("content_authorization_projection", [write.workspaceId]),
    gateId: new RecordId("content_read_gate", [write.workspaceId, write.versionId]),
    workspaceId: write.workspaceId,
    revision: write.revision,
    revisionNumber: write.revisionNumber,
    digest: write.digest,
    resolverVersion: write.resolverVersion,
    collections: [...write.collections],
    contentActions: [...write.contentActions],
    aiActions: [...write.aiActions],
    allowedSubjects: [...write.allowedSubjects],
    confirmedUntil: new DateTime(new Date(write.confirmedUntilSeconds * 1000)),
    version: new StringRecordId(write.versionId),
    item: new StringRecordId(write.itemId),
    license: new StringRecordId(write.licenseId),
    gateActions: [...write.gateActions],
    gateAiActions: [...write.gateAiActions],
    sourceStatus: write.sourceStatus,
    publicationStatus: write.publicationStatus,
    licenseFrom: new DateTime(new Date(write.licenseFromSeconds * 1000)),
    licenseUntil: toSurrealNone(
      write.licenseUntilSeconds === null ? null : new DateTime(new Date(write.licenseUntilSeconds * 1000)),
    ),
    licenseActions: [...write.licenseActions],
    collectionMatched: true,
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      await db.query(PROJECTION_SQL, params);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
