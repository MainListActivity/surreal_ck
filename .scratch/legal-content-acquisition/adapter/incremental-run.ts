/**
 * LCAQ-03 增量采集 CLI（单次运行；本工具不创建任何定时器或守护进程）。
 *
 * 周期运行必须由运营显式配置的本地 scheduler（如 cron）调用本命令；
 * 未配置 scheduler 时不会有任何自动运行。自动（默认）模式只提交与 inspect，
 * 永不发布：发布只能在 MCP 运营端显式进行。
 *
 * 用法：
 *   bun incremental-run.ts --url <详情页> [--url ...] [--out runs/<dir>] [--state runs/incremental-state.json]
 *                          [--offline] [--reauthorized] [--readmit <sourceKey>...] [--new-batch-key]
 *
 * - 离线/未配置 MCP 凭证：只做证据快照与批次暂存，远端提交自动顺延（离线恢复）。
 * - 401/403 后：后续 pass 拒绝远端操作，运营重新完成 OAuth 授权后用 --reauthorized 恢复。
 * - 来源停用（访问限制/许可变化）后：用 --readmit <sourceKey> 表示已重新准入。
 * - 批次冲突（同键不同内容）：确认开新批次时用 --new-batch-key。
 * - 退出码：冲突/来源停用/授权停止 → 1（调度器可感知），正常 → 0。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { McpHttpError, submitAndInspectBatch } from "../../../scripts/platform-content-runner";
import {
  loadIncrementalState,
  runIncrementalPass,
  saveStateAtomically,
  type IncrementalDeps,
  type IncrementalPassOptions,
  type IncrementalState,
} from "./incremental";

function flagValue(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function flag(name: string): boolean {
  return Bun.argv.includes(name);
}

function flagValues(name: string): string[] {
  return Bun.argv.filter((arg, index) => Bun.argv[index - 1] === name);
}

function numericFlag(name: string, fallback: number): number {
  const raw = flagValue(name);
  const parsed = raw === undefined || raw.startsWith("--") ? fallback : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * 生产提交通道（导出供测试复现真实装配）。
 * 复用 LCM-09 runner：submit + inspect + 原子检查点；无 --publish 通路。
 * 批次键生命周期由引擎 pendingBatch 管理（同键同内容复用、同键不同内容报冲突）；
 * runner 检查点在此退化为「该来源最近提交进度」指针，故 force 放开多键守卫——
 * 绝不能去掉 force：引擎每 pass 生成新批次键，守卫会永久拒绝第二笔起的提交。
 */
export function makeSubmitRemote(input: {
  mcpUrl: string;
  accessToken: string;
  outDir: string;
  fetchImpl?: typeof fetch;
}): IncrementalDeps["submitRemote"] {
  return async ({ sourceKey, batch }) => {
    const result = await submitAndInspectBatch({
      mcpUrl: input.mcpUrl,
      accessToken: input.accessToken,
      batch,
      checkpointPath: join(input.outDir, `runner-checkpoint-${sourceKey}.json`),
      force: true,
      fetchImpl: input.fetchImpl,
    });
    return { batchId: result.batchId, status: result.batchStatus, entries: result.entries };
  };
}

async function main(): Promise<void> {
  const urls = flagValues("--url");
  const readmit = flagValues("--readmit");
  if (urls.length === 0 && readmit.length === 0 && !flag("--reauthorized")) {
    throw new Error("请提供 --url <详情页 URL>（可多次），或显式恢复操作（--reauthorized / --readmit <sourceKey>）");
  }

  const outDir = flagValue("--out") ?? "runs";
  const statePath = flagValue("--state") ?? join(outDir, "incremental-state.json");
  await mkdir(outDir, { recursive: true });

  const mcpUrl = process.env.CONTENT_MCP_URL?.trim() ?? "";
  const accessToken = process.env.CONTENT_ACCESS_TOKEN?.trim() ?? "";
  const offline = flag("--offline") || mcpUrl === "" || accessToken === "";

  const deps: IncrementalDeps = {
    fetchImpl: fetch,
    isAuthError: (error) => error instanceof McpHttpError && (error.status === 401 || error.status === 403),
    submitRemote: makeSubmitRemote({ mcpUrl, accessToken, outDir }),
    now: () => new Date(),
    outDir,
    statePath,
    overlapLimit: numericFlag("--overlap-limit", 5),
    maxAttempts: numericFlag("--max-attempts", 3),
    fetchBudgetPerSource: numericFlag("--fetch-budget", 12),
  };

  const options: IncrementalPassOptions = {
    urls,
    offline,
    reauthorized: flag("--reauthorized"),
    readmit,
    newBatchKey: flag("--new-batch-key"),
  };

  // --new-batch-key：运营确认废弃当前待提交批次（保留证据与游标），开新批次键。
  if (options.newBatchKey) {
    const state: IncrementalState = await loadIncrementalState(statePath);
    for (const source of Object.values(state.sources)) {
      if (!source.pendingBatch) continue;
      source.pendingBatch = null;
      source.passSeq += 1;
    }
    await saveStateAtomically(statePath, state);
  }

  const report = await runIncrementalPass(deps, options);

  // 运行可见性产物：报告只含键/URL/摘要/计数，绝不含 token 或来源正文。
  const reportPath = join(outDir, "last-pass-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));

  const degraded = report.sources.some((source) => source.outcome === "blocked" || source.remoteBlockedReason === "auth" || source.remoteBlockedReason === "offline");
  if (degraded) process.exitCode = 1;
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "增量采集失败");
    process.exitCode = 1;
  });
}
