import type { ConnectionStatus, LiveMessage, SurrealConn } from "./surreal";
import {
  normalizeEmployee,
  normalizeMessage,
  normalizeNotification,
  normalizeOfficeMeta,
  normalizeReport,
  normalizeTask,
  projectActivity,
  type OfficeActivityItem,
  type OfficeEmployee,
  type OfficeMessage,
  type OfficeMeta,
  type OfficeNotification,
  type OfficeReport,
  type OfficeRow,
  type OfficeTask,
} from "./office-data";

/**
 * OfficeDataRuntime（VO04 深模块）：办公室页面的唯一数据执行体。
 *
 * 职责边界——调用方（OfficeScreen）只声明"打开办公室页面"，以下全部留在
 * Implementation 内：
 * - 初始快照 + 缓冲 LIVE：先建立订阅再查快照，快照完成前到达的 LIVE 事件
 *   先缓冲后按 id upsert 合并；不丢事件、不重复记录，也绝不把"订阅建立时刻"
 *   当成数据库真相（快照查询才是权威窗口，缓冲在快照后重放一次幂等合并）。
 * - RecordId 转换：内存与 UI 层只持有 `table:id` 字符串（规整见 office-data.ts），
 *   写入边界用 SDK 的 RecordId 包装（见 resolveNotification → updateRecord）。
 * - 重连：订阅 driver 的 connected / reconnecting / disconnected 事件；
 *   断线自动重连成功后全量重查一次，消除断口缺口；重查期间事件继续缓冲。
 * - workspace 切换 / 卸载：close() 幂等，退订全部 LIVE 与状态监听；关闭后
 *   迟到的旧 database 事件被直接丢弃，无法污染新 workspace 的 runtime。
 * - 更新操作：通知解决走当前浏览器 SurrealDB 封装（updateRecord + RecordId）；
 *   员工生命周期走既有后端 lifecycle endpoint（VER02），不新增 office CRUD /
 *   LIVE 代理。
 */

export type OfficeRuntimeStatus = "opening" | "ready" | "error" | "closed";
export type { ConnectionStatus as OfficeConnectionStatus };

export type OfficeRuntimeError = {
  code: "closed" | "unavailable" | "permission-denied" | "unexpected";
  message: string;
  retryable: boolean;
};

export type OfficeSnapshot = {
  status: OfficeRuntimeStatus;
  connection: ConnectionStatus;
  refreshing: boolean;
  meta: OfficeMeta | null;
  /** 花名册：真人 + 虚拟员工（虚拟员工含生命周期状态）。 */
  employees: OfficeEmployee[];
  tasks: OfficeTask[];
  messages: OfficeMessage[];
  reports: OfficeReport[];
  notifications: OfficeNotification[];
  activity: OfficeActivityItem[];
  error: OfficeRuntimeError | null;
};

export type OfficeLifecycleAction = "pause" | "resume" | "retire";

export type OfficeEmployeeStatus = OfficeEmployee["status"];

export type OfficeActionResult =
  | { ok: true; status?: OfficeEmployeeStatus }
  | { ok: false; message: string };

/**
 * 生命周期动作的传输客户端：生产实现打 `POST /api/workspaces/:slug/employees/:key/:action`。
 * 生命周期规则（状态机、凭证旋转、SIGNIN 门控）由后端权威执行，UI 只显示能力提示。
 */
export type OfficeLifecycleClient = (input: {
  slug: string;
  employeeKey: string;
  action: OfficeLifecycleAction;
}) => Promise<OfficeActionResult>;

export type OpenOfficeRuntimeInput = {
  conn: SurrealConn;
  slug: string;
  lifecycle?: OfficeLifecycleClient;
  onChange?: (snapshot: OfficeSnapshot) => void;
  /** 快照分页上限；默认 200，测试可调小。 */
  limit?: number;
};

export type OfficeDataRuntime = {
  readonly snapshot: OfficeSnapshot;
  /** 手动刷新（错误重试 / 下拉刷新共用）；重连时也会自动触发。 */
  refresh(): Promise<void>;
  /** 解决一条通知：浏览器当前会话直写 user_notification，解析落库即终态。 */
  resolveNotification(id: string, resolution: string): Promise<OfficeActionResult>;
  /** 花名册生命周期动作（admin）；未注入 lifecycle 客户端时返回不可用。 */
  lifecycleAction(employeeId: string, action: OfficeLifecycleAction): Promise<OfficeActionResult>;
  /** 幂等关闭：退订全部 LIVE 与连接状态监听，关闭后丢弃一切迟到事件。 */
  close(): Promise<void>;
};

