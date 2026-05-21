import { beforeEach, describe, expect, test } from "bun:test";
import { connectRemoteWithRuntime, type RemoteConnection } from "./remote-connection";
import type { SyncDb } from "../sync/types";

let remoteDb: SyncDb | null = null;
let offlineMode = false;
let syncLastError: string | undefined;
let startSyncWorkersCalls = 0;
let stopSyncWorkersCalls = 0;
let failConnect = false;
let failAuthenticate = false;

class FakeRemote implements RemoteConnection {
  connected = false;
  authenticated = false;
  used?: { namespace: string; database: string };
  connectOptions?: unknown;

  async connect(_url?: string, options?: unknown): Promise<void> {
    this.connectOptions = options;
    if (failConnect) throw new Error("network unavailable");
    this.connected = true;
  }

  async use(input: { namespace: string; database: string }): Promise<void> {
    this.used = input;
  }

  async authenticate(): Promise<void> {
    if (failAuthenticate) throw new Error("bad token");
    this.authenticated = true;
  }

  async query<T = unknown>(): Promise<T> {
    return [[]] as T;
  }
}

const localDb: SyncDb = {
  async query<T = unknown>(): Promise<T> {
    return [[]] as T;
  },
};

function createRuntime(warnings: string[], logs: string[]) {
  return {
    createRemote: () => new FakeRemote(),
    stopSyncWorkers: () => {
      stopSyncWorkersCalls += 1;
    },
    setRemoteDb: (remote: FakeRemote | null) => {
      remoteDb = remote;
    },
    getRemoteDb: () => remoteDb,
    getLocalDb: () => localDb,
    setOfflineMode: (value: boolean) => {
      offlineMode = value;
    },
    setSyncLastError: (message: string | undefined) => {
      syncLastError = message;
    },
    checkRemoteSchemaVersion: async () => true,
    startSyncWorkers: async () => {
      startSyncWorkersCalls += 1;
      throw Object.assign(
        new Error(
          `fixed structure shadow rebuild remote fetch table=workspace query="SELECT * FROM type::table($table)" bindings.table=workspace: IAM error: Not enough permissions to perform this action`,
        ),
        { kind: "NotAllowed", code: 0 },
      );
    },
    log: (message: string) => {
      logs.push(message);
    },
    warn: (message: string) => {
      warnings.push(message);
    },
  };
}

describe("connectRemoteWithRuntime", () => {
  beforeEach(() => {
    remoteDb = null;
    offlineMode = false;
    syncLastError = undefined;
    startSyncWorkersCalls = 0;
    stopSyncWorkersCalls = 0;
    failConnect = false;
    failAuthenticate = false;
  });

  test("同步重建因远端 IAM 权限不足无法启动时，仍保留已认证远端连接", async () => {
    const warnings: string[] = [];
    const logs: string[] = [];

    await connectRemoteWithRuntime("access-token", {
      remoteUrl: "wss://example.invalid",
      namespace: "main",
      database: "docs",
    }, createRuntime(warnings, logs));

    const remote = remoteDb as FakeRemote;
    expect(remote.connected).toBe(true);
    expect(remote.connectOptions).toEqual({ reconnect: false });
    expect(remote.authenticated).toBe(true);
    expect(remote.used).toEqual({ namespace: "main", database: "docs" });
    expect(offlineMode).toBe(false);
    expect(startSyncWorkersCalls).toBe(1);
    expect(stopSyncWorkersCalls).toBe(1);
    expect(syncLastError).toBe(
      `fixed structure shadow rebuild remote fetch table=workspace query="SELECT * FROM type::table($table)" bindings.table=workspace: IAM error: Not enough permissions to perform this action`,
    );
    expect(logs).toContain("[db] remote connected: wss://example.invalid");
    expect(warnings).toContain(
      `[sync] remote sync disabled: fixed structure shadow rebuild remote fetch table=workspace query="SELECT * FROM type::table($table)" bindings.table=workspace: IAM error: Not enough permissions to perform this action`,
    );
    expect(warnings).not.toContain("[db] remote connection failed (degraded to local-only):");
  });

  test("认证连接失败时仍降级到本地-only", async () => {
    const warnings: string[] = [];
    const logs: string[] = [];
    failConnect = true;

    await connectRemoteWithRuntime("access-token", {
      remoteUrl: "wss://example.invalid",
      namespace: "main",
      database: "docs",
    }, createRuntime(warnings, logs));

    expect(remoteDb).toBeNull();
    expect(offlineMode).toBe(true);
    expect(startSyncWorkersCalls).toBe(0);
    expect(syncLastError).toBe("network unavailable");
    expect(logs).toHaveLength(0);
    expect(warnings).toContain("[db] remote connection failed (degraded to local-only):");
  });
});
