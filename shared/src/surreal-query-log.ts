export type SurrealQueryLogScope = {
  namespace?: string;
  database?: string;
  access?: string;
};

export type SurrealQueryLoggerOptions = {
  enabled: boolean;
  source: string;
  getScope?: () => SurrealQueryLogScope | undefined;
  logger?: Pick<Console, "info" | "warn">;
  now?: () => number;
};

export type SurrealQueryLogger = <T>(
  sql: string,
  params: Record<string, unknown> | undefined,
  run: () => Promise<T>,
) => Promise<T>;

type SurrealQueryResponseStatus = "OK" | "ERR";

type SurrealQueryResponseStatementLog = {
  index: number;
  status: SurrealQueryResponseStatus;
  error?: string;
};

type SurrealQueryErrorResponseLog =
  | {
      status: "ERR";
      statements: SurrealQueryResponseStatementLog[];
    }
  | {
      status: "THROWN";
    };

const TRUE_FLAGS = new Set(["1", "true", "yes", "on"]);
const FALSE_FLAGS = new Set(["0", "false", "no", "off"]);
const MAX_ERROR_DETAIL_LENGTH = 1_000;

export function shouldLogSurrealQueries(flag: string | boolean | undefined, defaultValue: boolean): boolean {
  if (typeof flag === "boolean") return flag;
  if (!flag) return defaultValue;

  const normalized = flag.trim().toLowerCase();
  if (TRUE_FLAGS.has(normalized)) return true;
  if (FALSE_FLAGS.has(normalized)) return false;
  return defaultValue;
}

export function normalizeSurrealQuery(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeResponseStatus(value: unknown): SurrealQueryResponseStatus | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  if (normalized === "OK") return "OK";
  if (normalized === "ERR" || normalized === "ERROR") return "ERR";
  return undefined;
}

function isSurrealQueryResponse(value: unknown): value is Record<string, unknown> & {
  status: string;
} {
  if (!isRecord(value) || normalizeResponseStatus(value.status) === undefined) return false;
  return "time" in value || "detail" in value || "error" in value;
}

function truncateErrorDetail(value: string): string {
  if (value.length <= MAX_ERROR_DETAIL_LENGTH) return value;
  return `${value.slice(0, MAX_ERROR_DETAIL_LENGTH)}...`;
}

function stringifyErrorDetail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return truncateErrorDetail(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (isRecord(value) && typeof value.message === "string") return truncateErrorDetail(value.message);

  try {
    const json = JSON.stringify(value);
    return json ? truncateErrorDetail(json) : undefined;
  } catch {
    return truncateErrorDetail(String(value));
  }
}

function responseErrorDetail(response: Record<string, unknown>): string | undefined {
  return (
    stringifyErrorDetail(response.error) ??
    stringifyErrorDetail(response.detail) ??
    stringifyErrorDetail(response.result)
  );
}

function summarizeErrorResponse(result: unknown): SurrealQueryErrorResponseLog | undefined {
  const values = Array.isArray(result) ? result : [result];
  const statements = values.flatMap((value, index): SurrealQueryResponseStatementLog[] => {
    if (!isSurrealQueryResponse(value)) return [];
    const status = normalizeResponseStatus(value.status);
    if (!status) return [];
    const statement: SurrealQueryResponseStatementLog = { index, status };
    if (status === "ERR") {
      const error = responseErrorDetail(value);
      if (error) statement.error = error;
    }
    return [statement];
  });

  if (!statements.some((statement) => statement.status === "ERR")) return undefined;
  return { status: "ERR", statements };
}

function firstResponseError(response: SurrealQueryErrorResponseLog): string | undefined {
  if (response.status !== "ERR") return undefined;
  return response.statements.find((statement) => statement.status === "ERR")?.error;
}

export function createSurrealQueryLogger(options: SurrealQueryLoggerOptions): SurrealQueryLogger {
  return async function logSurrealQuery<T>(
    sql: string,
    params: Record<string, unknown> | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    if (!options.enabled) return await run();

    const log = options.logger ?? console;
    const now = options.now ?? Date.now;
    const startedAt = now();
    const base = {
      source: options.source,
      scope: options.getScope?.(),
      sql: normalizeSurrealQuery(sql),
      params: params ?? {},
    };

    try {
      const result = await run();
      const response = summarizeErrorResponse(result);
      if (response) {
        log.warn("[surrealdb:query:error]", {
          ...base,
          durationMs: Math.round(now() - startedAt),
          response,
          error: firstResponseError(response) ?? "SurrealDB query returned an error status",
        });
      }
      return result;
    } catch (error) {
      log.warn("[surrealdb:query:error]", {
        ...base,
        durationMs: Math.round(now() - startedAt),
        response: { status: "THROWN" } satisfies SurrealQueryErrorResponseLog,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}
