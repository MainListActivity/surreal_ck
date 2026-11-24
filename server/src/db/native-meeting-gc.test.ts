import { expect, test } from "bun:test";
import { createNativeMeetingBatchRunner, sweepNativeMeetingWorkspaces } from "./native-meeting-gc";

test("会议清理只调用有版本栅栏的有界批次；单库失败不阻塞后续 workspace", async () => {
  const scopes: string[] = [];
  const failures: string[] = [];
  const batches: string[] = [];
  await sweepNativeMeetingWorkspaces({
    async use({ namespace, database }) {
      expect(namespace).toBe("fixture");
      scopes.push(database);
    },
    async query(sql) {
      expect(sql).toContain("status IN ['active', 'archived']");
      return [["old", "busy", "unreachable", "next"]];
    },
  }, "fixture", async (namespace, database) => {
    expect(namespace).toBe("fixture");
    batches.push(database);
    if (database === "unreachable") throw new Error("fixture unavailable");
    return database === "busy";
  }, (database) => failures.push(database));
  expect(scopes).toEqual(["_system"]);
  expect(failures).toEqual(["unreachable"]);
  expect(batches.filter((name) => name === "busy")).toHaveLength(8);
  expect(batches.at(-1)).toBe("next");
});

test("每个清理批次只在 HTTP 请求中选库；语句级错误不会被当作正常结束", async () => {
  let token = "fixture-root";
  let requests = 0;
  const runner = createNativeMeetingBatchRunner(
    "wss://db.example/prefix/rpc/?unused=1#unused",
    () => token,
    async (url, request) => {
      requests += 1;
      expect(String(url)).toBe("https://db.example/prefix/sql");
      expect(request?.method).toBe("POST");
      expect(request?.redirect).toBe("error");
      const headers = new Headers(request?.headers);
      expect(headers.get("surreal-ns")).toBe("fixture");
      expect(headers.get("surreal-db")).toBe("workspace_fixture");
      expect(headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(request?.body).toContain("schema_version:current) >= 64");
      expect(request?.body).toContain("fn::meeting_gc()");
      return Response.json(requests === 1 ? [{ status: "OK", result: true }] : [{ status: "ERR" }]);
    },
  );
  expect(await runner("fixture", "workspace_fixture")).toBe(true);
  token = "fixture-renewed";
  await expect(runner("fixture", "workspace_fixture")).rejects.toThrow("Meeting sweep statement failed");
  expect(requests).toBe(2);
});
