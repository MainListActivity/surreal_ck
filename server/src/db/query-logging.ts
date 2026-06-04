import {
  createSurrealQueryLogger,
  shouldLogSurrealQueries,
  type SurrealQueryLogScope,
} from "@surreal-ck/shared/surreal-query-log";
import { env } from "../env";

type QueryableSurreal = {
  query<T = unknown>(sql: string, params?: Record<string, unknown>): Promise<T>;
  use?(scope?: { namespace?: string; database?: string }): Promise<unknown>;
};

const INSTRUMENTED = Symbol("surreal-ck.query-logging");

type InstrumentedSurreal = QueryableSurreal & {
  [INSTRUMENTED]?: true;
};

export type SurrealQueryLoggingOptions = {
  source: string;
  initialScope?: SurrealQueryLogScope;
  enabled?: boolean;
};

export function shouldLogServerSurrealQueries(): boolean {
  return shouldLogSurrealQueries(env.SURREAL_LOG_QUERIES, env.NODE_ENV === "development");
}

export function instrumentSurrealQuery<TClient extends QueryableSurreal>(
  client: TClient,
  options: SurrealQueryLoggingOptions,
): TClient {
  const instrumented = client as InstrumentedSurreal;
  if (instrumented[INSTRUMENTED]) return client;

  const enabled = options.enabled ?? shouldLogServerSurrealQueries();
  if (!enabled) return client;

  const scope: SurrealQueryLogScope = { ...options.initialScope };
  const queryLogger = createSurrealQueryLogger({
    enabled,
    source: options.source,
    getScope: () => ({ ...scope }),
  });

  const rawQuery = client.query;
  instrumented.query = async function queryWithLogging<T = unknown>(
    this: TClient,
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    return await queryLogger(sql, params, () => rawQuery.call(this, sql, params) as Promise<T>);
  };

  if (client.use) {
    const rawUse = client.use;
    instrumented.use = async function useWithScopeLogging(
      this: TClient,
      nextScope?: { namespace?: string; database?: string },
    ): Promise<unknown> {
      const result = await rawUse.call(this, nextScope);
      if (nextScope?.namespace !== undefined) scope.namespace = nextScope.namespace;
      if (nextScope?.database !== undefined) scope.database = nextScope.database;
      return result;
    };
  }

  instrumented[INSTRUMENTED] = true;
  return client;
}
