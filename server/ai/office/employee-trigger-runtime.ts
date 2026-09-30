import { StringRecordId } from "surrealdb";

/**
 * 通用持久化触发 runtime（VER03）：领域中立地接管虚拟员工的"触发 → 执行窗口 → 结果"。
 *
 * - adapter 只负责把外部观察翻译成 TriggerDelivery（员工、原因、payload 引用、
 *   chain depth、幂等键）交给 enqueue()；runtime 负责 employee SIGNIN、把触发
 *   持久化到 workspace 内的 employee_trigger 表、跑岗位 handler、落结果、关会话。
 * - 触发记录由员工自己的 RECORD 会话写入（employee_trigger 只有 virtual 能建、
 *   employee = $auth 能改），root 不出现在这条路径上。
 * - 至少一次投递 + 幂等收敛：idempotency_key 唯一索引让重复投递撞到同一行；
 *   已 completed 的触发直接返回 coalesced，不再重跑 handler。
 * - 一个员工同一时刻只有一个执行窗口：同 (database, employeeId) 的 enqueue
 *   在进程内串行；窗口结束关闭该员工会话（session TTL 很短，不留隔夜连接）。
 * - 本模块不认识办公室领域表；领域读写全部发生在 adapter 注册的 handler 里。
 */

/** 执行窗口里的会话视图：handler 只能拿到这个窄接口做业务读写。 */
export type TriggerSession = {
  query<R extends unknown[] = unknown[]>(sql: string, params?: Record<string, unknown>): PromiseLike<R>;
};

/** 会话来源 seam：生产是 EmployeeRuntime，测试注入替身。 */
export type TriggerSessionManager = {
  openSession(database: string, employeeId: string): Promise<TriggerSession>;
  close(database: string, employeeId: string): Promise<void>;
};

export type TriggerDelivery = {
  /** 目标 workspace database 名。 */
  database: string;
  /** user record id（如 "user:ve_ab12…"）。 */
  employeeId: string;
  /** 触发原因；决定由哪个已注册 handler 执行。 */
  reason: string;
  /** 领域 payload 的引用（不复制大 payload 进触发记录）。 */
  payloadRef?: string;
  /** 触发链深度；顶层观察为 0，级联触发由 adapter 递增。 */
  chainDepth?: number;
  /** 幂等键：同一逻辑触发的重复投递必须撞同一个键。 */
  idempotencyKey: string;
};

export type TriggerEnvelope = {
  id: string;
  database: string;
  employeeId: string;
  reason: string;
  payloadRef: string | null;
  chainDepth: number;
  idempotencyKey: string;
};

export type TriggerHandlerContext = {
  trigger: TriggerEnvelope;
  /** 本员工的 RECORD 会话（employee access）——窗口内所有业务写必须经过它。 */
  session: TriggerSession;
};

export type TriggerHandler = (ctx: TriggerHandlerContext) => Promise<unknown>;

export type EnqueueResult =
  | { outcome: "completed"; triggerId: string }
  /** 同一幂等键已由先前投递完成：本次不重跑，不产生第二次用户可见结果。 */
  | { outcome: "coalesced"; triggerId: string }
  | { outcome: "failed"; triggerId?: string; error: string };

export type EmployeeTriggerRuntime = {
  /** 打开投递闸门（重复调用幂等）。 */
  start(): void;
  /** 注册某类 reason 的岗位实现；后注册覆盖先注册。 */
  registerHandler(reason: string, handler: TriggerHandler): void;
  /** 投递一条持久化触发并等待执行窗口结束。 */
  enqueue(delivery: TriggerDelivery): Promise<EnqueueResult>;
  /**
   * 关闭闸门并等待在途窗口排空：之后 enqueue 一律拒绝；
   * 窗口内打开的员工会话随窗口结束全部关闭。
   */
  stop(): Promise<void>;
};

type TriggerRow = { id?: unknown; status?: unknown; payload_ref?: unknown; chain_depth?: unknown };

function errorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.slice(0, 500);
}

/** handler 返回值落 result（option<object>）：非对象包一层，undefined 记 null。 */
function resultObject(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return { value: result ?? null };
}

