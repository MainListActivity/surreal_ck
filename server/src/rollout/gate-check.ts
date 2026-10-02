import type { RolloutGateKey, RolloutGateState } from "@surreal-ck/shared";
import { getRootDatabaseSession } from "../db/root-connection";
import { env } from "../env";

type Queryable = { query(sql: string, params?: Record<string, unknown>): Promise<unknown> };

/**
 * 运行时开关检查：workspace 库名 + gate → 当前状态。
 * 无开关行 = "enabled"（缺省不收紧）；查询失败向上抛——调用方把读失败
 * 归一为自身 503，不做任何缓存（保证关断即时生效，不留失效缓存窗口）。
 */
export type RolloutGateChecker = (workspaceDb: string, gate: RolloutGateKey) => Promise<RolloutGateState>;

export function createRolloutGateChecker(deps: {
  getSystemDb?: () => Promise<Queryable>;
} = {}): RolloutGateChecker {
  const getSystemDb = deps.getSystemDb ?? (() => getRootDatabaseSession("_system", env.SURREAL_NS));
  return async (workspaceDb, gate) => {
    const result = await (await getSystemDb()).query(
      `SELECT VALUE state FROM workspace_rollout_gate
        WHERE gate = $gate
          AND workspace IN (SELECT VALUE id FROM workspace WHERE db_name = $db)
        LIMIT 1;`,
      { gate, db: workspaceDb },
    );
    const statement = Array.isArray(result) ? result[0] : result;
    const value = Array.isArray(statement) ? statement[0] : statement;
    return value === "disabled" ? "disabled" : "enabled";
  };
}
