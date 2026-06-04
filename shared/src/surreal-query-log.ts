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

const TRUE_FLAGS = new Set(["1", "true", "yes", "on"]);
const FALSE_FLAGS = new Set(["0", "false", "no", "off"]);

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
      log.info("[surrealdb:query]", {
        ...base,
        durationMs: Math.round(now() - startedAt),
      });
      return result;
    } catch (error) {
      log.warn("[surrealdb:query:error]", {
        ...base,
        durationMs: Math.round(now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}
