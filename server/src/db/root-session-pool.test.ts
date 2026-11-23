import { describe, expect, test } from "bun:test";
import { createRootSessionPool, withScopedRootSessions, type RootDatabaseSession } from "./root-session-pool";

class FakeSession implements RootDatabaseSession {
  readonly useCalls: Array<{ namespace: string; database: string }> = [];
  closed = false;

  constructor(readonly id: number) {}

  async use(scope: { namespace: string; database: string }): Promise<void> {
    this.useCalls.push(scope);
  }

  async closeSession(): Promise<void> {
    this.closed = true;
  }
}

describe("root session pool", () => {
  test("reuses sessions by namespace/database and only initializes each once", async () => {
    const sessions: FakeSession[] = [];
    const pool = createRootSessionPool({
      async newSession() {
        const session = new FakeSession(sessions.length);
        sessions.push(session);
        return session;
      },
    });

    const first = await pool.get("ws_alpha", "main");
    const second = await pool.get("ws_alpha", "main");

    expect(second).toBe(first);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.useCalls).toEqual([{ namespace: "main", database: "ws_alpha" }]);
  });

  test("evicts least-recently-used sessions after the configured limit", async () => {
    const sessions: FakeSession[] = [];
    const pool = createRootSessionPool(
      {
        async newSession() {
          const session = new FakeSession(sessions.length);
          sessions.push(session);
          return session;
        },
      },
      { maxSessions: 20 },
    );

    for (let index = 0; index < 20; index += 1) {
      await pool.get(`ws_${index}`, "main");
    }
    const hotSession = await pool.get("ws_0", "main");
    await pool.get("ws_20", "main");

    expect(pool.size()).toBe(20);
    expect(hotSession.closed).toBe(false);
    expect(sessions[1]?.closed).toBe(true);
    expect(sessions[20]?.closed).toBe(false);
  });
});

describe("scoped root sessions", () => {
  test("keeps both database sessions open while unrelated traffic churns the pool", async () => {
    const sessions: FakeSession[] = [];
    const source = {
      async newSession() {
        const session = new FakeSession(sessions.length);
        sessions.push(session);
        return session;
      },
    };
    const pool = createRootSessionPool(source, { maxSessions: 2 });

    const result = await withScopedRootSessions(source, async (get) => {
      const system = await get("_system", "main");
      const workspace = await get("ws_new", "main");
      for (const database of ["ws_a", "ws_b", "ws_c"]) {
        await pool.get(database, "main");
      }
      expect(system.closed).toBe(false);
      expect(workspace.closed).toBe(false);
      expect(system.useCalls).toEqual([{ namespace: "main", database: "_system" }]);
      expect(workspace.useCalls).toEqual([{ namespace: "main", database: "ws_new" }]);
      return "created";
    });

    expect(result).toBe("created");
    expect(sessions.map((session) => session.closed)).toEqual([true, true, true, false, false]);
  });

  test("closes every opened session when selecting a database fails", async () => {
    const system = new FakeSession(0);
    const workspace = new FakeSession(1);
    const failure = new Error("use failed");
    workspace.use = async () => { throw failure; };
    const sessions = [system, workspace];

    await expect(withScopedRootSessions(
      { newSession: async () => sessions.shift()! },
      async (get) => {
        await get("_system", "main");
        await get("ws_new", "main");
      },
    )).rejects.toBe(failure);
    expect(system.closed).toBe(true);
    expect(workspace.closed).toBe(true);
  });
});
