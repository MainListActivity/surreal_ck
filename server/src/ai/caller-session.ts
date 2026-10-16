import { Surreal } from "surrealdb";
import { instrumentSurrealQuery } from "../db/query-logging";
import {
  AiCallerQueryTimeoutError,
  AiRunCancelledError,
  createRunDiagnostics,
  type RunDiagnostics,
  type RunDiagnosticsConfig,
  type RunOpPhase,
} from "./run-diagnostics";

export type CreateCallerSessionOptions = {
  /** SurrealDB RPC 地址；默认取 env.SURREAL_URL。 */
  surrealUrl?: string;
  /** 注入点（测试用）：构造一个 Surreal 客户端。 */
  newSurreal?: () => Surreal;
  /** 注入既有诊断器（测试/复用路径）；缺省为本会话新建。 */
  diagnostics?: RunDiagnostics;
  /** 覆盖各阶段默认超时；值必须是正数有界值。 */
  timeouts?: RunDiagnosticsConfig;
};

const DIAGNOSTICS_KEY = Symbol("surreal-ck.caller-diagnostics");
const DIAG_QUERY_KEY = Symbol("surreal-ck.caller-diag-query");

type SessionCarrier = Record<symbol, unknown>;
type DiagQuery = (sql: string, params: Record<string, unknown> | undefined, phase: RunOpPhase) => unknown;

/** 取挂在 caller session 上的 run 诊断器（未接入诊断的会话返回 undefined）。 */
export function callerRunDiagnostics(session: unknown): RunDiagnostics | undefined {
  if (session === null || (typeof session !== "object" && typeof session !== "function")) {
    return undefined;
  }
  return (session as SessionCarrier)[DIAGNOSTICS_KEY] as RunDiagnostics | undefined;
}

/** 测试/装配注入：把诊断器挂到既成会话（含桩会话）上。 */
export function attachRunDiagnostics(session: Surreal, diag: RunDiagnostics): Surreal {
  (session as unknown as SessionCarrier)[DIAGNOSTICS_KEY] = diag;
  return session;
}

/**
 * 本会话某类后续 query 的「阶段视图」：view.query(...) 记录为指定 phase。
 * persist（workflow 存储 / delivery 写入）在 run 取消后仍可派发，
 * 业务 query/tool 则在取消后一律拒绝——挡住迟到写入。
 */
