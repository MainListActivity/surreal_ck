import { Surreal } from "surrealdb";

export type CreateCallerSessionOptions = {
  /** SurrealDB RPC 地址；默认取 env.SURREAL_URL。 */
  surrealUrl?: string;
  /** 注入点（测试用）：构造一个 Surreal 客户端。 */
  newSurreal?: () => Surreal;
};

/**
 * 用调用者的 OIDC token 在 SurrealDB 上建立一条会话。
 *
 * token 里带 `https://surrealdb.com/db` / `https://surrealdb.com/ac` scope claim，
 * DB 引擎的 admin / participant access (TYPE JWT / RECORD WITH JWT) 在 authenticate 时校验并把
 * 会话落到目标 database —— 所以这里**只** connect + authenticate，不需要再 use()。
 *
 * authenticate 失败（db 不存在 / scope 不匹配触发 AUTHENTICATE THROW）会向上抛，
 * 由 /api/chat 路由翻译成 403。**不存在 root / service 兜底。**
 */
export async function createCallerSession(
  rawToken: string,
  options: CreateCallerSessionOptions = {},
): Promise<Surreal> {
  const url = options.surrealUrl ?? (await import("../env")).env.SURREAL_URL;
  const db = options.newSurreal ? options.newSurreal() : new Surreal();

  await db.connect(url, { reconnect: false });
  await db.authenticate(rawToken);
  return db;
}
