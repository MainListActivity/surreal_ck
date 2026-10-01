import { describe, expect, test } from "bun:test";
import type { LiveMessage, SurrealConn } from "./surreal";
import { openOfficeRuntime, type OfficeLifecycleClient } from "./office-runtime";

/**
 * OfficeDataRuntime 浏览器测试（VO04）：
 * 覆盖 snapshot/LIVE 竞态、断线重连、快速 workspace 切换、生命周期动作与资源清理。
 * conn 是手写 fake：快照查询可用 pending gate 挂起，LIVE handler 可手动注入事件。
 */

type Row = Record<string, unknown>;

function employeeRow(overrides: Row = {}): Row {
  return {
    id: "user:ve_1",
    email: "ve-1@virtual.local",
    kind: "virtual",
    is_admin: false,
    display_name: "项目经理",
    virtual_profile: { role_key: "project-manager", status: "active" },
    created_at: "2026-09-30T00:00:00Z",
    ...overrides,
  };
}

function taskRow(overrides: Row = {}): Row {
  return {
    id: "office_task:t1",
    goal: "整理债权申报材料",
    status: "open",
    assigner: "user:ve_1",
    assignee: "user:ve_1",
    depth: 0,
    created_at: "2026-09-30T01:00:00Z",
    updated_at: "2026-09-30T01:00:00Z",
    ...overrides,
  };
}

function messageRow(overrides: Row = {}): Row {
  return {
    id: "office_message:m1",
    author: "user:ve_1",
    body: "已开始检查材料",
    created_at: "2026-09-30T01:10:00Z",
    ...overrides,
  };
}

function reportRow(overrides: Row = {}): Row {
  return {
    id: "office_report:r1",
    author: "user:ve_1",
    to: "user:human1",
    task: "office_task:t1",
    summary: "第一份报告",
    created_at: "2026-09-30T01:20:00Z",
    ...overrides,
  };
}

function notificationRow(overrides: Row = {}): Row {
  return {
    id: "user_notification:n1",
    purpose: "office-request",
    title: "需要补充信息",
    body: "请提供 2024 年债权清单",
    from_employee: "user:ve_1",
    to_user: "user:human1",
    created_at: "2026-09-30T01:30:00Z",
    ...overrides,
  };
}

type HarnessTables = {
  user: Row[];
  office_task: Row[];
  office_message: Row[];
  office_report: Row[];
  user_notification: Row[];
  office_meta: Row[];
};

function emptyTables(): HarnessTables {
  return {
    user: [],
    office_task: [],
    office_message: [],
    office_report: [],
    user_notification: [],
    office_meta: [],
  };
}

