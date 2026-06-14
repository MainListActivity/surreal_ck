import { beforeEach, describe, expect, test } from "bun:test";
import type { WorkflowRunState } from "@mastra/core/workflows";
import { SurrealWorkflowsStorage } from "./surreal-workflows-storage";

type Row = {
  run_id: string;
  workflow_name: string;
  resource_id?: string | null;
  kind: string;
  state: WorkflowRunState;
  status: string;
  created_at: Date;
  updated_at: Date;
};

/**
 * 一个最小的 Surreal 会话替身，模拟已 SIGNIN 到某个 workspace database 的调用者会话。
 * 只解释本 storage 实际发出的 workflow_run 语句，按 run_id 主键在内存里读写。
 */
function fakeSession(rows: Map<string, Row>, opts: { failWrites?: boolean } = {}) {
  return {
    query: async (sql: string, params?: Record<string, unknown>) => {
      if (sql.includes("INSERT INTO workflow_run") || sql.includes("UPSERT") || sql.includes("UPDATE workflow_run")) {
        if (opts.failWrites) throw new Error("session unavailable");
        const content = params?.content as Partial<Row> | undefined;
        if (!content?.run_id) return [[]];
        const existing = rows.get(content.run_id);
        rows.set(content.run_id, {
          run_id: content.run_id,
          workflow_name: content.workflow_name ?? existing?.workflow_name ?? "",
          resource_id: content.resource_id ?? existing?.resource_id ?? null,
          kind: content.kind ?? existing?.kind ?? "router",
          state: content.state ?? existing?.state ?? ({} as WorkflowRunState),
          status: content.status ?? existing?.status ?? "running",
          created_at: existing?.created_at ?? (content.created_at as Date) ?? new Date(),
          updated_at: (content.updated_at as Date) ?? new Date(),
        });
        return [[]];
      }
      if (sql.includes("SELECT") && sql.includes("FROM workflow_run") && sql.includes("run_id = $runId")) {
        const row = rows.get(String(params?.runId));
        const matchesName = !params?.workflowName || row?.workflow_name === params?.workflowName;
        return [row && matchesName ? [row] : []];
      }
      if (sql.includes("SELECT") && sql.includes("FROM workflow_run")) {
        let all = Array.from(rows.values());
        if (params?.workflowName) all = all.filter((r) => r.workflow_name === params.workflowName);
        if (params?.status) all = all.filter((r) => r.status === params.status);
        if (params?.resourceId) all = all.filter((r) => r.resource_id === params.resourceId);
        all.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        if (sql.includes("count()")) return [all, [{ total: all.length }]];
        return [all, [{ total: all.length }]];
      }
      if (sql.includes("DELETE workflow_run") && sql.includes("run_id = $runId")) {
        rows.delete(String(params?.runId));
        return [[]];
      }
      return [[]];
    },
    capturedSql: [] as string[],
  };
}

function snapshot(runId: string, status: WorkflowRunState["status"] = "suspended"): WorkflowRunState {
  return {
    runId,
    status,
    value: {},
    context: { input: { prompt: "打开合同管理工作簿" } } as unknown as WorkflowRunState["context"],
    serializedStepGraph: [],
    activePaths: [],
    activeStepsPath: {},
    suspendedPaths: {},
    resumeLabels: {},
    waitingPaths: {},
    timestamp: 1_772_000_000_000,
  };
}