export function sessionForPhase(session: Surreal, phase: RunOpPhase): Surreal {
  return new Proxy(session, {
    get(target, prop, receiver) {
      if (prop === DIAGNOSTICS_KEY) return (target as unknown as SessionCarrier)[DIAGNOSTICS_KEY];
      if (prop === "query") {
        const diagQuery = (target as unknown as SessionCarrier)[DIAG_QUERY_KEY] as DiagQuery | undefined;
        if (diagQuery) {
          return (sql: string, params?: Record<string, unknown>) => diagQuery(sql, params, phase);
        }
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** 从 SurrealQL 文本取首个关键字作为脱敏操作名（不落 SQL 原文）。 */
function statementKind(sql: string): string {
  const first = sql.trimStart().split(/[\s(]+/, 1)[0] ?? "";
  return first ? first.toUpperCase() : "QUERY";
}

/** 绑定参数只取键名列表——值永远不落诊断。 */
function paramKeys(params: unknown): string[] | undefined {
  if (!params || typeof params !== "object") return undefined;
  const keys = Object.keys(params);
  keys.sort();
  return keys.length > 0 ? keys : undefined;
}

/**
 * query() 返回 Surreal SDK 的 Query（thenable + collect/responses/stream/retry），
 * 直接 await 成普通 Promise 会让终结方法消失（生产曾因此 500）。用 Proxy 保留成员：
 * then/catch/finally/collect/responses/json 各走一次有界执行；其余方法透传。
 */
function wrapQueryForDiagnostics(
  query: unknown,
  execute: (inner: PromiseLike<unknown>) => Promise<unknown>,
  onResultProcessing?: () => void,
): unknown {
  if (query === null || (typeof query !== "object" && typeof query !== "function")) return query;
  const target = query as Record<PropertyKey, unknown>;
  // then/catch/finally 必须挂到「有界结果」上而不是原始 thenable：
  // await proxy 会把内部 resolve/reject 传进 .then，直接代理 inner.then 会让
  // awaiter 在 inner settle 时就放行——超时/取消判定形同虚设。
  let boundedOnce: Promise<unknown> | undefined;
  const bounded = () => (boundedOnce ??= execute(Promise.resolve(target as unknown as PromiseLike<unknown>)));
  return new Proxy(target, {
    get(t, prop) {
      const value = Reflect.get(t, prop);
      if (prop === "then" || prop === "catch" || prop === "finally") {
        const promise = bounded() as unknown as Record<PropertyKey, (...a: unknown[]) => unknown>;
        return promise[prop].bind(promise);
      }
      if (typeof value !== "function") return value;
      if (prop === "collect" || prop === "responses" || prop === "json") {
        return (...args: unknown[]) => {
          // collect/responses/json 是对已返回响应做整形——如实把 op 迁到 result-processing。
          onResultProcessing?.();
          return execute(Promise.resolve((value as (...a: unknown[]) => unknown).apply(t, args)));
        };
      }
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(t, args);
        // 返回新 Query 的链式方法（retry 等）递归再包一层，诊断不丢。
        return isThenable(result) ? wrapQueryForDiagnostics(result, execute, onResultProcessing) : result;
      };
    },
  });
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<PropertyKey, unknown>).then === "function"
  );
}

/**
 * 给 caller session 的 query 挂 PG-1 诊断：阶段记账 + 单次有界上界 +
 * run 取消联动 + 取消后拒绝派发非 persist 查询。
 */
function instrumentSessionDiagnostics(db: Surreal, diag: RunDiagnostics): void {
  const carrier = db as unknown as SessionCarrier;
  carrier[DIAGNOSTICS_KEY] = diag;
  const raw = db.query;
  // 无 query 的桩会话（单测）：只挂诊断器，不包装。
  if (typeof raw !== "function") return;
  const rawQuery = raw.bind(db) as (sql: string, params?: Record<string, unknown>) => Promise<unknown>;

  const queryWithDiagnostics: DiagQuery = (sql, params, phase) => {
    if (diag.aborted && phase !== "persist") {
      // run 已取消：新查询不再派发，直接按取消记账并拒绝（保护迟到 tool 写入）。
      const op = diag.begin({ name: statementKind(sql), phase, argShape: paramKeys(params) });
      diag.end(op, "cancelled", new AiRunCancelledError());
      return Promise.reject(new AiRunCancelledError());
    }
    const op = diag.begin({ name: statementKind(sql), phase, argShape: paramKeys(params) });
    const inner = rawQuery(sql, params) as PromiseLike<unknown>;
    const isPersist = phase === "persist";
    return wrapQueryForDiagnostics(inner, (terminal) =>
      diag.trackOp(op, terminal, {
        // persist 终态写从派发时刻起算固定有界预算：它恰恰在 run deadline
        // 用尽之后执行，再 min(剩余期限) 会压到 ~0 必超时（验收退回的真实缺陷）。
        timeoutMs: isPersist ? diag.config.queryTimeoutMs : diag.effectiveMs(diag.config.queryTimeoutMs),
        // SDK 无 query 级取消：业务查询超时后关闭本 run 独占的连接，迟到 settle 由 mask 吞掉。
        // persist 不关——终态链上后续写（status/额度/诊断快照）还在复用这条连接。
        ...(isPersist ? {} : { onTimeout: () => void closeQuietly(db) }),
        // persist 不随 run 信号取消；其超时也不置 run 级 fatal——清理失败不得
        // 覆盖业务终态的稳定错误名。
        skipRunSignal: isPersist,
        suppressFatal: isPersist,
        timeoutError: () => new AiCallerQueryTimeoutError("query"),
        abortedError: () => new AiRunCancelledError(),
      }),
      () => diag.markPhase(op, "result-processing"),
    );
  };

  carrier[DIAG_QUERY_KEY] = queryWithDiagnostics;
  db.query = ((sql: string, params?: Record<string, unknown>) =>
    queryWithDiagnostics(sql, params, "query")) as Surreal["query"];
}

/**
 * 用调用者的 OIDC token 在 SurrealDB 上建立一条会话。
 *
 * token 里带 `db` / `ac` scope claim，
 * DB 引擎的 admin / participant access (TYPE JWT / RECORD WITH JWT) 在 authenticate 时校验并把
 * 会话落到目标 database —— 所以这里**只** connect + authenticate，不需要再 use()。
 *
 * authenticate 失败（db 不存在 / scope 不匹配触发 AUTHENTICATE THROW）会向上抛，
 * 由 /api/chat 路由翻译成 403。**不存在 root / service 兜底。**
 *
 * PG-1：connect/authenticate/query 均有界（单次默认 30s，且不超过 run 剩余期限），
 * 操作流水记入 run 诊断器（callerRunDiagnostics 读取）。
 */
/** 超时后尽力关连接：桩会话可能没有 close，原错误仍由超时抛出。 */
function closeQuietly(db: Surreal): Promise<unknown> | undefined {
  const close = (db as { close?: () => Promise<unknown> }).close;
  return typeof close === "function" ? close.call(db).catch(() => undefined) : undefined;
}

export async function createCallerSession(
  rawToken: string,
  options: CreateCallerSessionOptions = {},
): Promise<Surreal> {
  const url = options.surrealUrl ?? (await import("../env")).env.SURREAL_URL;
  const db = options.newSurreal ? options.newSurreal() : new Surreal();
  const diag = options.diagnostics ?? createRunDiagnostics(options.timeouts);
  const connectBound = () => ({
    timeoutMs: diag.effectiveMs(diag.config.connectTimeoutMs),
    timeoutError: () => new AiCallerQueryTimeoutError("connect"),
    abortedError: () => new AiRunCancelledError(),
    onTimeout: () => void closeQuietly(db),
  });

  await diag.track({ name: "connect", phase: "connect" }, db.connect(url, { reconnect: false }), connectBound());
  await diag.track({ name: "authenticate", phase: "connect" }, db.authenticate(rawToken), connectBound());

  instrumentSessionDiagnostics(db, diag);
  return instrumentSurrealQuery(db, { source: "server:caller-session" });
}