function officeHarness(tables: HarnessTables) {
  // handler 在退订后仍保留（记录 active 标记）：关闭后注入的"迟到事件"模拟
  // 已在 driver 队列里、退订竞态窗口内到达的推送，runtime 必须自行丢弃。
  const liveHandlers = new Map<string, { handler: (message: LiveMessage) => void; active: boolean }>();
  const liveUnsubscribed: string[] = [];
  const statusListeners = new Map<string, Array<() => void>>();
  const queries: string[] = [];
  const updates: Array<{ id: string; patch: Row }> = [];
  let holdPattern: RegExp | null = null;
  let release: (() => void) | null = null;

  const conn = {
    status: "connected" as const,
    connect: async () => true,
    use: async () => ({}),
    close: async () => true,
    subscribe: (() => () => {}) as SurrealConn["subscribe"],
    query: (async (sql: string) => {
      queries.push(sql);
      if (holdPattern?.test(sql)) {
        holdPattern = null;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      if (/FROM office_meta/i.test(sql)) return [...tables.office_meta];
      if (/FROM user\b/i.test(sql)) return [...tables.user];
      if (/FROM office_task/i.test(sql)) return [...tables.office_task];
      if (/FROM office_message/i.test(sql)) return [...tables.office_message];
      if (/FROM office_report/i.test(sql)) return [...tables.office_report];
      if (/FROM user_notification/i.test(sql)) return [...tables.user_notification];
      return [];
    }) as SurrealConn["query"],
    liveTable: (async (table: string, handler: (message: LiveMessage) => void) => {
      liveHandlers.set(table, { handler, active: true });
      return () => {
        liveUnsubscribed.push(table);
        const entry = liveHandlers.get(table);
        if (entry) entry.active = false;
      };
    }) as SurrealConn["liveTable"],
    updateRecord: (async (id: string, patch: Row) => {
      updates.push({ id, patch });
      return { id, ...patch };
    }) as SurrealConn["updateRecord"],
    createRecord: (async () => ({})) as SurrealConn["createRecord"],
    deleteRecord: (async () => ({})) as SurrealConn["deleteRecord"],
  } as SurrealConn;

  return {
    conn,
    queries,
    updates,
    /** 让挂起的快照查询放行。 */
    releaseQuery() {
      release?.();
      release = null;
    },
    /** 让下一条匹配的快照查询挂起，直到 releaseQuery 被调用。 */
    holdQuery(pattern: RegExp) {
      holdPattern = pattern;
    },
    /** 向指定表的 LIVE handler 注入一条消息（模拟 driver 推送，含退订竞态）。 */
    emit(table: string, message: Omit<LiveMessage, "value"> & { value?: Row }) {
      const entry = liveHandlers.get(table);
      if (!entry) throw new Error(`no live handler for ${table}`);
      entry.handler({ action: message.action, value: message.value ?? { id: "unknown:x" } });
    },
    /** 触发 driver 连接状态事件。 */
    emitStatus(event: "connected" | "reconnecting" | "disconnected") {
      for (const listener of statusListeners.get(event) ?? []) listener();
    },
    set connStatus(next: SurrealConn["status"]) {
      (conn as { status: SurrealConn["status"] }).status = next;
    },
    get liveTableCount() {
      return [...liveHandlers.values()].filter((entry) => entry.active).length;
    },
    get unsubscribedTables() {
      return [...liveUnsubscribed];
    },
    __listeners: statusListeners,
  };
}

/** 把 harness 的 conn.subscribe 换成可记录的版本（默认 stub 不记录）。 */
function withStatusListeners(h: ReturnType<typeof officeHarness>) {
  (h.conn as { subscribe: SurrealConn["subscribe"] }).subscribe = ((event: string, listener: () => void) => {
    const list = h.__listeners.get(event) ?? [];
    list.push(listener);
    h.__listeners.set(event, list);
    return () => {
      const index = list.indexOf(listener);
      if (index !== -1) list.splice(index, 1);
    };
  }) as SurrealConn["subscribe"];
  return h;
}

const seedTables = (): HarnessTables => ({
  ...emptyTables(),
  user: [employeeRow()],
  office_task: [taskRow()],
  office_message: [messageRow()],
  office_report: [reportRow()],
  user_notification: [notificationRow()],
  office_meta: [{ id: "office_meta:office", goal: "完成年度债权申报", state: "active" }],
});

describe("OfficeDataRuntime 快照与 LIVE 竞态", () => {
  test("打开后快照含花名册、任务、消息、报告、通知与目标", async () => {
    const h = officeHarness(seedTables());
    const runtime = await openOfficeRuntime({ conn: h.conn, slug: "acme" });
    const snap = runtime.snapshot;

    expect(snap.status).toBe("ready");
    expect(snap.meta?.goal).toBe("完成年度债权申报");
    expect(snap.employees).toHaveLength(1);
    expect(snap.employees[0]).toMatchObject({ id: "user:ve_1", status: "active", roleKey: "project-manager" });
    expect(snap.tasks[0]?.goal).toBe("整理债权申报材料");
    expect(snap.messages[0]?.body).toBe("已开始检查材料");
    expect(snap.reports[0]?.summary).toBe("第一份报告");
    expect(snap.notifications[0]?.title).toBe("需要补充信息");
    await runtime.close();
  });

  test("LIVE 事件在快照完成前到达：先缓冲后合并，不丢事件", async () => {
    const h = officeHarness(seedTables());
    h.holdQuery(/FROM office_task/i);
    let changes = 0;
    const opened = openOfficeRuntime({
      conn: h.conn,
      slug: "acme",
      onChange: () => {
        changes += 1;
      },
    });
    // 等订阅建立（快照卡在 office_task 查询上）后再注入 LIVE。
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.liveTableCount).toBe(5);

    h.emit("office_task", {
      action: "CREATE",
      value: taskRow({ id: "office_task:t-live", goal: "LIVE 先到的新任务", created_at: "2026-09-30T02:00:00Z" }),
    });
    h.emit("user", {
      action: "UPDATE",
      value: employeeRow({ virtual_profile: { role_key: "project-manager", status: "paused" } }),
    });

    h.releaseQuery();
    const runtime = await opened;
    const snap = runtime.snapshot;

    // 缓冲重放：LIVE 先到的记录与快照合并，且覆盖为最新值。
    expect(snap.tasks.some((task) => task.id === "office_task:t-live" && task.goal === "LIVE 先到的新任务")).toBe(true);
    expect(snap.employees[0]?.status).toBe("paused");
    expect(snap.tasks.filter((task) => task.id === "office_task:t-live")).toHaveLength(1);
    expect(snap.status).toBe("ready");
    expect(changes).toBeGreaterThan(0);
    await runtime.close();
  });

  test("重复 LIVE UPDATE / 重连重查不产生重复卡片", async () => {
    const h = officeHarness(seedTables());
    const runtime = await openOfficeRuntime({ conn: h.conn, slug: "acme" });

    h.emit("office_task", { action: "UPDATE", value: taskRow({ status: "in_progress" }) });
    h.emit("office_task", { action: "UPDATE", value: taskRow({ status: "in_progress" }) });
    h.emit("office_task", { action: "UPDATE", value: taskRow({ status: "done", updated_at: "2026-09-30T02:00:00Z" }) });

    let snap = runtime.snapshot;
    expect(snap.tasks.filter((task) => task.id === "office_task:t1")).toHaveLength(1);
    expect(snap.activity.filter((item) => item.kind === "task")).toHaveLength(1);

    // 重连重查：全量替换后投影仍无重复。
    await runtime.refresh();
    snap = runtime.snapshot;
    expect(snap.activity.filter((item) => item.kind === "task")).toHaveLength(1);
    expect(snap.activity.filter((item) => item.id === "office_task:t1")).toHaveLength(1);
    await runtime.close();
  });

  test("活动流按时间倒序稳定排序，同刻按 id 决胜", async () => {
    const h = officeHarness(seedTables());
    const runtime = await openOfficeRuntime({ conn: h.conn, slug: "acme" });
    const activity = runtime.snapshot.activity;
    expect(activity.map((item) => item.id)).toEqual([
      "user_notification:n1",
      "office_report:r1",
      "office_message:m1",
      "office_task:t1",
    ]);
    await runtime.close();
  });

  test("DELETE 与 KILLED 从活动流与集合中移除", async () => {
    const h = officeHarness(seedTables());
    const runtime = await openOfficeRuntime({ conn: h.conn, slug: "acme" });
    h.emit("office_message", { action: "DELETE", value: { id: "office_message:m1" } });
    h.emit("user_notification", { action: "KILLED", value: { id: "user_notification:n1" } });
    const snap = runtime.snapshot;
    expect(snap.messages).toHaveLength(0);
    expect(snap.notifications).toHaveLength(0);
    expect(snap.activity.some((item) => item.id === "office_message:m1")).toBe(false);
    await runtime.close();
  });
});

