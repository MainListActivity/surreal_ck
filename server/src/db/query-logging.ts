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

function shouldLogServerSurrealQueries(): boolean {
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
  instrumented.query = function queryWithLogging<T = unknown>(
    this: TClient,
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const realQuery = rawQuery.call(this, sql, params);
    return wrapQueryForLogging(realQuery, (run) => queryLogger(sql, params, run)) as Promise<T>;
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

type QueryExecutor = <T>(run: () => Promise<T>) => Promise<T>;

/**
 * query() 返回值必须对调用方透明：SDK 返回的是带 collect()/responses()/json()/retry()/
 * stream() 且可 await 的 Query（DispatchedPromise）。直接 await 成普通 Promise 会让
 * `.collect()` 等终结方法消失（生产曾因此 500）。这里用 Proxy 保留全部成员：
 * - then/catch/finally（await 语义）与 collect/responses（显式终结）：各执行一次并记日志；
 * - 其余方法透传；返回新 Query 的链式方法（json/retry 等）递归再包一层，日志不丢。
 * - .stream() 返回 AsyncIterable，原样透传（不记日志）。
 */
function wrapQueryForLogging(query: unknown, logExecution: QueryExecutor): unknown {
  if (query === null || (typeof query !== "object" && typeof query !== "function")) return query;
  const target = query as Record<PropertyKey, unknown>;
  return new Proxy(target, {
    get(t, prop) {
      if (prop === "then" || prop === "catch" || prop === "finally") {
        // await 触发 DispatchedPromise 单次 dispatch；日志记录同一次执行结果。
        const logged = logExecution(() => t as unknown as Promise<unknown>);
        const bound = (logged as unknown as Record<PropertyKey, (...args: unknown[]) => unknown>)[prop];
        return bound.bind(logged);
      }
      const value = Reflect.get(t, prop);
      if (typeof value !== "function") return value;
      if (prop === "collect" || prop === "responses") {
        return (...args: unknown[]) =>
          logExecution(() => (value as (...a: unknown[]) => Promise<unknown>).apply(t, args));
      }
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(t, args);
        return isQueryShaped(result) ? wrapQueryForLogging(result, logExecution) : result;
      };
    },
  });
}

function isQueryShaped(value: unknown): value is Record<PropertyKey, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<PropertyKey, unknown>).then === "function"
  );
}
