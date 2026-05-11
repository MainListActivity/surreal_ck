import { beforeEach, describe, expect, test } from "bun:test";
import {
  buildDefineCurrentSessionParamSql,
  getLocalSessionId,
  resetLocalSessionIdForTests,
} from "./session";

describe("同步本机 sessionId", () => {
  beforeEach(() => {
    resetLocalSessionIdForTests();
  });

  test("同一进程内 sessionId 稳定", () => {
    const first = getLocalSessionId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(getLocalSessionId()).toBe(first);
  });

  test("进程重启语义下会生成新 sessionId", () => {
    const first = getLocalSessionId();
    resetLocalSessionIdForTests();
    expect(getLocalSessionId()).not.toBe(first);
  });

  test("DEFINE PARAM 语句会安全写入当前 sessionId", () => {
    const sql = buildDefineCurrentSessionParamSql("local-session-'1");
    expect(sql).toBe("DEFINE PARAM OVERWRITE $current_session_id VALUE 'local-session-\\'1';");
  });
});
