import type { AiAllowanceService, ReservationRow } from "./service";

export type AiAllowanceOpsStatus = {
  consumableAllowance: number | null;
  reserved: number | null;
  settled: number | null;
  suspended: number | null;
  terminated: number | null;
  expired: number | null;
  stuckReservations: number | null;
  settlementAnomaly: boolean;
  anomalyNote: string | null;
};

/** 账本无桶或读不到时的返回值（不把「无账本」当作零余额或异常）。 */
export const EMPTY_AI_STATUS: AiAllowanceOpsStatus = {
  consumableAllowance: null,
  reserved: null,
  settled: null,
  suspended: null,
  terminated: null,
  expired: null,
  stuckReservations: null,
  settlementAnomaly: false,
  anomalyNote: null,
};

/**
 * LCA13 运营解释：AI 预留/结算状态与结算异常判定。
 * - 金额口径与 balance() 一致（到期/终止/暂停桶不进可消费）。
 * - 结算异常只认「预留已过结算窗口仍未终态」（sweep 未收敛或结算链路卡死）；
 *   合法 over_limit 与自然到期不是异常，不在这里标记。
 */
export function createAiAllowanceOpsStatus(service: AiAllowanceService): (dbName: string) => Promise<AiAllowanceOpsStatus> {
  return async (dbName: string): Promise<AiAllowanceOpsStatus> => {
    let balance;
    try {
      balance = await service.balance(dbName);
    } catch {
      return EMPTY_AI_STATUS;
    }
    let stuck: ReservationRow[] = [];
    try {
      stuck = await service.stuckReservations(dbName);
    } catch {
      stuck = [];
    }
    const settled = balance.buckets.reduce((sum, bucket) => sum + (typeof bucket.settled === "number" ? bucket.settled : 0), 0);
    const anomaly = stuck.length > 0;
    return {
      consumableAllowance: balance.available,
      reserved: balance.reserved,
      settled,
      suspended: balance.suspended,
      terminated: balance.terminated,
      expired: balance.expired,
      stuckReservations: stuck.length,
      settlementAnomaly: anomaly,
      anomalyNote: anomaly
        ? `${stuck.length} 条预留超过结算窗口仍未终态（run=${stuck.map((row) => (typeof row.run_id === "string" ? row.run_id : "无 run")).slice(0, 3).join(",")}）`
        : null,
    };
  };
}
