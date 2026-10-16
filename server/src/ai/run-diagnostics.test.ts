import { describe, expect, test } from "bun:test";
import {
  AiCallerQueryTimeoutError,
  AiRunCancelledError,
  AiToolTimeoutError,
  boundedAwait,
  createRunDiagnostics,
  firstAbortOf,
  outcomeForError,
  resolveRunDiagnosticsConfig,
  stableErrorCode,
} from "./run-diagnostics";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("resolveRunDiagnosticsConfig", () => {
  test("拒绝非正数 / 无界值（0、负数、NaN、Infinity）", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(() => resolveRunDiagnosticsConfig({ queryTimeoutMs: bad })).toThrow(TypeError);
      expect(() => resolveRunDiagnosticsConfig({ toolTimeoutMs: bad })).toThrow(TypeError);
    }
  });

  test("默认上界：connect/query 30s、tool 60s、审计写 5s", () => {
    const c = resolveRunDiagnosticsConfig();
    expect(c.connectTimeoutMs).toBe(30_000);
    expect(c.queryTimeoutMs).toBe(30_000);
    expect(c.toolTimeoutMs).toBe(60_000);
    expect(c.auditWriteTimeoutMs).toBe(5_000);
  });
});

describe("stableErrorCode / outcomeForError", () => {
  test("优先显式 code，其次 name，不落 message", () => {
    expect(stableErrorCode(new AiToolTimeoutError("analyzeRow"))).toBe("ai-tool-timeout");
    expect(stableErrorCode(new Error("机密细节 abc123"))).toBe("Error");
    expect(stableErrorCode({ code: "custom-code" })).toBe("custom-code");
    expect(stableErrorCode("裸字符串")).toBe("Error");
  });

  test("终态归类：超时 → timeout、取消 → cancelled、其余 → failed", () => {
    expect(outcomeForError(new AiToolTimeoutError("x"))).toBe("timeout");
    expect(outcomeForError(new AiCallerQueryTimeoutError())).toBe("timeout");
    expect(outcomeForError(new AiRunCancelledError())).toBe("cancelled");
    expect(outcomeForError(new DOMException("aborted", "AbortError"))).toBe("cancelled");
    expect(outcomeForError(new Error("业务失败"))).toBe("failed");
  });
});

describe("boundedAwait", () => {
  test("永不返回的内部 promise 在时限内抛具名超时；迟到 settle 被吞掉不炸进程", async () => {
    let lateResolved = false;
    const hanging = new Promise<string>((resolve) =>
      setTimeout(() => {
        lateResolved = true;
        resolve("late");
      }, 150));

    const startedAt = Date.now();
    const error = await boundedAwait(hanging, {
      timeoutMs: 30,
      timeoutError: () => new AiCallerQueryTimeoutError("query"),
    }).then(() => null, (e: unknown) => e);

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(error).toBeInstanceOf(AiCallerQueryTimeoutError);
    expect((error as AiCallerQueryTimeoutError).code).toBe("ai-caller-query-timeout");

    await tick(200);
    expect(lateResolved).toBe(true);
  });

  test("上游 abort → AiRunCancelledError，且不等待内部 settle", async () => {
    const controller = new AbortController();
    const promise = boundedAwait(new Promise(() => {}), {
      timeoutMs: 30_000,
      signal: controller.signal,
      timeoutError: () => new AiToolTimeoutError("x"),
    });
    controller.abort();
    const error = await promise.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AiRunCancelledError);
    expect((error as AiRunCancelledError).code).toBe("ai-run-cancelled");
  });

  test("信号已 aborted 时立即拒绝", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await boundedAwait(Promise.resolve("ok"), {
      timeoutMs: 30_000,
      signal: controller.signal,
      timeoutError: () => new AiToolTimeoutError("x"),
    }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AiRunCancelledError);
  });
});

describe("firstAbortOf", () => {
  test("无信号 → undefined；任一触发 → 合成信号 aborted", () => {
    expect(firstAbortOf([])).toBeUndefined();
    const a = new AbortController();
    const b = new AbortController();
    const merged = firstAbortOf([a.signal, b.signal])!;
    expect(merged.aborted).toBe(false);
    b.abort();
    expect(merged.aborted).toBe(true);
  });
});

