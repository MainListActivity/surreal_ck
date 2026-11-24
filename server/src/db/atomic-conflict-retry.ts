import { extractNativeQuotaError } from "@surreal-ck/shared/native-quota";
import { isRetryableConflict, QueryError } from "surrealdb";

export function isAtomicConflict(error: unknown): boolean {
  const quota = extractNativeQuotaError(error);
  if (quota) return quota.code === "quota_conflict" && quota.retryable;
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    if (isRetryableConflict(error)) return true;
    if (error instanceof QueryError && /^(?:Cannot COMMIT: |There was a problem with the key-value store: )?Transaction conflict:[\s\S]+ This transaction can be retried$/.test(error.message)) return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

/** 只重试明确已回滚的单条语句或整笔事务。 */
export async function retryAtomicConflict<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isAtomicConflict(error) || attempt >= 24) throw error;
      await Bun.sleep(Math.min(500, 10 * 2 ** (attempt - 1)) * (0.5 + Math.random()));
    }
  }
}