describe("OfficeDataRuntime 断线重连", () => {
  test("重连成功后自动重查，断口事件由重查补齐", async () => {
    const h = withStatusListeners(officeHarness(seedTables()));
    const runtime = await openOfficeRuntime({ conn: h.conn, slug: "acme" });

    // 断线期间数据库新增了报告（浏览器收不到 LIVE）。
    h.emitStatus("disconnected");
    expect(runtime.snapshot.connection).toBe("disconnected");

    // 恢复：重连成功触发自动重查，把断口期间的记录带回来。
    h.conn.query = (async (sql: string) => {
      if (/FROM office_report/i.test(sql)) {
        return [
          reportRow(),
          reportRow({ id: "office_report:r2", summary: "断口期间的报告", created_at: "2026-09-30T02:30:00Z" }),
        ];
      }
      if (/FROM office_meta/i.test(sql)) return seedTables().office_meta;
      if (/FROM user\b/i.test(sql)) return seedTables().user;
      if (/FROM office_task/i.test(sql)) return seedTables().office_task;
      if (/FROM office_message/i.test(sql)) return seedTables().office_message;
      if (/FROM user_notification/i.test(sql)) return seedTables().user_notification;
      return [];
    }) as SurrealConn["query"];
    h.emitStatus("connected");
    await runtime.refresh();

    const snap = runtime.snapshot;
    expect(snap.connection).toBe("connected");
    expect(snap.reports.map((report) => report.id).sort()).toEqual(["office_report:r1", "office_report:r2"]);
    expect(snap.activity.filter((item) => item.kind === "report")).toHaveLength(2);
    await runtime.close();
  });

  test("重连中状态可见，重查失败保留缓冲不丢事件", async () => {
    const h = withStatusListeners(officeHarness(seedTables()));
    const runtime = await openOfficeRuntime({ conn: h.conn, slug: "acme" });

    h.emitStatus("reconnecting");
    expect(runtime.snapshot.connection).toBe("reconnecting");

    // 重连后重查失败：error 可见，LIVE 事件继续缓冲。
    h.conn.query = (async () => {
      throw new Error("socket closed");
    }) as SurrealConn["query"];
    h.emitStatus("connected");
    await runtime.refresh();
    expect(runtime.snapshot.status).toBe("error");
    expect(runtime.snapshot.error?.code).toBe("unavailable");

    // 失败期间到达的事件不丢：恢复后 flush。
    h.emit("office_task", {
      action: "CREATE",
      value: taskRow({ id: "office_task:t-buffered", goal: "缓冲期任务", created_at: "2026-09-30T03:00:00Z" }),
    });
    h.conn.query = (async (sql: string) => {
      if (/FROM office_meta/i.test(sql)) return seedTables().office_meta;
      if (/FROM user\b/i.test(sql)) return seedTables().user;
      if (/FROM office_task/i.test(sql)) {
        return [...seedTables().office_task, taskRow({ id: "office_task:t-buffered", goal: "缓冲期任务" })];
      }
      if (/FROM office_message/i.test(sql)) return seedTables().office_message;
      if (/FROM office_report/i.test(sql)) return seedTables().office_report;
      if (/FROM user_notification/i.test(sql)) return seedTables().user_notification;
      return [];
    }) as SurrealConn["query"];
    await runtime.refresh();

    expect(runtime.snapshot.status).toBe("ready");
    expect(runtime.snapshot.tasks.some((task) => task.id === "office_task:t-buffered")).toBe(true);
    await runtime.close();
  });
});

