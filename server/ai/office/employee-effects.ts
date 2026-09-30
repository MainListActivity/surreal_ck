import { StringRecordId } from "surrealdb";
import type { TriggerSession } from "./employee-trigger-runtime";

/**
 * 幂等副作用账本（VER04）：每个有副作用的动作拿一个稳定 effect_key，
 * 落到 workspace database 的 employee_effect 表（员工 RECORD 会话写入）。
 *
 * 两段式：
 *   1. INSERT ... ON DUPLICATE KEY UPDATE 认领 effect_key；
 *      返回行已是 committed → 上次窗口已经完成该效果——直接回既有结果，
 *      不再执行 fn，绝不重复写入。
 *   2. 行 pending（新建或上次崩溃留下的半成品）→ 执行 fn → 置 committed
 *      并记录结果。fn 自身必须是幂等写（业务表唯一键/ON DUPLICATE），
 *      覆盖"效果已提交、committed 未落"的窄窗口。
 *
 * 崩溃窗口对照：Mastra snapshot 每步持久化；step 内 fn 提交与 snapshot
 * 更新之间死掉 → restart 重放该 step → 本函数读到 committed 行返回既有
 * 结果，业务写恰好一次。
 */
export type EmployeeEffects = {
  /**
   * key 由调用方从触发/逻辑动作派生（同一触发内稳定）。
   * fn 只应包含幂等的业务写；其结果对象会落入 employee_effect.result。
   */
  runEffect<T>(key: string, fn: () => Promise<T>): Promise<T>;
};

type EffectRow = { status?: unknown; result?: unknown };

export function createEmployeeEffects(session: TriggerSession, triggerId: string): EmployeeEffects {
  return {
    async runEffect<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const effectKey = `${triggerId}:${key}`;
      const [claimed] = await session.query<[EffectRow[]]>(
        `INSERT INTO employee_effect $content
         ON DUPLICATE KEY UPDATE effect_key = $input.effect_key
         RETURN AFTER;`,
        {
          content: {
            effect_key: effectKey,
            trigger: new StringRecordId(triggerId),
            status: "pending",
          },
        },
      );
      const row = claimed?.[0];
      if (row?.status === "committed") {
        // 结果统一包 {v}：基元与对象都能无损回放。
        return (row.result as { v?: T } | undefined)?.v as T;
      }

      const result = await fn();
      await session.query(
        `UPDATE employee_effect
         SET status = "committed", result = $result, updated_at = time::now()
         WHERE effect_key = $effectKey;`,
        { effectKey, result: { v: result ?? null } },
      );
      return result;
    },
  };
}
