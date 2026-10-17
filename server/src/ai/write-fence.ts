/**
 * 提案确认写栅栏（PG-1 生产实测阻断缺陷修复）。
 *
 * 缺陷：AI 提案卡的确认写是「浏览器直连写 + resume」，写栅栏只是卡片实例的内存标志
 * （writeCommitted）。run 终态 success 后，另一标签页恢复出的同 run 暂停卡二次确认时
 * 该标志不可见，于是真实写入了业务行；resume 对已 complete 的 run 还幂等「成功」，
 * 前端看不到任何拒绝。
 *
 * 修法：把「run 的哪一次 suspend 已被消费」落到服务端持久行（chat_write_fence），
 * 确认写与消费在**同一个事务**里原子判定：
 * - 事务开始先把目标 suspend 行消费掉（`UPDATE … WHERE status = "pending"`）；
 *   命中为 0 行即说明已消费或 run 已终态 → 回滚（零写入）并具名拒绝。
 * - 命中才继续业务写；业务写失败 → 回滚，消费一并撤销，语义仍是 pending 可重试。
 *
 * 身份边界不变：全程用调用者 OIDC 会话执行，PERMISSIONS 由表定义兜底，
 * **不存在 root / service 会话替写**；事务只在调用者自己的连接上开。
 *
 * 消费与写的一致性依赖「同一事务」：本地 fork（3.3.0-nightly，1171dd01）上实测
 * `beginTransaction()` + 语句错误后 `cancel()` 会完整回滚事务内已执行的 UPDATE。
 */

import type { Surreal, SurrealTransaction } from "surrealdb";
import { StringRecordId } from "surrealdb";
import {
  CHAT_WRITE_FENCE_ERRORS,
  chatWriteFenceMessage,
  suspendPathKeyFromState,
  type ChatWriteFenceErrorCode,
} from "@surreal-ck/shared";
import { HttpError } from "../http-error";

export { CHAT_WRITE_FENCE_ERRORS };

/** 调用者会话上够用的事务切面；便于单测注入桩。 */
export type FenceSession = Pick<Surreal, "query" | "beginTransaction">;

export type SuspendFenceKind =
  | "await-write-confirm"
  | "ambiguous"
  | "resource-candidates"
  | "manual-research"
  | "authorization_changed";

export type SuspendFenceRow = {
  run_id: string;
  suspend_path: string;
  suspend_kind: string;
  status: "pending" | "consumed" | "abandoned";
  consumed_at?: string | null;
  consumed_by?: string | null;
};

type WorkflowRunStatusRow = { status?: unknown; state?: unknown };

function firstRow<T>(result: unknown): T | undefined {
  const first = Array.isArray(result) ? result[0] : undefined;
  return Array.isArray(first) ? (first[0] as T | undefined) : undefined;
}

/** 栅栏拒绝 → 具名 409（带稳定 code，前端可据此给固定文案，绝不静默成功）。 */
export function fenceRejected(code: ChatWriteFenceErrorCode): HttpError {
  return new HttpError(409, code, chatWriteFenceMessage(code) ?? "这项确认已失效，本次没有写入任何数据。");
}

/**
 * 为一次 suspend 建（幂等重建）pending 栅栏行。
 *
 * 由 workflow 在每次 suspend 前调用：`ON DUPLICATE KEY UPDATE` 命中已消费行时**不改回
 * pending**——已消费的 suspend 不可复活，否则第二标签页的迟到 suspend 事件能把栅栏重开。
 * 同一次 suspend 从 stream 与持久态各来一次时键恒等，天然收敛成一行。
 */
export async function registerSuspendFence(
  session: Pick<Surreal, "query">,
  input: { runId: string; suspendKey: string; kind: SuspendFenceKind; payload?: unknown },
): Promise<void> {
  const content = {
    run_id: input.runId,
    suspend_path: input.suspendKey,
    suspend_kind: input.kind,
    status: "pending",
    ...(input.payload !== undefined ? { suspend_payload: input.payload } : {}),
  };
  await session.query(
    `INSERT INTO chat_write_fence $content ON DUPLICATE KEY UPDATE
       suspend_kind = IF status = "pending" THEN $content.suspend_kind ELSE suspend_kind,
       suspend_payload = IF status = "pending" AND $content.suspend_payload != NONE
         THEN $content.suspend_payload ELSE suspend_payload,
       updated_at = IF status = "pending" THEN time::now() ELSE updated_at;`,
    { content },
  );
}

