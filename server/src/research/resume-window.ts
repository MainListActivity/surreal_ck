import type { Surreal } from "surrealdb";
import { isRetryableTxnError } from "../ai-allowance/service";
import { HttpError } from "../http-error";

/** 原子抢占当前调用者的研究恢复窗口；进程重启后可恢复，旧 fence 不能释放新窗口。 */
export async function claimResumeWindow(session: Pick<Surreal, "query">, runId: string): Promise<() => Promise<void>> {
  const fence = crypto.randomUUID();
  const result = await session.query<[Array<{ resume_fence?: string }>]>(`
    UPDATE workflow_run SET resume_fence = $fence, resume_until = time::now() + 15m
    WHERE run_id = $runId AND workflow_name = "routerWorkflow"
      AND status INSIDE ["suspended", "success"]
      AND owner_user = fn::current_user()
      AND (SELECT VALUE disabled_at FROM ONLY fn::current_user()) = NONE
      AND (resume_until = NONE OR resume_until <= time::now()) RETURN id, resume_fence;`, { runId, fence }).catch((error: unknown) => {
    if (isRetryableTxnError(error)) throw new HttpError(409, "authorization_changed", "该运行正在恢复，请稍后重试或重新检索");
    throw error;
  });
  if (!Array.isArray(result[0]) || result[0][0]?.resume_fence !== fence) {
    // 不泄露其他 workspace/其他人的 run 是否存在。
    throw new HttpError(409, "authorization_changed", "当前授权或运行状态已变化，请重新检索或稍后重试");
  }
  return async () => {
    await session.query(`UPDATE workflow_run UNSET resume_fence, resume_until
      WHERE run_id = $runId AND owner_user = fn::current_user() AND resume_fence = $fence;`, { runId, fence });
  };
}
