import type {
  ActivationMetric,
  ActivationSummaryV1,
  SharedActivationSummary,
} from "@surreal-ck/shared";
import { api as defaultApi } from "./api";
import type { SurrealConn } from "./surreal";

type CountRow = { count?: number };

export type ActivationSummaryEndpoint = {
  share(slug: string, summary: ActivationSummaryV1, idempotencyKey: string): Promise<Response>;
  withdraw(slug: string, idempotencyKey: string): Promise<Response>;
};

type HonoClient = {
  api: { workspaces: { ":slug": { "activation-summary": {
    $post(input: { param: { slug: string }; json: { summary: ActivationSummaryV1; idempotencyKey: string } }): Promise<Response>;
    $delete(input: { param: { slug: string }; json: { idempotencyKey: string } }): Promise<Response>;
  } } } };
};

export const activationSummaryEndpoint: ActivationSummaryEndpoint = {
  async share(slug, summary, idempotencyKey) {
    return await (defaultApi as unknown as HonoClient).api.workspaces[":slug"]["activation-summary"].$post({
      param: { slug }, json: { summary, idempotencyKey },
    });
  },
  async withdraw(slug, idempotencyKey) {
    return await (defaultApi as unknown as HonoClient).api.workspaces[":slug"]["activation-summary"].$delete({
      param: { slug }, json: { idempotencyKey },
    });
  },
};

function monthPeriod(now: Date, timeZone: string) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    startedAt: new Date(Date.UTC(year, month, 1)).toISOString(),
    endedAt: new Date(Date.UTC(year, month + 1, 1)).toISOString(),
    timeZone,
  };
}

async function countMetric(conn: SurrealConn, table: "user" | "workbook"): Promise<ActivationMetric> {
  try {
    const where = table === "user" ? " WHERE kind = 'human' AND disabled_at = NONE" : "";
    const rows = await conn.query<CountRow>(`SELECT count() AS count FROM ${table}${where} GROUP ALL;`);
    const count = rows[0]?.count ?? 0;
    return {
      state: count > 0 ? "completed" : "incomplete",
      count,
      source: table === "user" ? "workspace.user" : "workspace.workbook",
    };
  } catch {
    return {
      state: "failed",
      count: null,
      source: table === "user" ? "workspace.user" : "workspace.workbook",
    };
  }
}

export async function buildActivationSummaryPreview(
  conn: SurrealConn,
  now = new Date(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
): Promise<ActivationSummaryV1> {
  const period = monthPeriod(now, timeZone);
  const [members, workbooks] = await Promise.all([
    countMetric(conn, "user"),
    countMetric(conn, "workbook"),
  ]);
  const known = [members, workbooks];
  const stage = known.some((metric) => metric.state === "failed")
    ? "failed"
    : known.some((metric) => metric.state === "incomplete")
      ? "incomplete"
      : "activated";
  return {
    contractVersion: "1",
    period,
    stage,
    metrics: {
      members,
      workbooks,
      imports: { state: "unknown", count: null, source: "not_reported_v1" },
      reviews: { state: "unknown", count: null, source: "not_reported_v1" },
    },
    updatedAt: now.toISOString(),
    dedupeKey: `${period.startedAt.slice(0, 7)}:v1`,
  };
}

function message(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const error = (body as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string") return error.message;
  }
  return fallback;
}

export async function shareActivationSummary(
  slug: string,
  summary: ActivationSummaryV1,
  endpoint: ActivationSummaryEndpoint = activationSummaryEndpoint,
): Promise<{ ok: true; value: SharedActivationSummary } | { ok: false; message: string }> {
  const response = await endpoint.share(slug, summary, crypto.randomUUID());
  const body = await response.json().catch(() => null);
  return response.ok
    ? { ok: true, value: body as SharedActivationSummary }
    : { ok: false, message: message(body, "共享摘要失败") };
}

export async function withdrawActivationSummary(
  slug: string,
  endpoint: ActivationSummaryEndpoint = activationSummaryEndpoint,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const response = await endpoint.withdraw(slug, crypto.randomUUID());
  const body = await response.json().catch(() => null);
  return response.ok ? { ok: true } : { ok: false, message: message(body, "撤回摘要失败") };
}