/** run 的当前状态与 suspend 路径键（recover / resume 判定共用）。 */
export async function loadRunFenceState(
  session: Pick<Surreal, "query">,
  runId: string,
): Promise<{ status: string; suspendKey: string } | undefined> {
  const row = firstRow<WorkflowRunStatusRow>(await session.query(
    `SELECT status, state FROM workflow_run WHERE run_id = $runId AND workflow_name = "routerWorkflow"
      AND owner_user = fn::current_user()
      AND (SELECT VALUE disabled_at FROM ONLY fn::current_user()) = NONE LIMIT 1`,
    { runId },
  ));
  if (!row) return undefined;
  const status = typeof row.status === "string" ? row.status : "";
  return { status, suspendKey: suspendPathKeyFromState({ state: row.state }) };
}

/** 该 run 是否已到终态（success / failed / cancelled / done）：终态后一切确认拒绝。 */
export function isRunTerminal(status: string): boolean {
  return status === "success" || status === "done" || status === "failed" || status === "cancelled" || status === "canceled";
}

/**
 * 事务内消费一次 suspend：只有仍 pending 的那一行会被原子置为 consumed。
 *
 * - 命中 1 行：该 suspend 的首次消费，继续走 `work`。
 * - 命中 0 行：要么已消费、要么根本没有——都回滚并按 run 状态给出具名拒绝，
 *   **不写任何业务数据**。
 * - `work` 抛错（业务写失败 / PERMISSIONS 拒绝 / 引擎错误）：事务回滚，
 *   消费随之撤销，下次确认仍是 pending，可重试。
 */
export async function consumeSuspendAndWrite<T>(
  session: FenceSession,
  input: {
    runId: string;
    suspendKey: string;
    decision: string;
    runStatus: string;
    /** 事务内的业务写；抛错即整体回滚。 */
    work: (tx: SurrealTransaction) => Promise<T>;
  },
): Promise<T> {
  const tx = await session.beginTransaction();
  try {
    const consumed = firstRow<{ suspend_path?: unknown }>(await tx.query(
      `UPDATE chat_write_fence SET status = "consumed", consumed_at = time::now(),
         consumed_by = $decision, updated_at = time::now()
       WHERE run_id = $runId AND suspend_path = $suspendKey AND owner_user = fn::current_user()
         AND status = "pending" RETURN AFTER;`,
      { runId: input.runId, suspendKey: input.suspendKey, decision: input.decision },
    ));
    if (!consumed) {
      // 已消费或不存在：本次零写入、零状态推进。
      await tx.cancel();
      throw input.runStatus && isRunTerminal(input.runStatus)
        ? fenceRejected(CHAT_WRITE_FENCE_ERRORS.runEnded)
        : fenceRejected(CHAT_WRITE_FENCE_ERRORS.consumed);
    }
    const result = await input.work(tx);
    await tx.commit();
    return result;
  } catch (error) {
    try {
      await tx.cancel();
    } catch {
      // 回滚失败不得覆盖业务错误（消费未提交即已不安全，原错误更有诊断价值）。
    }
    throw error;
  }
}

/** resume 前的具名判定：run 已终态 / 该 suspend 已消费 / 仍 pending 三选一。 */
export async function assertResumeAllowed(
  session: Pick<Surreal, "query">,
  input: { runId: string; suspendKey: string },
): Promise<void> {
  const rows = firstRow<{ status?: unknown }>(await session.query(
    `SELECT status FROM chat_write_fence WHERE run_id = $runId AND suspend_path = $suspendKey
      AND owner_user = fn::current_user() LIMIT 1;`,
    { runId: input.runId, suspendKey: input.suspendKey },
  ));
  if (rows) {
    if (rows.status !== "pending") throw fenceRejected(CHAT_WRITE_FENCE_ERRORS.consumed);
    return;
  }
  // 老 run（栅栏行是本次发布后才有）：回落到 run 状态判定，终态同样具名拒绝。
  const state = await loadRunFenceState(session, input.runId);
  if (state && isRunTerminal(state.status)) throw fenceRejected(CHAT_WRITE_FENCE_ERRORS.runEnded);
}

/** 写端点解析目标记录：提案的 recordId 是 `table:id` 字符串，在 SDK 边界包成 RecordId。 */
export function proposalRecordId(recordId: string): StringRecordId {
  return new StringRecordId(recordId);
}