describe("RunDiagnostics 记账与快照", () => {
  test("begin/end 记终态与时长；快照分出 inFlight 与 completed", async () => {
    const diag = createRunDiagnostics();
    const done = diag.begin({ name: "SELECT", phase: "query", argShape: ["sheet"] });
    await tick(5);
    diag.end(done, "ok");
    diag.begin({ name: "analyzeRow", phase: "tool", argShape: ["sheetId", "recordId"] });

    const snap = diag.snapshot("running");
    expect(snap.inFlight.map((op) => op.name)).toEqual(["analyzeRow"]);
    expect(snap.inFlight[0]?.phase).toBe("tool");
    expect(snap.inFlight[0]?.argShape).toEqual(["sheetId", "recordId"]);
    expect(snap.completed.map((op) => op.name)).toEqual(["SELECT"]);
    expect(snap.completed[0]?.status).toBe("ok");
    expect(typeof snap.completed[0]?.durationMs).toBe("number");
    expect(snap.totals).toEqual({ started: 2, finished: 1 });
    expect(snap.limits.toolTimeoutMs).toBe(60_000);
  });

  test("取消信号触发：在途 op 立即记 cancelled，不等被挂起的执行体返回", async () => {
    const diag = createRunDiagnostics();
    const controller = new AbortController();
    diag.bindRun({ signal: controller.signal, runId: "run-1" });

    const finished = diag.begin({ name: "SELECT", phase: "query" });
    diag.end(finished, "ok");
    diag.begin({ name: "analyzeRow", phase: "tool" });
    diag.begin({ name: "UPDATE", phase: "query" });

    controller.abort();
    const snap = diag.snapshot("cancelled");
    expect(snap.aborted).toBe(true);
    expect(snap.runId).toBe("run-1");
    expect(snap.inFlight).toHaveLength(0);
    const byName = new Map(snap.completed.map((op) => [op.name, op.status]));
    expect(byName.get("SELECT")).toBe("ok");
    expect(byName.get("analyzeRow")).toBe("cancelled");
    expect(byName.get("UPDATE")).toBe("cancelled");
    expect(snap.completed.find((op) => op.name === "analyzeRow")?.error).toBe("ai-run-cancelled");
  });

  test("track：超时记 timeout + 置 fatal + 触发 cancelRun", async () => {
    let cancelled = 0;
    const diag = createRunDiagnostics({ queryTimeoutMs: 20 });
    diag.bindRun({ cancelRun: () => { cancelled += 1; } });

    const error = await diag.track(
      { name: "SELECT", phase: "query" },
      new Promise(() => {}),
      { timeoutMs: 20, timeoutError: () => new AiCallerQueryTimeoutError("query") },
    ).then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(AiCallerQueryTimeoutError);
    expect(diag.fatalError).toBe(error);
    expect(cancelled).toBe(1);
    const snap = diag.snapshot("failed");
    expect(snap.fatalError).toBe("ai-caller-query-timeout");
    expect(snap.completed[0]?.status).toBe("timeout");
  });

  test("track：业务错误记 failed 且不置 fatal（原错误原样上抛）", async () => {
    const diag = createRunDiagnostics();
    const business = new Error("找不到数据表定义");
    const error = await diag.track(
      { name: "SELECT", phase: "query" },
      Promise.reject(business),
      { timeoutMs: 1000, timeoutError: () => new AiCallerQueryTimeoutError() },
    ).then(() => null, (e: unknown) => e);
    expect(error).toBe(business);
    expect(diag.fatalError).toBeUndefined();
    expect(diag.snapshot("x").completed[0]?.status).toBe("failed");
  });

  test("span：同步段记账（result-processing），抛错记 failed", () => {
    const diag = createRunDiagnostics();
    expect(diag.span({ name: "rows", phase: "result-processing" }, () => 42)).toBe(42);
    expect(() =>
      diag.span({ name: "rows", phase: "result-processing" }, () => {
        throw new Error("bad");
      }),
    ).toThrow("bad");
    const snap = diag.snapshot("x");
    expect(snap.completed.map((op) => [op.phase, op.status])).toEqual([
      ["result-processing", "ok"],
      ["result-processing", "failed"],
    ]);
  });

  test("effectiveMs = min(配置, 剩余期限)；已过期时给 1ms 下界；deadline 只认首次绑定", () => {
    const now = Date.now();
    const diag = createRunDiagnostics({ queryTimeoutMs: 30_000 });
    diag.bindRun({ deadlineAt: now + 100 });
    expect(diag.effectiveMs(30_000)).toBe(100);
    // 重复绑定不覆盖首个 deadline（bindRun ??= 语义）。
    diag.bindRun({ deadlineAt: now + 999_999 });
    expect(diag.effectiveMs(30_000)).toBe(100);

    const expired = createRunDiagnostics({ queryTimeoutMs: 30_000 });
    expired.bindRun({ deadlineAt: now - 10 });
    expect(expired.effectiveMs(30_000)).toBe(1);
  });

  test("argShape 超过上限被截断", () => {
    const diag = createRunDiagnostics({ maxArgShapeEntries: 3 });
    diag.begin({ name: "t", phase: "tool", argShape: ["a", "b", "c", "d", "e"] });
    expect(diag.snapshot("x").inFlight[0]?.argShape).toEqual(["a", "b", "c"]);
  });

  test("快照为纯 JSON 可序列化（脱敏自检）", () => {
    const diag = createRunDiagnostics();
    diag.begin({ name: "SELECT", phase: "query", argShape: ["recordId"] });
    const json = JSON.parse(JSON.stringify(diag.snapshot("x"))) as { inFlight: unknown[] };
    expect(json.inFlight).toHaveLength(1);
  });
});