describe("OfficeDataRuntime workspace 切换与清理", () => {
  test("close 幂等且退订全部 LIVE；关闭后迟到事件被丢弃", async () => {
    const h = officeHarness(seedTables());
    const runtime = await openOfficeRuntime({ conn: h.conn, slug: "acme" });
    await runtime.close();
    await runtime.close(); // 幂等

    expect(h.unsubscribedTables.sort()).toEqual([
      "office_message",
      "office_report",
      "office_task",
      "user",
      "user_notification",
    ]);

    // 迟到事件：closed 后 LIVE handler 不再改状态。
    h.emit("office_task", { action: "CREATE", value: taskRow({ id: "office_task:late" }) });
    expect(runtime.snapshot.status).toBe("closed");
  });

  test("快速 workspace 切换：旧 runtime 关闭后，旧 database 迟到事件不污染新 workspace", async () => {
    const hA = withStatusListeners(officeHarness(seedTables()));
    const runtimeA = await openOfficeRuntime({ conn: hA.conn, slug: "acme" });

    const hB = officeHarness({
      ...emptyTables(),
      user: [employeeRow({ id: "user:ve_other", display_name: "另一工作区员工" })],
      office_meta: [{ id: "office_meta:office", goal: "另一个工作区的目标", state: "active" }],
    });
    const runtimeB = await openOfficeRuntime({ conn: hB.conn, slug: "beta" });

    // 切换：关闭 A，A 的事件流随后到达。
    await runtimeA.close();
    hA.emit("office_task", { action: "CREATE", value: taskRow({ id: "office_task:from-old-db" }) });
    hA.emitStatus("connected"); // A 的重连回调也应被忽略

    expect(runtimeB.snapshot.tasks).toHaveLength(0);
    expect(runtimeB.snapshot.meta?.goal).toBe("另一个工作区的目标");
    // A 关闭后不接受事件：迟到的新任务不进状态，快照仍只有关闭前那条。
    expect(runtimeA.snapshot.tasks.map((task) => task.id)).toEqual(["office_task:t1"]);
    expect(runtimeA.snapshot.status).toBe("closed");
    void hB;
    await runtimeB.close();
  });

  test("关闭后 update 操作返回 closed 错误", async () => {
    const h = officeHarness(seedTables());
    const runtime = await openOfficeRuntime({ conn: h.conn, slug: "acme" });
    await runtime.close();
    expect((await runtime.resolveNotification("user_notification:n1", "已处理")).ok).toBe(false);
    expect((await runtime.lifecycleAction("user:ve_1", "pause")).ok).toBe(false);
  });
});

