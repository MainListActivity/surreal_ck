import { describe, expect, test } from "bun:test";
import {
  isConnectionUnavailableError,
  isRemoteConnectionReady,
} from "./remote-health";
import type { SyncDb } from "../sync/types";

function fakeRemote(state: { isConnected?: boolean; status?: string } = {}): SyncDb & {
  isConnected?: boolean;
  status?: string;
} {
  return {
    ...state,
    async query<T = unknown>(): Promise<T> {
      return [[]] as T;
    },
  };
}

describe("remote-health", () => {
  test("没有连接状态字段的测试替身默认视为可用", () => {
    expect(isRemoteConnectionReady(fakeRemote())).toBe(true);
  });

  test("优先使用 isConnected / status 判断 SurrealDB websocket 是否仍在线", () => {
    expect(isRemoteConnectionReady(fakeRemote({ isConnected: true }))).toBe(true);
    expect(isRemoteConnectionReady(fakeRemote({ isConnected: false }))).toBe(false);
    expect(isRemoteConnectionReady(fakeRemote({ status: "connected" }))).toBe(true);
    expect(isRemoteConnectionReady(fakeRemote({ status: "disconnected" }))).toBe(false);
    expect(isRemoteConnectionReady(fakeRemote({ status: "reconnecting" }))).toBe(false);
  });

  test("识别 SurrealDB 断连后 query 抛出的连接不可用错误", () => {
    const err = new Error(
      `fixed structure shadow rebuild remote fetch table=app_user query="SELECT * FROM type::table($table)" bindings.table=app_user: You must be connected to a SurrealDB instance before performing this operation`,
    );

    expect(isConnectionUnavailableError(err)).toBe(true);
  });
});
