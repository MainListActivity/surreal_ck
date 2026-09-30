import { StringRecordId } from "surrealdb";
import { CONTENT_SEARCH_COUNT_QUERY, CONTENT_SEARCH_QUERY, type ContentReaderFailure, type ContentSearchExchangeSuccess } from "@surreal-ck/shared";

export type LegalSearchFilters = {
  keyword: string;
  kind: "all" | "legislation" | "judicial_document";
  publishedFrom: string;
  publishedUntil: string;
  jurisdiction: string;
  effectiveOn: string;
};

export type LegalSearchResult = {
  id: string;
  publicId: string;
  title: string;
  revision: number;
  versionLabel: string | null;
  kind: string;
  sourceUrl: string;
  publishedOn: string | null;
  jurisdiction: string | null;
  effectiveOn: string | null;
};

export type LegalSearchPage = { items: LegalSearchResult[]; nextCursor: string | null; total: number };
export type LegalSearchState = "not_member" | "not_authorized" | "unavailable" | "empty" | "ready";

type Queryable = {
  query(sql: string, bindings?: Record<string, unknown>): { collect(): Promise<unknown[]> };
  connect(url: string, options: { namespace: string; database: string }): Promise<unknown>;
  authenticate(token: string): Promise<unknown>;
  close(): Promise<unknown>;
};

const PAGE_SIZE = 20;
export { CONTENT_SEARCH_QUERY, CONTENT_SEARCH_COUNT_QUERY } from "@surreal-ck/shared";

function rows(value: unknown[]): Record<string, unknown>[] {
  return Array.isArray(value[0]) ? value[0] as Record<string, unknown>[] : [];
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function entry(row: Record<string, unknown>): LegalSearchResult | null {
  const id = row.version_id == null ? null : String(row.version_id);
  const publicId = text(row.public_id);
  const title = text(row.title);
  const sourceUrl = text(row.source_url);
  if (!id || !publicId || !title || !sourceUrl || !Number.isInteger(row.revision)) return null;
  return {
    id, publicId, title, sourceUrl, revision: row.revision as number,
    versionLabel: text(row.version_label), kind: text(row.kind) ?? "unknown",
    publishedOn: text(row.published_on), jurisdiction: text(row.jurisdiction), effectiveOn: text(row.effective_on),
  };
}

/** A separate short-lived content RECORD connection; the workspace session is untouched. */
export function createContentSearch(deps: {
  exchange: () => Promise<ContentSearchExchangeSuccess | ContentReaderFailure>;
  connect: () => Queryable;
  workspaceDb: () => string | null;
  nowSeconds: () => number;
  surrealUrl: string;
}) {
  let db: Queryable | null = null;
  let workspaceDb: string | null = null;
  let deadline = 0;
  let generation = 0;
  async function close() {
    generation++;
    const previous = db;
    db = null;
    if (previous) await previous.close().catch(() => undefined);
  }
  return {
    close,
    deadlineSeconds: () => deadline,
    async open(): Promise<LegalSearchState> {
      await close();
      const current = generation;
      const currentWorkspace = deps.workspaceDb();
      if (!currentWorkspace) return "not_member";
      let exchange: ContentSearchExchangeSuccess | ContentReaderFailure;
      try { exchange = await deps.exchange(); } catch { return "unavailable"; }
      if (current !== generation || deps.workspaceDb() !== currentWorkspace) return "unavailable";
      if ("ok" in exchange) {
        if (["not_member", "member_removed"].includes(exchange.error)) return "not_member";
        return ["entitlement_absent", "entitlement_expired", "action_denied"].includes(exchange.error)
          ? "not_authorized" : "unavailable";
      }
      if (exchange.status === "empty") return "empty";
      const now = deps.nowSeconds();
      const expires = Math.min(exchange.leaseEndSeconds, now + exchange.expiresInSeconds);
      if (exchange.workspaceId !== currentWorkspace || expires <= now || expires > now + 900) return "unavailable";
      const next = deps.connect();
      try {
        await next.connect(deps.surrealUrl, { namespace: exchange.namespace, database: exchange.database });
        await next.authenticate(exchange.accessToken);
        if (current !== generation || deps.workspaceDb() !== currentWorkspace) return "unavailable";
        db = next;
        workspaceDb = currentWorkspace;
        deadline = expires;
        return "ready";
      } catch { return "unavailable"; }
      finally { if (db !== next) await next.close().catch(() => undefined); }
    },
    async search(filters: LegalSearchFilters, cursor: string | null = null): Promise<LegalSearchPage> {
      if (!db || deps.workspaceDb() !== workspaceDb || deps.nowSeconds() >= deadline) {
        await close();
        throw new Error("content-search-session-expired");
      }
      const bindings = {
        keyword: filters.keyword.trim().slice(0, 200), kind: filters.kind,
        from: filters.publishedFrom, until: filters.publishedUntil,
        jurisdiction: filters.jurisdiction.trim().slice(0, 100),
        effective: filters.effectiveOn,
      };
      const [result, count] = await Promise.all([
        db.query(CONTENT_SEARCH_QUERY, { ...bindings, cursor: cursor ? new StringRecordId(cursor) : undefined }).collect(),
        db.query(CONTENT_SEARCH_COUNT_QUERY, bindings).collect(),
      ]);
      if (!db || deps.workspaceDb() !== workspaceDb || deps.nowSeconds() >= deadline) {
        await close();
        throw new Error("content-search-session-expired");
      }
      const pageRows = rows(result);
      if (pageRows.length > PAGE_SIZE + 1) throw new Error("content-search-invalid-page");
      const items = pageRows.slice(0, PAGE_SIZE).map(entry);
      if (items.some((item) => !item)) throw new Error("content-search-invalid-row");
      const nextCursor = pageRows.length > PAGE_SIZE ? String(pageRows[PAGE_SIZE - 1]!.id) : null;
      const total = rows(count)[0]?.total;
      return { items: items as LegalSearchResult[], nextCursor, total: typeof total === "number" ? total : 0 };
    },
  };
}
