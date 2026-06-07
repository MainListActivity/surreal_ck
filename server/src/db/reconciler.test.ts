import { describe, expect, test } from "bun:test";
import { RecordId, StringRecordId } from "surrealdb";
import { reconcileWorkspaceIndex, startReconcileLoop } from "./reconciler";

type IndexRow = {
  id: string | RecordId | StringRecordId;
  subject: string;
  email?: string;
  dbName: string;
  role: "admin" | "participant";
  disabledAt?: string | null;
};

type UserRow = {
  id: string;
  subject?: string | null;
  email?: string;
  isAdmin: boolean;
  disabledAt?: string | null;
};

type WorkspaceFixture = {
  id: string | RecordId | StringRecordId;
  dbName: string;
  status: string;
  users: UserRow[];
  /** db 不可达时设置，query 会抛错 */
  unreachable?: boolean;
};

type MutationCall = {
  sql: string;
  params?: Record<string, unknown>;
};

class FakeReconcileClient {
  readonly mutations: MutationCall[] = [];
  currentDatabase = "_system";

  constructor(
    private readonly workspaces: WorkspaceFixture[],
    private readonly indexRows: IndexRow[],
  ) {}

  async use(scope: { namespace: string; database: string }): Promise<void> {
    this.currentDatabase = scope.database;
  }

  async query(sql: string, params?: Record<string, unknown>): Promise<unknown[]> {
    // _system: active workspace 列表
    if (sql.includes("FROM workspace") && this.currentDatabase === "_system") {
      return [
        this.workspaces
          .filter((ws) => ws.status === "active")
          .map((ws) => ({ id: ws.id, db_name: ws.dbName })),
      ];
    }

    // _system: 某 workspace 的 index 行
    if (sql.includes("FROM user_workspace_index")) {
      const dbName = params?.dbName as string | undefined;
      return [
        this.indexRows
          .filter((row) => row.dbName === dbName)
          .map((row) => ({
            id: row.id,
            subject: row.subject,
            email: row.email,
            db_name: row.dbName,
            role: row.role,
            disabled_at: row.disabledAt ?? null,
          })),
      ];
    }

    // ws db: human user 列表
    if (sql.includes("FROM user") && sql.includes("human")) {
      const ws = this.workspaces.find((entry) => entry.dbName === this.currentDatabase);
      if (ws?.unreachable) {
        throw new Error(`workspace db ${this.currentDatabase} unreachable`);
      }
      return [
        (ws?.users ?? []).map((user) => ({
          id: user.id,
          subject: user.subject ?? null,
          email: user.email,
          is_admin: user.isAdmin,
          disabled_at: user.disabledAt ?? null,
        })),
      ];
    }

    // 修复类写入
    this.mutations.push({ sql, params });
    return [[]];
  }
}

