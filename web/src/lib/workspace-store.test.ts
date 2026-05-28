import { describe, expect, test } from "bun:test";
import type { AuthClaims } from "./auth";
import type { SurrealConn, SurrealConnectInput } from "./surreal";
import { createWorkspaceState } from "./workspace-store";

function fakeConn() {
  const listeners = new Map<string, (...payload: unknown[]) => void>();
  let status: SurrealConn["status"] = "connected";
  const conn: SurrealConn = {
    get status() {
      return status;
    },
    async connect() {
      status = "connected";
      return true;
    },
    async use(what) {
      return what ?? { namespace: null, database: null };
    },
    async close() {
      status = "disconnected";
      return true;
    },
    subscribe(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
  };
  return {
    conn,
    emit(event: string, ...payload: unknown[]) {
      listeners.get(event)?.(...payload);
    },
    setStatus(next: SurrealConn["status"]) {
      status = next;
    },
  };
}

const claims: AuthClaims = {
  sub: "user:ada",
  email: "ada@example.test",
  name: "Ada",
  "https://surrealdb.com/db": "ws_a1b2c3d4e5f6",
  "https://surrealdb.com/ac": "participant",
};

function setup() {
  const fake = fakeConn();
  const connectInputs: SurrealConnectInput[] = [];
  const state = createWorkspaceState({
    surrealUrl: "ws://localhost:8000/rpc",
    namespace: "main",
    connect: async (input) => {
      connectInputs.push(input);
      return fake.conn;
    },
  });
  return { state, fake, connectInputs };
}

describe("workspace 状态层", () => {
  test("enterWorkspace 从 claims + raw token 派生 currentUser/currentWorkspace 并连库", async () => {
    const { state, connectInputs } = setup();

    await state.enterWorkspace({ rawToken: "raw.jwt", claims });

    expect(connectInputs).toEqual([
      {
        url: "ws://localhost:8000/rpc",
        rawToken: "raw.jwt",
        namespace: "main",
        dbName: "ws_a1b2c3d4e5f6",
        access: "participant",
      },
    ]);
    expect(state.currentUser).toEqual({
      subject: "user:ada",
      email: "ada@example.test",
      name: "Ada",
    });
    expect(state.currentWorkspace).toMatchObject({
      dbName: "ws_a1b2c3d4e5f6",
      role: "participant",
    });
    expect(state.connectionState).toBe("open");
  });

  test("断线时 connectionState 变 closed，恢复后回 open", async () => {
    const { state, fake } = setup();

    await state.enterWorkspace({ rawToken: "raw.jwt", claims });
    expect(state.connectionState).toBe("open");

    fake.emit("disconnected");
    expect(state.connectionState).toBe("closed");

    fake.emit("reconnecting");
    expect(state.connectionState).toBe("closing");

    fake.emit("connected", "ws://localhost:8000/rpc");
    expect(state.connectionState).toBe("open");
  });

  test("onChange 在进入 workspace 和断线/重连时推送最新快照", async () => {
    const fake = fakeConn();
    const snapshots: string[] = [];
    const state = createWorkspaceState({
      surrealUrl: "ws://localhost:8000/rpc",
      namespace: "main",
      connect: async () => fake.conn,
      onChange: (snap) => snapshots.push(snap.connectionState),
    });

    await state.enterWorkspace({ rawToken: "raw.jwt", claims });
    fake.emit("disconnected");
    fake.emit("connected", "ws://localhost:8000/rpc");

    expect(snapshots).toEqual(["open", "closed", "open"]);
  });
});
