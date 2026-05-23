import { describe, expect, test } from "bun:test";
import { createRootSessionPool, type RootDatabaseSession } from "./root-session-pool";

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