const LIVE_TABLES = ["user", "office_task", "office_message", "office_report", "user_notification"] as const;

function runtimeError(
  code: OfficeRuntimeError["code"],
  message: string,
  retryable: boolean,
): OfficeRuntimeError {
  return { code, message, retryable };
}

function classifyError(cause: unknown): OfficeRuntimeError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/permission|not allowed|IAM/i.test(message)) return runtimeError("permission-denied", message, false);
  if (/disconnect|socket|network|timeout|closed/i.test(message)) return runtimeError("unavailable", message, true);
  return runtimeError("unexpected", message, false);
}

export async function openOfficeRuntime(input: OpenOfficeRuntimeInput): Promise<OfficeDataRuntime> {
  const { conn, slug } = input;
  const limit = Math.max(1, input.limit ?? 200);

  let status: OfficeRuntimeStatus = "opening";
  let connection: ConnectionStatus = conn.status;
  let refreshing = false;
  let error: OfficeRuntimeError | null = null;

  const users = new Map<string, OfficeEmployee>();
  const tasks = new Map<string, OfficeTask>();
  const messages = new Map<string, OfficeMessage>();
  const reports = new Map<string, OfficeReport>();
  const notifications = new Map<string, OfficeNotification>();
  let meta: OfficeMeta | null = null;

  let buffering = true;
  const buffer: LiveMessage[] = [];
  const unsubscribers: Array<() => void> = [];
  let refreshPromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  let closed = false;

  function snapshot(): OfficeSnapshot {
    return {
      status,
      connection,
      refreshing,
      meta: meta ? { ...meta } : null,
      employees: [...users.values()].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
      tasks: [...tasks.values()].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      ),
      messages: [...messages.values()].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      ),
      reports: [...reports.values()].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      ),
      notifications: [...notifications.values()].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      ),
      activity: projectActivity({
        tasks: [...tasks.values()],
        messages: [...messages.values()],
        reports: [...reports.values()],
        notifications: [...notifications.values()],
      }),
      error: error ? { ...error } : null,
    };
  }

  function emit(): void {
    input.onChange?.(snapshot());
  }

  /** 幂等合并单条 LIVE 变更；按 id 前缀分发到对应 map，KILLED 视同删除。 */
  function applyLive(message: LiveMessage): void {
    const id = String(message.value?.id ?? "");
    if (!id) return;
    if (message.action === "DELETE" || message.action === "KILLED") {
      users.delete(id);
      tasks.delete(id);
      messages.delete(id);
      reports.delete(id);
      notifications.delete(id);
      return;
    }
    if (message.action !== "CREATE" && message.action !== "UPDATE") return;
    const row: OfficeRow = message.value;
    if (id.startsWith("user:")) {
      const employee = normalizeEmployee(row);
      if (employee.id) users.set(employee.id, employee);
    } else if (id.startsWith("office_task:")) {
      const task = normalizeTask(row);
      if (task.id) tasks.set(task.id, task);
    } else if (id.startsWith("office_message:")) {
      const message_ = normalizeMessage(row);
      if (message_.id) messages.set(message_.id, message_);
    } else if (id.startsWith("office_report:")) {
      const report = normalizeReport(row);
      if (report.id) reports.set(report.id, report);
    } else if (id.startsWith("user_notification:")) {
      const notification = normalizeNotification(row);
      if (notification.id) notifications.set(notification.id, notification);
    }
  }

  function onLive(message: LiveMessage): void {
    if (closed) return;
    if (buffering) {
      buffer.push(message);
      return;
    }
    applyLive(message);
    emit();
  }

  async function loadSnapshot(): Promise<void> {
    const [metaRows, userRows, taskRows, messageRows, reportRows, notificationRows] = await Promise.all([
      conn.query<OfficeRow>("SELECT * FROM office_meta LIMIT 1"),
      conn.query<OfficeRow>(
        `SELECT id, email, subject, kind, is_admin, display_name, virtual_profile, disabled_at, created_at
         FROM user ORDER BY created_at ASC LIMIT ${limit}`,
      ),
      conn.query<OfficeRow>(`SELECT * FROM office_task ORDER BY created_at DESC LIMIT ${limit}`),
      conn.query<OfficeRow>(`SELECT * FROM office_message ORDER BY created_at DESC LIMIT ${limit}`),
      conn.query<OfficeRow>(`SELECT * FROM office_report ORDER BY created_at DESC LIMIT ${limit}`),
      conn.query<OfficeRow>(`SELECT * FROM user_notification ORDER BY created_at DESC LIMIT ${limit}`),
    ]);

    users.clear();
    for (const row of userRows) {
      const employee = normalizeEmployee(row);
      if (employee.id) users.set(employee.id, employee);
    }
    tasks.clear();
    for (const row of taskRows) {
      const task = normalizeTask(row);
      if (task.id) tasks.set(task.id, task);
    }
    messages.clear();
    for (const row of messageRows) {
      const message_ = normalizeMessage(row);
      if (message_.id) messages.set(message_.id, message_);
    }
    reports.clear();
    for (const row of reportRows) {
      const report = normalizeReport(row);
      if (report.id) reports.set(report.id, report);
    }
    notifications.clear();
    for (const row of notificationRows) {
      const notification = normalizeNotification(row);
      if (notification.id) notifications.set(notification.id, notification);
    }
    const metaRow = metaRows[0];
    meta = metaRow ? normalizeOfficeMeta(metaRow) : null;
  }

  async function refresh(): Promise<void> {
    if (closed) return;
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      // 查询期间到达的 LIVE 继续缓冲；快照替换后再重放缓冲，合并幂等。
      buffering = true;
      refreshing = true;
      emit();
      let succeeded = false;
      try {
        await loadSnapshot();
        status = "ready";
        error = null;
        succeeded = true;
      } catch (cause) {
        error = classifyError(cause);
        status = "error";
      } finally {
        emit();
        refreshing = false;
        refreshPromise = null;
      }
      if (!succeeded) return; // 失败时保持缓冲，下次刷新成功后统一 flush，事件不丢。
      const tail = buffer.splice(0, buffer.length);
      buffering = false;
      for (const message of tail) applyLive(message);
      emit();
    })();
    return refreshPromise;
  }

  // ── 订阅：先 LIVE 后快照，消除 load→subscribe 变更窗口 ────────────────────
  try {
    for (const table of LIVE_TABLES) {
      const unsubscribe = await conn.liveTable(table, onLive);
      unsubscribers.push(unsubscribe);
      if (closed) {
        // close 与 open 竞态（快速切换）：立即退订已建立的订阅。
        unsubscribe();
      }
    }
  } catch (cause) {
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribers.length = 0;
    throw cause;
  }

  // 连接状态监听：断线重连后全量重查，消除断口缺口；重查期间事件缓冲。
  const unsubConnected = conn.subscribe("connected", () => {
    if (closed) return;
    connection = "connected";
    void refresh();
  });
  const unsubReconnecting = conn.subscribe("reconnecting", () => {
    if (closed) return;
    connection = "reconnecting";
    emit();
  });
  const unsubDisconnected = conn.subscribe("disconnected", () => {
    if (closed) return;
    connection = "disconnected";
    emit();
  });
  unsubscribers.push(unsubConnected, unsubReconnecting, unsubDisconnected);

  await refresh();

  async function lifecycleAction(
    employeeId: string,
    action: OfficeLifecycleAction,
  ): Promise<OfficeActionResult> {
    if (closed) return { ok: false, message: "办公室运行时已关闭" };
    const client = input.lifecycle;
    if (!client) return { ok: false, message: "生命周期动作不可用" };
    const employeeKey = employeeId.startsWith("user:") ? employeeId.slice(5) : employeeId;
    if (!employeeKey) return { ok: false, message: "员工 id 不合法" };
    try {
      const outcome = await client({ slug, employeeKey, action });
      if (outcome.ok) {
        // 乐观合并本地视图；权威状态由 LIVE / 下次刷新校准。
        const employee = users.get(employeeId);
        if (employee && outcome.status) {
          users.set(employeeId, { ...employee, status: outcome.status });
          emit();
        }
      }
      return outcome;
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  async function resolveNotification(id: string, resolution: string): Promise<OfficeActionResult> {
    if (closed) return { ok: false, message: "办公室运行时已关闭" };
    const message = resolution.trim();
    if (!message) return { ok: false, message: "处理说明不能为空" };
    try {
      // id 是 `table:id` 字符串；SDK 写入边界包成 StringRecordId（updateRecord 内部处理）。
      await conn.updateRecord(id, { resolution: message, resolved_at: new Date() });
      const notification = notifications.get(id);
      if (notification) {
        notifications.set(id, {
          ...notification,
          resolvedAt: new Date().toISOString(),
          resolution: message,
        });
        emit();
      }
      return { ok: true };
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (closed) return;
      closed = true;
      status = "closed";
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe();
        } catch {
          // 单个退订失败不影响整体清理。
        }
      }
      unsubscribers.length = 0;
      buffer.length = 0;
      emit();
    })();
    return closePromise;
  }

  return {
    get snapshot() {
      return snapshot();
    },
    refresh,
    resolveNotification,
    lifecycleAction,
    close,
  };
}
