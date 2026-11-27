import { expect, mock, spyOn, test } from "bun:test";
import { DateTime, QueryError } from "surrealdb";
import { SurrealQuotaControlPlaneStore } from "./control-plane-store";

const now = new DateTime("2026-11-27T00:00:00Z");
const claimInput = {
  name: "native_audit_sweep",
  workerId: "fixture:native-audit",
  now,
  leaseDurationMs: 60_000,
} as const;

function commitConflict() {
  return new QueryError({
    kind: "Query",
    message: "Cannot COMMIT: Transaction conflict: fixture!qm. This transaction can be retried",
  });
}

test("认领游标在 RocksDB 提交冲突后重试整笔事务并返回成功的 lease", async () => {
  const leaseExpiresAt = new DateTime("2026-11-27T00:01:00Z");
  let attempts = 0;
  const query = mock(async <T = unknown>(sql: string, params?: Record<string, unknown>): Promise<T> => {
    expect(sql).toContain("BEGIN TRANSACTION;");
    expect(sql).toContain("COMMIT TRANSACTION;");
    expect(params).toEqual({
      name: claimInput.name,
      worker: claimInput.workerId,
      now,
      leaseExpiresAt,
    });
    if (++attempts <= 2) throw commitConflict();
    return [null, [], null, {
      fencing_token: 5,
      epoch: 2,
      attempt_count: 1,
      cursor: "workspace:previous",
      last_started_at: now,
      lease_expires_at: leaseExpiresAt,
    }] as T;
  });

  await expect(new SurrealQuotaControlPlaneStore({ query }).claimSweep(claimInput)).resolves.toEqual({
    name: claimInput.name,
    workerId: claimInput.workerId,
    fencingToken: 5,
    epoch: 2,
    attemptNumber: 1,
    cursor: "workspace:previous",
    startedAt: now,
    leaseExpiresAt,
  });
  expect(query).toHaveBeenCalledTimes(3);
});

test("连续提交冲突耗尽上限后抛出原始错误", async () => {
  const error = commitConflict();
  const query = mock(async () => { throw error; });
  const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
  try {
    await expect(new SurrealQuotaControlPlaneStore({ query }).claimSweep(claimInput)).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(24);
    expect(sleep).toHaveBeenCalledTimes(23);
  } finally {
    sleep.mockRestore();
  }
});

test("提交结果未知时向调用方抛出原始连接错误", async () => {
  const error = new Error("connection closed while waiting for COMMIT response");
  const query = mock(async () => { throw error; });
  await expect(new SurrealQuotaControlPlaneStore({ query }).claimSweep(claimInput)).rejects.toBe(error);
  expect(query).toHaveBeenCalledTimes(1);
});