describe("workspace index reconciler", () => {
  test("reports zero drift and makes no repairs when index matches workspace users", async () => {
    const db = new FakeReconcileClient(
      [
        {
          id: "workspace:alpha",
          dbName: "ws_alpha",
          status: "active",
          users: [{ id: "user:a1", subject: "sub-a1", email: "a1@x.test", isAdmin: true }],
        },
        {
          id: "workspace:beta",
          dbName: "ws_beta",
          status: "active",
          users: [{ id: "user:b1", subject: "sub-b1", email: "b1@x.test", isAdmin: false }],
        },
      ],
      [
        { id: "user_workspace_index:i1", subject: "sub-a1", email: "a1@x.test", dbName: "ws_alpha", role: "admin" },
        { id: "user_workspace_index:i2", subject: "sub-b1", email: "b1@x.test", dbName: "ws_beta", role: "participant" },
      ],
    );

    const result = await reconcileWorkspaceIndex(db, { namespace: "main" });

    expect(result).toEqual({
      workspaces: 2,
      users: 2,
      drift: 0,
      repaired: 0,
      failedWorkspaces: [],
    });
    expect(db.mutations).toEqual([]);
  });

  test("re-adds a missing index row when a workspace user has no _system index entry", async () => {
    const db = new FakeReconcileClient(
      [
        {
          id: new RecordId("workspace", "alpha"),
          dbName: "ws_alpha",
          status: "active",
          users: [{ id: "user:orphan", subject: "sub-orphan", email: "orphan@x.test", isAdmin: false }],
        },
      ],
      [], // _system 索引为空 → 漂移
    );

    const result = await reconcileWorkspaceIndex(db, { namespace: "main" });

    expect(result.workspaces).toBe(1);
    expect(result.users).toBe(1);
    expect(result.drift).toBe(1);
    expect(result.repaired).toBe(1);
    expect(result.failedWorkspaces).toEqual([]);

    // 补回一条 index：含 subject / workspace record / db_name / role(participant)
    expect(db.mutations).toHaveLength(1);
    const repair = db.mutations[0]!;
    expect(repair.sql).toContain("user_workspace_index");
    expect(repair.params).toMatchObject({
      subject: "sub-orphan",
      email: "orphan@x.test",
      dbName: "ws_alpha",
      role: "participant",
    });
    expect(repair.params?.workspace).toBeInstanceOf(StringRecordId);
    expect((repair.params?.workspace as StringRecordId).toString()).toBe("workspace:alpha");
  });

  test("fixes the index role to match workspace user.is_admin authority", async () => {
    const db = new FakeReconcileClient(
      [
        {
          id: "workspace:alpha",
          dbName: "ws_alpha",
          status: "active",
          // ws db 权威：该用户其实是管理员
          users: [{ id: "user:a1", subject: "sub-a1", email: "a1@x.test", isAdmin: true }],
        },
      ],
      // _system 里却记成 participant → role 漂移
      [{ id: new RecordId("user_workspace_index", "i1"), subject: "sub-a1", email: "a1@x.test", dbName: "ws_alpha", role: "participant" }],
    );

    const result = await reconcileWorkspaceIndex(db, { namespace: "main" });

    expect(result.drift).toBe(1);
    expect(result.repaired).toBe(1);

    expect(db.mutations).toHaveLength(1);
    const repair = db.mutations[0]!;
    expect(repair.sql).toContain("UPDATE");
    expect(repair.sql).toContain("role");
    expect(repair.params?.membership).toBeInstanceOf(StringRecordId);
    expect((repair.params?.membership as StringRecordId).toString()).toBe("user_workspace_index:i1");
    expect(repair.params?.role).toBe("admin");
  });

  test("repairs a stale index subject matched by workspace user email", async () => {
    const db = new FakeReconcileClient(
      [
        {
          id: "workspace:alpha",
          dbName: "ws_alpha",
          status: "active",
          users: [{ id: "user:a1", subject: "current-sub", email: "a1@x.test", isAdmin: false }],
        },
      ],
      [
        {
          id: new RecordId("user_workspace_index", "i1"),
          subject: "stale-sub",
          email: "a1@x.test",
          dbName: "ws_alpha",
          role: "participant",
        },
      ],
    );

    const result = await reconcileWorkspaceIndex(db, { namespace: "main" });

    expect(result.drift).toBe(1);
    expect(result.repaired).toBe(1);

    expect(db.mutations).toHaveLength(1);
    const repair = db.mutations[0]!;
    expect(repair.sql).toContain("UPDATE");
    expect(repair.sql).toContain("subject");
    expect((repair.params?.membership as StringRecordId).toString()).toBe("user_workspace_index:i1");
    expect(repair.params?.subject).toBe("current-sub");
  });

  test("flags an orphan index row without deleting it when no workspace user matches", async () => {
    const db = new FakeReconcileClient(
      [
        {
          id: "workspace:alpha",
          dbName: "ws_alpha",
          status: "active",
          users: [], // ws db 内已无对应 human user
        },
      ],
      // _system 仍保留一条 active 索引 → 孤儿
      [{ id: "user_workspace_index:i1", subject: "sub-gone", email: "gone@x.test", dbName: "ws_alpha", role: "admin" }],
    );

    const result = await reconcileWorkspaceIndex(db, { namespace: "main" });

    expect(result.drift).toBe(1);
    // MVP：只告警不删，不做任何修复写入
    expect(result.repaired).toBe(0);
    expect(db.mutations).toEqual([]);
  });

  test("isolates an unreachable workspace db and keeps reconciling the rest", async () => {
    const db = new FakeReconcileClient(
      [
        {
          id: "workspace:down",
          dbName: "ws_down",
          status: "active",
          users: [],
          unreachable: true, // 该 db 查询抛错
        },
        {
          id: "workspace:up",
          dbName: "ws_up",
          status: "active",
          users: [{ id: "user:u1", subject: "sub-u1", email: "u1@x.test", isAdmin: false }],
        },
      ],
      [{ id: "user_workspace_index:i1", subject: "sub-u1", email: "u1@x.test", dbName: "ws_up", role: "participant" }],
    );

    // 整体不抛
    const result = await reconcileWorkspaceIndex(db, { namespace: "main" });

    expect(result.failedWorkspaces).toEqual(["ws_down"]);
    // 健康 workspace 仍被处理（无漂移）
    expect(result.workspaces).toBe(2);
    expect(result.users).toBe(1);
    expect(result.drift).toBe(0);
    expect(result.repaired).toBe(0);
    expect(db.mutations).toEqual([]);
  });
});

describe("reconcile heartbeat loop", () => {
  type FakeTimer = { handler: () => void; ms: number; id: number };

  function makeTimers() {
    const timers = new Map<number, FakeTimer>();
    let nextId = 1;
    const cleared: number[] = [];
    return {
      timers,
      cleared,
      setInterval(handler: () => void, ms: number) {
        const id = nextId++;
        timers.set(id, { handler, ms, id });
        return id as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval(handle: ReturnType<typeof setInterval>) {
        const id = handle as unknown as number;
        cleared.push(id);
        timers.delete(id);
      },
      /** 手动驱动一次 tick（模拟到点） */
      tick(id = 1) {
        timers.get(id)?.handler();
      },
    };
  }

  test("runs once immediately on start, then schedules a repeating interval", async () => {
    const t = makeTimers();
    let runs = 0;
    const runOnce = async () => {
      runs += 1;
    };

    const handle = startReconcileLoop({
      intervalSec: 1800,
      runOnce,
      setInterval: t.setInterval,
      clearInterval: t.clearInterval,
    });

    // 启动立即跑一次
    await Promise.resolve();
    expect(runs).toBe(1);

    // 注册了一个按 intervalSec 毫秒数的定时器
    const timer = t.timers.get(1);
    expect(timer?.ms).toBe(1800 * 1000);

    // 到点再跑
    t.tick();
    await Promise.resolve();
    expect(runs).toBe(2);

    handle.stop();
    expect(t.cleared).toContain(1);
    expect(t.timers.size).toBe(0);
  });

  test("swallows runOnce errors so a single failure cannot kill the heartbeat", async () => {
    const t = makeTimers();
    let runs = 0;
    const runOnce = async () => {
      runs += 1;
      throw new Error("reconcile boom");
    };

    // 启动不应抛
    const handle = startReconcileLoop({
      intervalSec: 60,
      runOnce,
      setInterval: t.setInterval,
      clearInterval: t.clearInterval,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(1);

    // 一次失败后定时器仍在，下次 tick 仍会跑
    expect(t.timers.size).toBe(1);
    t.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(2);

    handle.stop();
  });
});