describe("OfficeDataRuntime 生命周期动作与通知解决", () => {
  test("lifecycleAction 调用注入客户端并乐观合并状态", async () => {
    const h = officeHarness(seedTables());
    const calls: Array<{ employeeKey: string; action: string }> = [];
    const lifecycle: OfficeLifecycleClient = async ({ employeeKey, action }) => {
      calls.push({ employeeKey, action });
      return { ok: true, status: "paused" };
    };
    const runtime = await openOfficeRuntime({ conn: h.conn, slug: "acme", lifecycle });

    const outcome = await runtime.lifecycleAction("user:ve_1", "pause");
    expect(outcome).toEqual({ ok: true, status: "paused" });
    expect(calls).toEqual([{ employeeKey: "ve_1", action: "pause" }]);
    expect(runtime.snapshot.employees[0]?.status).toBe("paused");
    await runtime.close();
  });

  test("生命周期失败透传后端 message 且不改本地状态", async () => {
    const h = officeHarness(seedTables());
    const lifecycle: OfficeLifecycleClient = async () => ({ ok: false, message: "员工当前状态 retired 不允许该操作" });
    const runtime = await openOfficeRuntime({ conn: h.conn, slug: "acme", lifecycle });

    const outcome = await runtime.lifecycleAction("user:ve_1", "resume");
    expect(outcome).toEqual({ ok: false, message: "员工当前状态 retired 不允许该操作" });
    expect(runtime.snapshot.employees[0]?.status).toBe("active");
    await runtime.close();
  });

  test("未注入 lifecycle 客户端时返回不可用", async () => {
    const h = officeHarness(seedTables());
    const runtime = await openOfficeRuntime({ conn: h.conn, slug: "acme" });
    expect((await runtime.lifecycleAction("user:ve_1", "pause")).ok).toBe(false);
    await runtime.close();
  });

  test("resolveNotification 通过浏览器 updateRecord 直写并本地合并", async () => {
    const h = officeHarness(seedTables());
    const runtime = await openOfficeRuntime({ conn: h.conn, slug: "acme" });

    const outcome = await runtime.resolveNotification("user_notification:n1", "已补充清单");
    expect(outcome.ok).toBe(true);
    expect(h.updates).toEqual([
      { id: "user_notification:n1", patch: { resolution: "已补充清单", resolved_at: expect.any(Date) } },
    ]);
    expect(runtime.snapshot.notifications[0]?.resolution).toBe("已补充清单");
    expect(runtime.snapshot.notifications[0]?.resolvedAt).not.toBeNull();

    expect((await runtime.resolveNotification("user_notification:n1", "  ")).ok).toBe(false);
    await runtime.close();
  });
});
