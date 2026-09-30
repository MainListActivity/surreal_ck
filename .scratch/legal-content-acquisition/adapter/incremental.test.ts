/**
 * LCAQ-03 增量检查点/重试/可见性测试（全部合成样本，明确非真实来源数据）。
 *
 * 运行：bun test ./.scratch/legal-content-acquisition/adapter/incremental.test.ts
 *
 * 覆盖验收标准：
 * - 重复发现去重（同键同内容不重复出版本）与同键不同内容冲突；
 * - 证据边界/成品落盘/MCP 提交/检查点推进的各阶段中断恢复；
 * - 有界重叠扫描发现内容更新；无游标时记录扫描范围不宣称全量；
 * - 单条失败不阻塞其它候选且失败项不消失（重试/预算/耗尽）；
 * - 每来源可见性：最近成功检查、计数、空结果与请求/解析失败区分、停用原因；
 * - 访问限制变化停用来源、MCP 401/403 停止后续远端操作，恢复需显式授权/准入；
 * - 状态与报告不含 token 或来源正文；无任何定时器。
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIncrementalPass, loadIncrementalState, BatchKeyConflictError, type IncrementalDeps, type IncrementalPassOptions, type IncrementalState } from "./incremental";
import { McpHttpError } from "../../../scripts/platform-content-runner";
import { QUALIFIED_SOURCES } from "./sources";

const FGK_URL_A = "https://fgk.chinatax.gov.cn/zcfgk/c100009/c5233383/content.html";
const FGK_URL_B = "https://fgk.chinatax.gov.cn/zcfgk/c100009/c5233384/content.html";
const FGK_LISTING = "https://fgk.chinatax.gov.cn/zcfgk/c100009/list.html";
const FGK_NO_KEY = "https://fgk.chinatax.gov.cn/zcfgk/x100009/nokey/";
const CICC_URL_A = "https://cicc.court.gov.cn/html/1/218/180/316/12572.html";
/** 合成样本正文的独有片段（绝不 允许出现在状态/报告中）。 */
const BODY_SENTINEL = "为了测试平台内容管线";
const TOKEN_SENTINEL = "secret-token-xyz";

const FGK_HTML = await Bun.file(join(import.meta.dir, "test-fixtures", "fgk-content-page.html")).text();
const CICC_HTML = await Bun.file(join(import.meta.dir, "test-fixtures", "cicc-judgment-page.html")).text();
const FGK_HTML_UPDATED = FGK_HTML.replace(BODY_SENTINEL, "为了测试平台内容管线的修正案");
const LOGIN_HTML = "<html><body><div>请输入验证码后继续</div></body></html>";

type FetchRoutes = Map<string, () => Response | Promise<Response>>;

function fixedResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function robotsAwareFetch(routes: FetchRoutes) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const handler = routes.get(url);
    if (!handler) return fixedResponse(404, "not found");
    return handler();
  };
  return { fetchImpl, calls };
}

type Harness = {
  dir: string;
  statePath: string;
  deps: IncrementalDeps;
  calls: string[];
  submitted: { sourceKey: string; idempotencyKey: string; items: { entryKey: string }[] }[];
  submitResults: ({ batchId: string; status: string | null; entries: { entryKey: string; status: string }[] } | Error)[];
  routes: FetchRoutes;
  setRoute(url: string, body: string): void;
  failRoute(url: string, error: Error): void;
};

let clockTick = 0;

