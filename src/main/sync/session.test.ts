import { beforeEach, describe, expect, test } from "bun:test";
import {
  buildDefineCurrentSessionParamSql,
  buildDefineLocalOriginSessionSql,
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

  test("本地 origin overlay 由代码生成，不放进共享 schema", () => {
    const sql = buildDefineLocalOriginSessionSql();
    expect(sql).toContain("DEFINE FIELD OVERWRITE _origin_session_id ON TABLE app_user TYPE option<string>");
    expect(sql).toContain("DEFAULT ALWAYS ($current_session_id ?? NONE)");
    expect(sql).toContain("REMOVE EVENT IF EXISTS app_user_origin_session ON TABLE app_user");
    expect(sql).toContain("DEFINE FIELD OVERWRITE _origin_session_id ON TABLE app_setting TYPE option<string>");
  });
});