describe("SurrealWorkflowsStorage（绑定调用者 surrealSession）", () => {
  let rows: Map<string, Row>;
  let session: ReturnType<typeof fakeSession>;
  let storage: SurrealWorkflowsStorage;

  beforeEach(() => {
    rows = new Map();
    session = fakeSession(rows);
    storage = new SurrealWorkflowsStorage(() => ({ db: session as never, subject: "user:test" }));
  });

  test("persist 后能 load 回同一个暂停态，状态来自 snapshot", async () => {
    const state = snapshot("run-1", "suspended");
    await storage.persistWorkflowSnapshot({ workflowName: "router", runId: "run-1", snapshot: state });

    await expect(storage.loadWorkflowSnapshot({ workflowName: "router", runId: "run-1" })).resolves.toEqual(state);
    expect(rows.get("run-1")?.status).toBe("suspended");
  });

  test("storage 写入 owner_user 为调用者 subject 的 StringRecordId，不带 workspace 字段", async () => {
    const captured: Record<string, unknown>[] = [];
    const spySession = {
      query: async (_sql: string, params?: Record<string, unknown>) => {
        if (params?.content) captured.push(params.content as Record<string, unknown>);
        return [[]];
      },
    };
    const spyStorage = new SurrealWorkflowsStorage(() => ({ db: spySession as never, subject: "user:alice" }));
    await spyStorage.persistWorkflowSnapshot({ workflowName: "router", runId: "run-x", snapshot: snapshot("run-x") });

    expect(captured.length).toBeGreaterThan(0);
    for (const content of captured) {
      expect(content).toHaveProperty("owner_user");
      expect(String(content.owner_user)).toContain("user");
      expect(content).not.toHaveProperty("workspace");
    }
  });

  test("每次操作都从注入的 resolver 取当前会话", async () => {
    let calls = 0;
    const storageWithCounter = new SurrealWorkflowsStorage(() => {
      calls += 1;
      return { db: session as never, subject: "user:test" };
    });
    await storageWithCounter.persistWorkflowSnapshot({ workflowName: "router", runId: "run-2", snapshot: snapshot("run-2") });
    await storageWithCounter.loadWorkflowSnapshot({ workflowName: "router", runId: "run-2" });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("listWorkflowRuns 支持按 workflowName 过滤", async () => {
    await storage.persistWorkflowSnapshot({ workflowName: "router", runId: "router-run", snapshot: snapshot("router-run") });
    await storage.persistWorkflowSnapshot({ workflowName: "office-employee", runId: "emp-run", snapshot: snapshot("emp-run") });

    const result = await storage.listWorkflowRuns({ workflowName: "router" });
    expect(result.total).toBe(1);
    expect(result.runs.map((r) => r.runId)).toEqual(["router-run"]);
  });

  test("resourceId 会写入、回读，并可用于 listWorkflowRuns 过滤", async () => {
    const state = snapshot("run-resource");
    await storage.persistWorkflowSnapshot({
      workflowName: "router",
      runId: "run-resource",
      resourceId: "memory_resource:abc",
      snapshot: state,
    });
    await storage.persistWorkflowSnapshot({
      workflowName: "router",
      runId: "run-other",
      resourceId: "memory_resource:def",
      snapshot: snapshot("run-other"),
    });

    const loaded = await storage.getWorkflowRunById({ workflowName: "router", runId: "run-resource" });
    expect(loaded?.resourceId).toBe("memory_resource:abc");

    const result = await storage.listWorkflowRuns({ workflowName: "router", resourceId: "memory_resource:abc" });
    expect(result.total).toBe(1);
    expect(result.runs.map((r) => r.runId)).toEqual(["run-resource"]);
  });

  test("resume 语义：updateWorkflowState 把 status 从 suspended 改回 running", async () => {
    await storage.persistWorkflowSnapshot({ workflowName: "router", runId: "run-3", snapshot: snapshot("run-3", "suspended") });
    await storage.updateWorkflowState({ workflowName: "router", runId: "run-3", opts: { status: "running" } });

    const reloaded = await storage.loadWorkflowSnapshot({ workflowName: "router", runId: "run-3" });
    expect(reloaded?.status).toBe("running");
    expect(rows.get("run-3")?.status).toBe("running");
  });

  test("deleteWorkflowRunById 删除后 load 返回 null", async () => {
    await storage.persistWorkflowSnapshot({ workflowName: "router", runId: "run-4", snapshot: snapshot("run-4") });
    await storage.deleteWorkflowRunById({ workflowName: "router", runId: "run-4" });
    await expect(storage.loadWorkflowSnapshot({ workflowName: "router", runId: "run-4" })).resolves.toBeNull();
  });

  test("写入失败被吞掉，不抛到 workflow 引擎层（降级到内存态）", async () => {
    const failing = new SurrealWorkflowsStorage(() => ({ db: fakeSession(rows, { failWrites: true }) as never, subject: "user:test" }));
    await expect(
      failing.persistWorkflowSnapshot({ workflowName: "router", runId: "degraded", snapshot: snapshot("degraded") }),
    ).resolves.toBeUndefined();
  });
});
