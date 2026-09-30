import {
  CONTENT_READER_BOUND_SECONDS,
  CONTENT_READER_CONTRACT_ID,
  contentReaderExchangeRequestSchema,
  type ContentReaderError,
  type ContentReaderExchangeSuccess,
  type ContentReaderFailure,
} from "@surreal-ck/shared";
import { StringRecordId } from "surrealdb";

export type ContentPage = {
  versionId: string;
  publicId: string;
  title: string;
  revision: number;
  versionLabel: string | null;
  sourceUrl: string;
  sourceForm: string;
  publishedAt: string | null;
  bodyText: string;
  canCite: boolean;
  articles: Array<{ id: string; label: string; localKey: string; bodyText: string }>;
  authorizedUntilSeconds: number;
};

export type ContentReaderResult =
  | { ok: true; page: ContentPage }
  | { ok: false; reason: ContentReaderError | "invalid_id" | "workspace_changed" | "session_expired" | "content_unavailable" };

type ContentRow = {
  id?: unknown;
  public_id?: unknown;
  title?: unknown;
  revision?: unknown;
  version_label?: unknown;
  source_url?: unknown;
  source_form?: unknown;
  published_at?: unknown;
  body_text?: unknown;
};

export interface ContentConnection {
  connect(url: string, options: { namespace: string; database: string }): Promise<unknown>;
  authenticate(token: string): Promise<unknown>;
  query(sql: string, bindings: Record<string, unknown>): { collect(): Promise<unknown[]> };
  close(): Promise<unknown>;
}

export type ContentReaderDependencies = {
  exchange(publicId: string): Promise<ContentReaderExchangeSuccess | ContentReaderFailure>;
  connect(): ContentConnection;
  workspaceDb(): string | null;
  surrealUrl: string;
  nowSeconds(): number;
};

// The WHERE clause only selects the requested public pointer. Content authorization
// and field visibility belong to the content database schema, never this query.
export const CONTENT_PAGE_QUERY = "SELECT id, public_id, title, revision, version_label, source_url, source_form, published_at, body_text FROM content_version WHERE public_id = $publicId LIMIT 1;";

function isFailure(value: unknown): value is ContentReaderFailure {
  return Boolean(value && typeof value === "object" && (value as { ok?: unknown }).ok === false);
}

function isExchangeSuccess(value: unknown): value is ContentReaderExchangeSuccess {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<ContentReaderExchangeSuccess>;
  return result.contractId === CONTENT_READER_CONTRACT_ID
    && result.tokenType === "Bearer"
    && typeof result.accessToken === "string"
    && result.accessToken.length > 0
    && typeof result.namespace === "string"
    && result.namespace.length > 0
    && typeof result.database === "string"
    && result.database.length > 0
    && typeof result.workspaceId === "string"
    && typeof result.contentPublicId === "string"
    && typeof result.entitlementRevision === "string"
    && typeof result.digest === "string"
    && Number.isInteger(result.expiresInSeconds)
    && Number.isInteger(result.leaseEndSeconds);
}

function pageFromRow(row: ContentRow, publicId: string, authorizedUntilSeconds: number): ContentPage | null {
  if (!row.id || row.public_id !== publicId || typeof row.title !== "string" || !Number.isInteger(row.revision)
    || typeof row.source_url !== "string" || typeof row.source_form !== "string"
    || typeof row.body_text !== "string") return null;
  return {
    versionId: String(row.id),
    publicId,
    title: row.title,
    revision: row.revision as number,
    versionLabel: typeof row.version_label === "string" ? row.version_label : null,
    sourceUrl: row.source_url,
    sourceForm: row.source_form,
    publishedAt: row.published_at == null ? null : String(row.published_at),
    bodyText: row.body_text,
    canCite: false,
    articles: [],
    authorizedUntilSeconds,
  };
}

export function createContentReader(deps: ContentReaderDependencies) {
  let connection: ContentConnection | null = null;
  let generation = 0;

  async function close(): Promise<void> {
    generation++;
    const previous = connection;
    connection = null;
    if (previous) await previous.close().catch(() => undefined);
  }

  return {
    close,
    async open(publicId: string, workspaceDb: string): Promise<ContentReaderResult> {
      const parsed = contentReaderExchangeRequestSchema.safeParse({ contentPublicId: publicId });
      if (!parsed.success) return { ok: false, reason: "invalid_id" };
      await close();
      const current = generation;
      const stillCurrent = () => current === generation && deps.workspaceDb() === workspaceDb;
      if (!stillCurrent()) return { ok: false, reason: "workspace_changed" };

      let exchange: ContentReaderExchangeSuccess | ContentReaderFailure;
      try {
        exchange = await deps.exchange(parsed.data.contentPublicId);
      } catch {
        return { ok: false, reason: "content_unavailable" };
      }
      if (!stillCurrent()) return { ok: false, reason: "workspace_changed" };
      if (isFailure(exchange)) return { ok: false, reason: exchange.error };
      if (!isExchangeSuccess(exchange) || exchange.workspaceId !== workspaceDb
        || exchange.contentPublicId !== parsed.data.contentPublicId) {
        return { ok: false, reason: "content_unavailable" };
      }
      const now = deps.nowSeconds();
      const deadline = Math.min(exchange.leaseEndSeconds, now + exchange.expiresInSeconds);
      if (exchange.expiresInSeconds <= 0 || exchange.expiresInSeconds > CONTENT_READER_BOUND_SECONDS
        || exchange.leaseEndSeconds <= now || exchange.leaseEndSeconds > now + CONTENT_READER_BOUND_SECONDS
        || deadline <= now || !deps.surrealUrl) {
        return { ok: false, reason: "session_expired" };
      }

      const next = deps.connect();
      try {
        await next.connect(deps.surrealUrl, {
          namespace: exchange.namespace,
          database: exchange.database,
        });
        await next.authenticate(exchange.accessToken);
        if (!stillCurrent() || deps.nowSeconds() >= deadline) {
          return { ok: false, reason: "workspace_changed" };
        }
        const results = await next.query(CONTENT_PAGE_QUERY, { publicId: parsed.data.contentPublicId }).collect();
        if (!stillCurrent() || deps.nowSeconds() >= deadline) {
          return { ok: false, reason: "session_expired" };
        }
        const rows = results[0];
        const row = Array.isArray(rows) ? rows[0] as ContentRow | undefined : undefined;
        const page = row && pageFromRow(row, parsed.data.contentPublicId, deadline);
        if (!page) return { ok: false, reason: "content_unavailable" };
        const version = new StringRecordId(page.versionId);
        const [articleResult, citeResult] = await Promise.all([
          next.query("SELECT id, label, local_key, body_text FROM legal_article_version WHERE regulation_version = $version ORDER BY local_key;", { version }).collect(),
          next.query("RETURN fn::content_reader_action($version, 'cite');", { version }).collect(),
        ]);
        const articleRows = Array.isArray(articleResult[0]) ? articleResult[0] as Record<string, unknown>[] : [];
        page.articles = articleRows.flatMap((article) =>
          article.id && typeof article.label === "string" && typeof article.local_key === "string"
            && typeof article.body_text === "string"
            ? [{ id: String(article.id), label: article.label, localKey: article.local_key, bodyText: article.body_text }]
            : []);
        page.canCite = citeResult[0] === true;
        connection = next;
        return { ok: true, page };
      } catch {
        return { ok: false, reason: "content_unavailable" };
      } finally {
        if (connection !== next) await next.close().catch(() => undefined);
      }
    },
  };
}

export { isExchangeSuccess, isFailure };