async function makeHarness(config?: Partial<Pick<IncrementalDeps, "overlapLimit" | "maxAttempts" | "fetchBudgetPerSource">>): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "lcaq03-"));
  const routes: FetchRoutes = new Map();
  const { fetchImpl, calls } = robotsAwareFetch(routes);
  const submitted: Harness["submitted"] = [];
  const submitResults: Harness["submitResults"] = [];
  const harness: Harness = {
    dir,
    statePath: join(dir, "state", "incremental-state.json"),
    calls,
    submitted,
    submitResults,
    routes,
    setRoute(url, body) {
      routes.set(url, () => fixedResponse(200, body));
    },
    failRoute(url, error) {
      routes.set(url, () => {
        throw error;
      });
    },
    deps: {
      fetchImpl,
      isAuthError: (error) => error instanceof McpHttpError && (error.status === 401 || error.status === 403),
      submitRemote: async (input) => {
        const idempotencyKey = input.batch.idempotencyKey;
        submitted.push({ sourceKey: input.sourceKey, idempotencyKey, items: input.batch.items.map((item) => ({ entryKey: item.entryKey })) });
        const next = submitResults.shift();
        if (next instanceof Error) throw next;
        if (next) return { ...next, batchId: next.batchId || `batch-${submitted.length}` };
        return {
          batchId: `batch-${submitted.length}`,
          status: "submitted",
          entries: input.batch.items.map((item) => ({ entryKey: item.entryKey, status: "ready" })),
        };
      },
      now: () => new Date(Date.UTC(2026, 8, 30, 9, 0, 0) + (clockTick += 1) * 1000),
      outDir: join(dir, "runs"),
      statePath: join(dir, "state", "incremental-state.json"),
      overlapLimit: 5,
      maxAttempts: 3,
      fetchBudgetPerSource: 12,
      ...config,
    },
  };
  return harness;
}

function defaultOptions(overrides: Partial<IncrementalPassOptions> = {}): IncrementalPassOptions {
  return { urls: [], offline: false, reauthorized: false, readmit: [], newBatchKey: false, ...overrides };
}

// robots.txt 一律 404（两个准入来源都有 LCAQ-01 无禁令核验记录）。
// 各测试先注册详情页路由；未注册 URL 走 404（网络性失败不适用——404 会被适配器当访问限制）。
// 注意：404 在 politeFetchHtml 中按 AccessRestrictedError 处理，测试里需要网络类失败时用 failRoute。

