import { expect, test } from "bun:test";
import { sweepNativeMeetingWorkspaces } from "./native-meeting-gc";

test("会议清理只调用有版本栅栏的有界批次；单库失败不阻塞后续 workspace", async () => {
  let current = "";
  const scopes: string[] = [];
  const failures: string[] = [];
  const batches: string[] = [];
  await sweepNativeMeetingWorkspaces({
    async use({ namespace, database }) {
      expect(namespace).toBe("fixture");
      current = database;
      scopes.push(database);
    },
    async query(sql) {
      if (current === "_system") {
        expect(sql).toContain("status IN ['active', 'archived']");
        return [["old", "busy", "unreachable", "next"]];
      }
      expect(sql).toContain("schema_version:current) >= 64");
      expect(sql).toContain("fn::meeting_gc()");
      batches.push(current);
      if (current === "unreachable") throw new Error("fixture unavailable");
      return [current === "busy"];
    },
  }, "fixture", (database) => failures.push(database));
  expect(scopes).toEqual(["_system", "old", "busy", "unreachable", "next"]);
  expect(failures).toEqual(["unreachable"]);
  expect(batches.filter((name) => name === "busy")).toHaveLength(8);
  expect(batches.at(-1)).toBe("next");
});