export function createEmployeeTriggerRuntime(deps: {
  sessions: TriggerSessionManager;
}): EmployeeTriggerRuntime {
  const handlers = new Map<string, TriggerHandler>();
  /** (database, employeeId) → 串行链尾：保证每员工同时只有一个执行窗口。 */
  const chains = new Map<string, Promise<unknown>>();
  let started = false;

  function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (chains.get(key) ?? Promise.resolve()).then(work);
    const tracked = next.catch(() => undefined);
    chains.set(key, tracked);
    return next.finally(() => {
      if (chains.get(key) === tracked) chains.delete(key);
    });
  }

  async function persistTrigger(
    session: TriggerSession,
    delivery: TriggerDelivery,
  ): Promise<TriggerRow | null> {
    const content: Record<string, unknown> = {
      employee: new StringRecordId(delivery.employeeId),
      reason: delivery.reason,
      chain_depth: delivery.chainDepth ?? 0,
      idempotency_key: delivery.idempotencyKey,
      status: "pending",
    };
    // option 字段不能绑 JS null（引擎把 null 当 NULL 而非 NONE）；无引用时整段省略。
    if (delivery.payloadRef !== undefined) content.payload_ref = delivery.payloadRef;
    const [rows] = await session.query<[TriggerRow[]]>(
      `INSERT INTO employee_trigger $content
       ON DUPLICATE KEY UPDATE idempotency_key = $input.idempotency_key
       RETURN AFTER;`,
      { content },
    );
    return rows?.[0] ?? null;
  }

  async function setStatus(
    session: TriggerSession,
    triggerId: string,
    status: "running" | "completed" | "failed",
    extra: { result?: unknown; message?: string } = {},
  ): Promise<void> {
    const assignments = ["status = $status"];
    const params: Record<string, unknown> = { trigger: new StringRecordId(triggerId), status };
    if (status === "running") assignments.push("started_at = time::now()", "error_message = NONE");
    if (status === "completed") {
      assignments.push("completed_at = time::now()", "error_message = NONE", "result = $result");
      params.result = resultObject(extra.result);
    }
    if (status === "failed") {
      assignments.push("error_message = $message");
      params.message = extra.message ?? "unknown";
    }
    await session.query(`UPDATE $trigger SET ${assignments.join(", ")};`, params);
  }

  async function executeWindow(delivery: TriggerDelivery): Promise<EnqueueResult> {
    let session: TriggerSession;
    try {
      session = await deps.sessions.openSession(delivery.database, delivery.employeeId);
    } catch (cause) {
      // 员工暂停/退休或凭证缺失时连 SIGNIN 都过不去：触发不落库，返回失败由 adapter 决定。
      return { outcome: "failed", error: errorMessage(cause) };
    }
    let triggerId: string | undefined;
    try {
      const row = await persistTrigger(session, delivery);
      triggerId = row?.id == null ? undefined : String(row.id);
      if (!triggerId) throw new Error("employee-trigger-persist-failed");
      if (row?.status === "completed") return { outcome: "coalesced", triggerId };

      const handler = handlers.get(delivery.reason);
      if (!handler) throw new Error(`no-handler:${delivery.reason}`);
      const envelope: TriggerEnvelope = {
        id: triggerId,
        database: delivery.database,
        employeeId: delivery.employeeId,
        reason: delivery.reason,
        payloadRef: typeof row?.payload_ref === "string" ? row.payload_ref : null,
        chainDepth: typeof row?.chain_depth === "number" ? row.chain_depth : 0,
        idempotencyKey: delivery.idempotencyKey,
      };
      await setStatus(session, triggerId, "running");
      const result = await handler({ trigger: envelope, session });
      await setStatus(session, triggerId, "completed", { result });
      return { outcome: "completed", triggerId };
    } catch (cause) {
      const error = errorMessage(cause);
      if (triggerId) {
        await setStatus(session, triggerId, "failed", { message: error }).catch(() => undefined);
      }
      console.error("[employee-trigger] window failed", {
        database: delivery.database,
        employeeId: delivery.employeeId,
        reason: delivery.reason,
        idempotencyKey: delivery.idempotencyKey,
        message: error,
      });
      return { outcome: "failed", ...(triggerId ? { triggerId } : {}), error };
    } finally {
      await deps.sessions.close(delivery.database, delivery.employeeId).catch(() => undefined);
    }
  }

  return {
    start() {
      started = true;
    },

    registerHandler(reason, handler) {
      handlers.set(reason, handler);
    },

    enqueue(delivery) {
      if (!started) return Promise.reject(new Error("employee-trigger-runtime-stopped"));
      return serialized(`${delivery.database}::${delivery.employeeId}`, () => {
        if (!started) throw new Error("employee-trigger-runtime-stopped");
        return executeWindow(delivery);
      });
    },

    async stop() {
      started = false;
      await Promise.allSettled([...chains.values()]);
    },
  };
}