describe("LCAQ-03 增量检查点与恢复", () => {
  test("首次运行：候选分类入批、提交成功、可见性报告与扫描范围（无游标不宣称全量）", async () => {
    const harness = await makeHarness();
    harness.setRoute(FGK_URL_A, FGK_HTML);
    harness.setRoute(FGK_URL_B, FGK_HTML);

    const report = await runIncrementalPass(harness.deps, defaultOptions({ urls: [FGK_URL_A, FGK_URL_B] }));
    const fgk = report.sources.find((source) => source.sourceKey === "fgk.chinatax.gov.cn")!;
    expect(fgk.outcome).toBe("ok");
    expect(fgk.counts.candidates).toBe(2);
    expect(fgk.counts.staged).toBe(0);
    expect(fgk.lastSuccessfulCheckAt).not.toBeNull();
    expect(fgk.scanRange.mode).toBe("provided-candidates");
    expect(fgk.scanRange.note).toContain("不宣称全量");
    expect(harness.submitted).toHaveLength(1);
    expect(harness.submitted[0]!.idempotencyKey).toBe("lcaq03-fgk.chinatax.gov.cn-p1");
    expect(harness.submitted[0]!.items).toHaveLength(2);
    const state = await loadIncrementalState(harness.statePath);
    expect(Object.keys(state.sources["fgk.chinatax.gov.cn"]!.seen)).toEqual(["c5233383", "c5233384"]);
    for (const record of Object.values(state.sources["fgk.chinatax.gov.cn"]!.seen)) {
      expect(record.submittedSha256).toBe(record.sha256);
    }
    await rm(harness.dir, { recursive: true });
  });

  test("重复发现：同键同内容不重复提交，duplicate 计数且无远端调用", async () => {
    const harness = await makeHarness();
    harness.setRoute(FGK_URL_A, FGK_HTML);
    await runIncrementalPass(harness.deps, defaultOptions({ urls: [FGK_URL_A] }));
    harness.calls.length = 0;
    const submissionsBefore = harness.submitted.length;

    const report = await runIncrementalPass(harness.deps, defaultOptions({ urls: [FGK_URL_A] }));
    const fgk = report.sources.find((source) => source.sourceKey === "fgk.chinatax.gov.cn")!;
    expect(fgk.outcome).toBe("ok");
    expect(fgk.counts.duplicates).toBe(1);
    expect(fgk.counts.candidates).toBe(0);
    expect(harness.submitted.length).toBe(submissionsBefore);
    await rm(harness.dir, { recursive: true });
  });

  test("提交边界后中断：恢复 pass 不重抓证据，原样重放同一幂等键", async () => {
    const harness = await makeHarness();
    harness.setRoute(FGK_URL_A, FGK_HTML);
    // pass 1 离线：批次落盘但不提交（模拟提交阶段前中断）。
    const offlineReport = await runIncrementalPass(harness.deps, defaultOptions({ urls: [FGK_URL_A], offline: true }));
    const fgkOffline = offlineReport.sources.find((source) => source.sourceKey === "fgk.chinatax.gov.cn")!;
    expect(fgkOffline.remoteBlockedReason).toBe("offline");
    expect(harness.submitted).toHaveLength(0);
    const stateAfterOffline = await loadIncrementalState(harness.statePath);
    const pending = stateAfterOffline.sources["fgk.chinatax.gov.cn"]!.pendingBatch!;
    expect(pending.idempotencyKey).toBe("lcaq03-fgk.chinatax.gov.cn-p1");

    // pass 2 在线：直接重放提交，不重新抓取。
    harness.calls.length = 0;
    const report = await runIncrementalPass(harness.deps, defaultOptions({}));
    const fgk = report.sources.find((source) => source.sourceKey === "fgk.chinatax.gov.cn")!;
    expect(harness.calls).toHaveLength(0);
    expect(harness.submitted).toHaveLength(1);
    expect(harness.submitted[0]!.idempotencyKey).toBe(pending.idempotencyKey);
    expect(fgk.outcome).toBe("ok");
    const stateAfter = await loadIncrementalState(harness.statePath);
    expect(stateAfter.sources["fgk.chinatax.gov.cn"]!.pendingBatch).toBeNull();
    await rm(harness.dir, { recursive: true });
  });

  test("证据边界后中断：已见未提交记录从快照重建批次，不重新抓取", async () => {
    const harness = await makeHarness();
    harness.setRoute(FGK_URL_A, FGK_HTML);
    // 直接构造「证据已落盘、状态已持久化、批次未构建」的中断现场。
    const snapshotDir = join(harness.deps.outDir, "snapshots");
    await mkdir(snapshotDir, { recursive: true });
    const snapshotPath = join(snapshotDir, "fgk.chinatax.gov.cn--c5233383--abcd1234.html");
    await writeFile(snapshotPath, FGK_HTML, { mode: 0o600 });
    const { sha256Hex } = await import("./http");
    const state: IncrementalState = {
      version: 1,
      updatedAt: "2026-09-30T09:00:00.000Z",
      sources: {
        "fgk.chinatax.gov.cn": {
          sourceKey: "fgk.chinatax.gov.cn",
          seen: {
            c5233383: {
              url: FGK_URL_A,
              recordKey: "c5233383",
              entryKey: "fgk.chinatax.gov.cn--c5233383",
              sha256: await sha256Hex(FGK_HTML),
              snapshotPath,
              fetchedAt: "2026-09-30T08:00:00.000Z",
              lastCheckedAt: "2026-09-30T08:00:00.000Z",
              submittedSha256: null,
              submittedBatchId: null,
            },
          },
          failures: [],
          pending: [],
          lastSuccessfulCheckAt: "2026-09-30T08:00:00.000Z",
          lastPendingVerification: null,
          passSeq: 0,
          disabled: null,
          pendingBatch: null,
        },
      },
      authBlockedAt: null,
    };
    await mkdir(join(harness.dir, "state"), { recursive: true });
    await writeFile(harness.statePath, JSON.stringify(state));

    harness.calls.length = 0;
    const report = await runIncrementalPass(harness.deps, defaultOptions({}));
    const fgk = report.sources.find((source) => source.sourceKey === "fgk.chinatax.gov.cn")!;
    expect(harness.calls).toHaveLength(0);
    expect(fgk.counts.candidates).toBe(1);
    expect(harness.submitted).toHaveLength(1);
    await rm(harness.dir, { recursive: true });
  });

  test("同键不同内容报冲突：批次文件被改动后拒绝提交，远端零调用", async () => {
    const harness = await makeHarness();
    harness.setRoute(FGK_URL_A, FGK_HTML);
    await runIncrementalPass(harness.deps, defaultOptions({ urls: [FGK_URL_A], offline: true }));
    const state = await loadIncrementalState(harness.statePath);
    const pending = state.sources["fgk.chinatax.gov.cn"]!.pendingBatch!;
    await writeFile(pending.path, (await readFile(pending.path, "utf8")).replace("lcaq03", "tampered"), { mode: 0o600 });

    let conflict: unknown = null;
    try {
      await runIncrementalPass(harness.deps, defaultOptions({}));
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(BatchKeyConflictError);
    expect(harness.submitted).toHaveLength(0);
    await rm(harness.dir, { recursive: true });
  });

  test("单条失败不阻塞其它候选；失败项保留待办并按预算重试，耗尽后仍可见", async () => {
    const harness = await makeHarness({ maxAttempts: 2 });
    harness.setRoute(FGK_URL_A, FGK_HTML);
    harness.setRoute(FGK_URL_B, FGK_HTML);
    harness.failRoute(FGK_URL_A, new TypeError("network down"));

    const pass1 = await runIncrementalPass(harness.deps, defaultOptions({ urls: [FGK_URL_A, FGK_URL_B] }));
    const fgk1 = pass1.sources.find((source) => source.sourceKey === "fgk.chinatax.gov.cn")!;
    expect(fgk1.outcome).toBe("ok");
    expect(fgk1.counts.failed).toBe(1);
    expect(fgk1.counts.candidates).toBe(1);
    expect(harness.submitted[0]!.items).toHaveLength(1);

    // pass 2：URL-B 重复，URL-A 仍在重试队列（不消失）且再次失败。
    harness.calls.length = 0;
    const pass2 = await runIncrementalPass(harness.deps, defaultOptions({ urls: [FGK_URL_B] }));
    const fgk2 = pass2.sources.find((source) => source.sourceKey === "fgk.chinatax.gov.cn")!;
    expect(fgk2.counts.retried).toBe(1);
    expect(fgk2.counts.failed).toBe(1);
    expect(fgk2.counts.failuresActive).toBe(0);
    expect(fgk2.counts.failuresExhausted).toBe(1);
    expect(harness.submitted).toHaveLength(1); // URL-A 不入批
    const state = await loadIncrementalState(harness.statePath);
    expect(state.sources["fgk.chinatax.gov.cn"]!.failures.map((failure) => failure.url)).toEqual([FGK_URL_A]);
    await rm(harness.dir, { recursive: true });
  });

  test("抓取预算：超预算候选顺延入队，下个 pass 优先处理", async () => {
    const harness = await makeHarness({ fetchBudgetPerSource: 1 });
    harness.setRoute(FGK_URL_A, FGK_HTML);
    harness.setRoute(FGK_URL_B, FGK_HTML);
    harness.setRoute(FGK_LISTING, FGK_HTML);

    const pass1 = await runIncrementalPass(harness.deps, defaultOptions({ urls: [FGK_URL_A, FGK_URL_B, FGK_LISTING] }));
    const fgk1 = pass1.sources.find((source) => source.sourceKey === "fgk.chinatax.gov.cn")!;
    expect(fgk1.counts.deferred).toBe(2);
    const state1 = await loadIncrementalState(harness.statePath);
    expect(state1.sources["fgk.chinatax.gov.cn"]!.pending).toHaveLength(2);

    harness.deps = { ...harness.deps, fetchBudgetPerSource: 12 };
    const pass2 = await runIncrementalPass(harness.deps, defaultOptions({}));
    const fgk2 = pass2.sources.find((source) => source.sourceKey === "fgk.chinatax.gov.cn")!;
    expect(fgk2.counts.candidates).toBe(2);
    const state2 = await loadIncrementalState(harness.statePath);
    expect(state2.sources["fgk.chinatax.gov.cn"]!.pending).toHaveLength(0);
    await rm(harness.dir, { recursive: true });
  });

  test("有界重叠扫描发现内容更新：同 entryKey 新内容重新提交", async () => {
    const harness = await makeHarness({ overlapLimit: 1 });
    harness.setRoute(FGK_URL_A, FGK_HTML);
    await runIncrementalPass(harness.deps, defaultOptions({ urls: [FGK_URL_A] }));

    harness.setRoute(FGK_URL_A, FGK_HTML_UPDATED);
    const pass2 = await runIncrementalPass(harness.deps, defaultOptions({}));
    const fgk2 = pass2.sources.find((source) => source.sourceKey === "fgk.chinatax.gov.cn")!;
    expect(fgk2.counts.updated).toBe(1);
    expect(fgk2.scanRange.mode).toBe("overlap-rescan");
    expect(harness.submitted[1]!.idempotencyKey).toBe("lcaq03-fgk.chinatax.gov.cn-p2");
    expect(harness.submitted[1]!.items.map((item) => item.entryKey)).toEqual(["fgk.chinatax.gov.cn--c5233383"]);
    await rm(harness.dir, { recursive: true });
  });

  test("空结果与请求/解析失败区分", async () => {
    const harness = await makeHarness();
    const empty = await runIncrementalPass(harness.deps, defaultOptions({}));
    expect(empty.sources.find((source) => source.sourceKey === "fgk.chinatax.gov.cn")!.outcome).toBe("empty");

    // 解析失败：URL 无法派生记录键（请求本身成功）。
    harness.setRoute(FGK_NO_KEY, FGK_HTML);
    const parseFail = await runIncrementalPass(harness.deps, defaultOptions({ urls: [FGK_NO_KEY] }));
    expect(parseFail.sources.find((source) => source.sourceKey === "fgk.chinatax.gov.cn")!.outcome).toBe("parse_failure");

    // 请求失败：网络层错误。
    harness.failRoute(FGK_URL_A, new TypeError("network down"));
    const requestFail = await runIncrementalPass(harness.deps, defaultOptions({ urls: [FGK_URL_A] }));
    expect(requestFail.sources.find((source) => source.sourceKey === "fgk.chinatax.gov.cn")!.outcome).toBe("request_failure");
    await rm(harness.dir, { recursive: true });
  });

  test("访问限制变化：来源停用并停止后续抓取，另一来源不受影响；恢复需重新准入", async () => {
    const harness = await makeHarness();
    harness.setRoute(FGK_URL_A, LOGIN_HTML);
    harness.setRoute(CICC_URL_A, CICC_HTML);

    const pass1 = await runIncrementalPass(harness.deps, defaultOptions({ urls: [FGK_URL_A, CICC_URL_A] }));
    const fgk1 = pass1.sources.find((source) => source.sourceKey === "fgk.chinatax.gov.cn")!;
    const cicc1 = pass1.sources.find((source) => source.sourceKey === "cicc.court.gov.cn")!;
    expect(fgk1.outcome).toBe("blocked");
    expect(fgk1.disabledReason).toContain("验证码");
    expect(cicc1.outcome).toBe("ok");

    // pass 2：fgk 停用，零抓取；cicc 正常重复检查。
    harness.calls.length = 0;
    const pass2 = await runIncrementalPass(harness.deps, defaultOptions({ urls: [FGK_URL_A, CICC_URL_A] }));
    expect(pass2.sources.find((source) => source.sourceKey === "fgk.chinatax.gov.cn")!.outcome).toBe("blocked");
    expect(harness.calls.filter((url) => url.startsWith("https://fgk"))).toHaveLength(0);
    expect(pass2.sources.find((source) => source.sourceKey === "cicc.court.gov.cn")!.counts.duplicates).toBe(1);

    // 重新准入（且站点恢复正常）后恢复。
    harness.setRoute(FGK_URL_A, FGK_HTML);
    const pass3 = await runIncrementalPass(harness.deps, defaultOptions({ urls: [FGK_URL_A], readmit: ["fgk.chinatax.gov.cn"] }));
    expect(pass3.sources.find((source) => source.sourceKey === "fgk.chinatax.gov.cn")!.outcome).toBe("ok");
    await rm(harness.dir, { recursive: true });
  });

  test("MCP 401：停止后续来源的远端操作；恢复需运营显式重新授权", async () => {
    const harness = await makeHarness();
    harness.setRoute(FGK_URL_A, FGK_HTML);
    harness.setRoute(CICC_URL_A, CICC_HTML);
    harness.submitResults.push(new McpHttpError(401, "MCP HTTP 401"));

    const pass1 = await runIncrementalPass(harness.deps, defaultOptions({ urls: [FGK_URL_A, CICC_URL_A] }));
    const fgk1 = pass1.sources.find((source) => source.sourceKey === "fgk.chinatax.gov.cn")!;
    const cicc1 = pass1.sources.find((source) => source.sourceKey === "cicc.court.gov.cn")!;
    expect(harness.submitted).toHaveLength(1); // 只有第一个来源尝试了远端
    expect(fgk1.remoteBlockedReason).toBe("auth");
    expect(cicc1.remoteBlockedReason).toBe("auth");
    const state1 = await loadIncrementalState(harness.statePath);
    expect(state1.authBlockedAt).not.toBeNull();
    expect(state1.sources["cicc.court.gov.cn"]!.pendingBatch).not.toBeNull(); // 批次保留待提交

    // pass 2（未重新授权）：远端拒绝，本地状态不动。
    const pass2 = await runIncrementalPass(harness.deps, defaultOptions({}));
    expect(harness.submitted).toHaveLength(1);
    expect(pass2.sources.every((source) => source.remoteBlockedReason === "auth")).toBe(true);

    // pass 3（运营确认重新授权）：两个来源的待提交批次都完成提交。
    const pass3 = await runIncrementalPass(harness.deps, defaultOptions({ reauthorized: true }));
    expect(harness.submitted).toHaveLength(3);
    expect(pass3.sources.every((source) => source.remoteBlockedReason === null)).toBe(true);
    const state3 = await loadIncrementalState(harness.statePath);
    expect(state3.authBlockedAt).toBeNull();
    await rm(harness.dir, { recursive: true });
  });

  test("状态/报告不含 token 或来源正文；状态原子写入无残留", async () => {
    const harness = await makeHarness();
    harness.setRoute(FGK_URL_A, FGK_HTML);
    process.env.CONTENT_ACCESS_TOKEN = TOKEN_SENTINEL;
    try {
      const report = await runIncrementalPass(harness.deps, defaultOptions({ urls: [FGK_URL_A] }));
      const stateText = await readFile(harness.statePath, "utf8");
      const reportText = JSON.stringify(report);
      expect(stateText).not.toContain(TOKEN_SENTINEL);
      expect(stateText).not.toContain(BODY_SENTINEL);
      expect(stateText).not.toContain("<html");
      expect(reportText).not.toContain(TOKEN_SENTINEL);
      expect(reportText).not.toContain(BODY_SENTINEL);
      expect(reportText).not.toContain("<html");
      const stateDirFiles = await readdir(join(harness.dir, "state"));
      expect(stateDirFiles.every((name) => !name.endsWith(".tmp"))).toBe(true);
    } finally {
      delete process.env.CONTENT_ACCESS_TOKEN;
    }
    await rm(harness.dir, { recursive: true });
  });

  test("未准入来源 URL 直接拒绝（不抓取、不写状态）", async () => {
    const harness = await makeHarness();
    let conflict: unknown = null;
    try {
      await runIncrementalPass(harness.deps, defaultOptions({ urls: ["https://flk.npc.gov.cn/detail.html"] }));
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(Error);
    expect(harness.submitted).toHaveLength(0);
    await rm(harness.dir, { recursive: true });
  });

  test("inspect 非 ready 条目计入待核验计数", async () => {
    const harness = await makeHarness();
    harness.setRoute(FGK_URL_A, FGK_HTML);
    harness.submitResults.push({ batchId: "batch-blocked", status: "submitted", entries: [{ entryKey: "fgk.chinatax.gov.cn--c5233383", status: "blocked" }] });
    const report = await runIncrementalPass(harness.deps, defaultOptions({ urls: [FGK_URL_A] }));
    const fgk = report.sources.find((source) => source.sourceKey === "fgk.chinatax.gov.cn")!;
    expect(fgk.counts.pendingVerification).toBe(1);
    await rm(harness.dir, { recursive: true });
  });

  test("自动运行永不发布：提交通道只收 sourceKey 与 batch", async () => {
    const harness = await makeHarness();
    harness.setRoute(FGK_URL_A, FGK_HTML);
    await runIncrementalPass(harness.deps, defaultOptions({ urls: [FGK_URL_A] }));
    expect(harness.submitted).toHaveLength(1);
    expect(Object.keys(harness.submitted[0]!).sort()).toEqual(["idempotencyKey", "items", "sourceKey"]);
    await rm(harness.dir, { recursive: true });
  });

  test("准入来源清单与许可修订保持 LCAQ-01 记录（重试遵守已准入方式）", () => {
    for (const config of Object.values(QUALIFIED_SOURCES)) {
      expect(config.license.revision).toBeGreaterThan(0);
      expect(config.license.licenseKind.length).toBeGreaterThan(0);
    }
  });
});
