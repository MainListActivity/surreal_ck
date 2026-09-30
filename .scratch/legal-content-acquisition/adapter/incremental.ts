/**
 * LCAQ-03 本地增量检查点、重试与运行可见性。
 *
 * 在 LCAQ-02 采集适配器与 LCM-09 runner 之上增加每来源持久化状态：
 * - 发现游标：seen 记录（recordKey → 快照摘要/路径/fetchedAt/已提交摘要）；
 * - 有界重叠窗口：每 pass 复查最近 N 条已提交记录，迟到文书/内容更新由此发现；
 * - 失败与重试状态：单条失败记录 attempts 与错误类别，不阻塞其它候选，也不从待办消失；
 * - 可重放边界：证据获取 → 成品落盘 → MCP 提交 → 检查点推进，各阶段后原子持久化状态；
 *   中断恢复不重复发布（同幂等键同内容复用批次，同键不同内容报冲突）；
 * - 停止条件：来源访问限制/许可变化即停用来源；MCP 401/403 停止后续远端操作，
 *   恢复需运营显式重新授权（--reauthorized）/重新准入（--readmit）；
 * - 运行可见性：每来源报告最近成功检查时间、扫描范围（有界，不宣称全量）、
 *   候选/重复/更新/失败/待核验/暂存计数与停用原因；空结果与请求/解析失败区分。
 *
 * 本模块不做任何调度：周期运行必须由运营显式配置的外部 scheduler 调用单次命令。
 * 状态与报告只含键、URL、摘要与计数，绝不含 token 或来源正文。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IngestionBatch, IngestionEntry } from "./deps";
import { PLATFORM_CONTENT_CONTRACT_VERSION } from "./deps";
import { politeFetchHtml, sha256Hex } from "./http";
import { extractJudgmentPage } from "./judgment";
import { extractLegislationPage } from "./legislation";
import { buildJudgmentEntry, buildLegislationEntry, validateBatch } from "./emit";
import { AccessRestrictedError, QUALIFIED_SOURCES, recordKeyForUrl, requireQualifiedSource } from "./sources";

// ─── 持久化状态（只含键/URL/摘要/计数，绝不含 token 或来源正文） ────────────────

export type SeenRecord = Readonly<{
  url: string;
  recordKey: string;
  entryKey: string;
  /** 最近一次核验的页面快照摘要。 */
  sha256: string;
  snapshotPath: string;
  fetchedAt: string;
  lastCheckedAt: string;
  /** 已提交到 MCP 的内容摘要；null = 已见未提交（中断恢复后自动重建批次）。 */
  submittedSha256: string | null;
  submittedBatchId: string | null;
}>;

export type FailedCandidate = {
  url: string;
  recordKey: string | null;
  attempts: number;
  firstFailedAt: string;
  lastFailedAt: string;
  lastError: { kind: "request" | "parse"; message: string };
};

export type PendingBatch = Readonly<{
  idempotencyKey: string;
  path: string;
  /** 构建时的批次内容摘要；复用前与磁盘文件核对。 */
  sha256: string;
  recordKeys: readonly string[];
  builtAt: string;
}>;

export type SourceState = {
  sourceKey: string;
  seen: Record<string, SeenRecord>;
  failures: FailedCandidate[];
  /** 预算未覆盖的候选（跨 pass 持久排队，不丢失）。 */
  pending: string[];
  lastSuccessfulCheckAt: string | null;
  /** 最近一次提交中 inspect 非 ready 的条目数（运营待核验）。 */
  lastPendingVerification: number | null;
  passSeq: number;
  disabled: { reason: string; at: string } | null;
  pendingBatch: PendingBatch | null;
};

export type IncrementalState = {
  version: 1;
  updatedAt: string;
  sources: Record<string, SourceState>;
  /** MCP 401/403 后置位（授权全局有效）；恢复需运营显式重新授权。 */
  authBlockedAt: string | null;
};

// ─── 运行报告（可见性） ────────────────────────────────────────────────────────

export type SourceOutcome = "ok" | "empty" | "request_failure" | "parse_failure" | "blocked" | "conflict";

export type ScanRange = Readonly<{
  /** provided-candidates=首扫（无游标）；overlap-rescan=有界重叠复查；none=本 pass 无检查。 */
  mode: "provided-candidates" | "overlap-rescan" | "none";
  checkedUrls: number;
  /** 有界范围的诚实说明；绝不宣称全量。 */
  note: string;
}>;

export type SourceCounts = Readonly<{
  candidates: number;
  duplicates: number;
  updated: number;
  failed: number;
  retried: number;
  deferred: number;
  pendingVerification: number;
  staged: number;
  failuresActive: number;
  failuresExhausted: number;
}>;

export type SourceReport = Readonly<{
  sourceKey: string;
  kind: "legislation" | "judicial_document";
  outcome: SourceOutcome;
  disabledReason: string | null;
  /** 本 pass 该来源远端操作为何未执行：授权停止 / 离线 / 停用 / 无批次。 */
  remoteBlockedReason: "auth" | "offline" | "disabled" | null;
  lastSuccessfulCheckAt: string | null;
  scanRange: ScanRange;
  counts: SourceCounts;
}>;

export type PassReport = Readonly<{
  runAt: string;
  statePath: string;
  sources: readonly SourceReport[];
  /** 本 pass 的提交尝试（成功/被阻塞/失败均记录键与摘要，不含 token）。 */
  submissions: readonly { sourceKey: string; idempotencyKey: string; batchId: string | null; error: string | null }[];
}>;

// ─── 错误类型 ─────────────────────────────────────────────────────────────────

/** 同一幂等键对应不同批次内容：必须由运营显式处置（--new-batch-key），绝不静默换键重提。 */
export class BatchKeyConflictError extends Error {
  constructor(
    readonly idempotencyKey: string,
    readonly expectedSha256: string,
    readonly actualSha256: string,
  ) {
    super(`批次幂等键 ${idempotencyKey} 对应内容变化（磁盘 ${actualSha256} ≠ 登记 ${expectedSha256}）；确认要以新内容开新批次时用 --new-batch-key 重新运行`);
  }
}

// ─── 依赖注入（生产装配见 incremental-run.ts；测试注入假 fetch/假提交） ───────────

export type RemoteSubmitResult = Readonly<{
  batchId: string;
  status: string | null;
  entries: readonly { entryKey: string; status: string }[];
}>;

export type IncrementalDeps = Readonly<{
  fetchImpl: typeof fetch;
  /** 判定远端错误是否为授权/许可类（401/403）：是则停止后续远端操作。 */
  isAuthError: (error: unknown) => boolean;
  /** MCP 提交（LCM-09 runner 语义：submit + inspect + 原子检查点；永不发布）。 */
  submitRemote: (input: { sourceKey: string; batch: IngestionBatch }) => Promise<RemoteSubmitResult>;
  now: () => Date;
  /** 快照/批次/报告根目录（许可范围：本地内部核验，不入仓库）。 */
  outDir: string;
  statePath: string;
  /** 有界重叠窗口大小：每 pass 复查最近 N 条已提交记录。 */
  overlapLimit: number;
  /** 单条失败自动重试上限；超过后保留待办但不再自动重试。 */
  maxAttempts: number;
  /** 每 pass 每来源抓取预算（礼貌采集；重叠复查与重试都消耗预算）。 */
  fetchBudgetPerSource: number;
}>;

export type IncrementalPassOptions = Readonly<{
  /** 本 pass 运营提供的候选详情页（按来源准入配置自动分组）。 */
  urls: readonly string[];
  /** 离线模式：只做证据与批次暂存，不发起 MCP 远端操作。 */
  offline?: boolean;
  /** 运营确认已重新完成 MCP 授权（清除 authBlocked）。 */
  reauthorized?: boolean;
  /** 运营确认已重新准入的来源（清除 disabled）。 */
  readmit?: readonly string[];
  /** 冲突后运营显式废弃当前待提交批次、开新批次键。 */
  newBatchKey?: boolean;
}>;

const EMPTY_COUNTS: SourceCounts = {
  candidates: 0,
  duplicates: 0,
  updated: 0,
  failed: 0,
  retried: 0,
  deferred: 0,
  pendingVerification: 0,
  staged: 0,
  failuresActive: 0,
  failuresExhausted: 0,
};

function initialState(sourceKey: string): SourceState {
  return {
    sourceKey,
    seen: {},
    failures: [],
    pending: [],
    lastSuccessfulCheckAt: null,
    lastPendingVerification: null,
    passSeq: 0,
    disabled: null,
    pendingBatch: null,
  };
}

/** 状态文件原子写入（tmp + rename），中断不会留下半份状态。 */
export async function saveStateAtomically(statePath: string, state: IncrementalState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, statePath);
}

function countFailures(failures: readonly FailedCandidate[], maxAttempts: number): { active: number; exhausted: number } {
  let active = 0;
  let exhausted = 0;
  for (const failure of failures) {
    if (failure.attempts >= maxAttempts) exhausted += 1;
    else active += 1;
  }
  return { active, exhausted };
}

function countsOf(source: SourceState, maxAttempts: number, extra: Partial<SourceCounts>): SourceCounts {
  const { active, exhausted } = countFailures(source.failures, maxAttempts);
  const staged = Object.values(source.seen).filter((record) => record.submittedSha256 === null).length;
  return {
    ...EMPTY_COUNTS,
    ...extra,
    pendingVerification: source.lastPendingVerification ?? 0,
    staged,
    failuresActive: active,
    failuresExhausted: exhausted,
  };
}

// ─── 抽取与批次构建 ───────────────────────────────────────────────────────────

async function extractEntry(input: {
  kind: "legislation" | "judicial_document";
  html: string;
  url: string;
  recordKey: string;
  entryKey: string;
  fetchedAt: string;
  sourceKey: string;
}): Promise<IngestionEntry> {
  if (input.kind === "legislation") {
    const extracted = extractLegislationPage({ html: input.html, url: input.url });
    const complete = extracted.articles.length > 0 && extracted.effectiveEvidence !== null;
    const built = await buildLegislationEntry({
      extracted,
      sourceKey: input.sourceKey,
      url: input.url,
      recordKey: input.recordKey,
      fetchedAt: input.fetchedAt,
      entryKey: input.entryKey,
    });
    if (!complete) {
      built.payload.document.sourceForm = "excerpt";
      built.payload.document.fieldIssues.push({
        path: "document.sourceForm",
        code: "unresolved",
        severity: "warning",
        message: "未同时取得条文全集与施行条款，按摘录（excerpt）提交，不冒充完整全文",
      });
    }
    return built;
  }
  const extracted = extractJudgmentPage({ html: input.html, url: input.url });
  return buildJudgmentEntry({
    extracted,
    sourceKey: input.sourceKey,
    url: input.url,
    recordKey: input.recordKey,
    fetchedAt: input.fetchedAt,
    entryKey: input.entryKey,
  });
}

/**
 * 从已持久化的 seen 记录（快照文件 + fetchedAt）确定性重建批次条目。
 * 恢复路径与首次构建产出逐字节一致（同一快照、同一 fetchedAt），保证同键同内容。
 */
async function rebuildEntryFromSeen(sourceKey: string, record: SeenRecord): Promise<IngestionEntry> {
  const html = await readFile(record.snapshotPath, "utf8");
  return extractEntry({
    kind: QUALIFIED_SOURCES[sourceKey]!.kind,
    html,
    url: record.url,
    recordKey: record.recordKey,
    entryKey: record.entryKey,
    fetchedAt: record.fetchedAt,
    sourceKey,
  });
}

function recordFail(source: SourceState, url: string, recordKey: string | null, kind: "request" | "parse", message: string, at: string): void {
  const existing = source.failures.find((failure) => failure.url === url);
  if (existing) {
    existing.attempts += 1;
    existing.lastFailedAt = at;
    existing.lastError = { kind, message };
    return;
  }
  source.failures.push({ url, recordKey, attempts: 1, firstFailedAt: at, lastFailedAt: at, lastError: { kind, message } });
}

function clearFail(source: SourceState, url: string): void {
  source.failures = source.failures.filter((failure) => failure.url !== url);
}

// ─── 提交边界 ─────────────────────────────────────────────────────────────────

type SubmissionOutcome = {
  record: { sourceKey: string; idempotencyKey: string; batchId: string | null; error: string | null };
  remoteBlockedReason: "auth" | "offline" | null;
};

/**
 * 待提交批次交给 LCM-09 runner 语义的提交通道（submit + inspect + 原子检查点，永不发布）。
 * 401/403 置来源级 authBlocked 并置全 pass 远端停止；其它失败保持待提交，下个 pass 原样重放。
 */
async function submitPendingBatch(input: {
  source: SourceState;
  state: IncrementalState;
  deps: IncrementalDeps;
  options: IncrementalPassOptions;
  remoteDisabledByAuth: { value: boolean };
}): Promise<SubmissionOutcome | null> {
  const { source, deps, options } = input;
  const pendingBatch = source.pendingBatch;
  if (!pendingBatch) return null;
  const recordBase = { sourceKey: source.sourceKey, idempotencyKey: pendingBatch.idempotencyKey };

  if (input.remoteDisabledByAuth.value) {
    return { record: { ...recordBase, batchId: null, error: null }, remoteBlockedReason: "auth" };
  }
  if (options.offline) {
    return { record: { ...recordBase, batchId: null, error: null }, remoteBlockedReason: "offline" };
  }
  if (input.state.authBlockedAt && !options.reauthorized) {
    return { record: { ...recordBase, batchId: null, error: null }, remoteBlockedReason: "auth" };
  }

  const raw = JSON.parse(await readFile(pendingBatch.path, "utf8")) as IngestionBatch;
  try {
    const result = await deps.submitRemote({ sourceKey: source.sourceKey, batch: raw });
    for (const recordKey of pendingBatch.recordKeys) {
      const seen = source.seen[recordKey];
      if (!seen || seen.submittedSha256 === seen.sha256) continue;
      source.seen[recordKey] = { ...seen, submittedSha256: seen.sha256, submittedBatchId: result.batchId };
    }
    source.lastPendingVerification = result.entries.filter((entry) => entry.status !== "ready").length;
    source.pendingBatch = null;
    input.state.authBlockedAt = null;
    await saveStateAtomically(deps.statePath, input.state);
    return { record: { ...recordBase, batchId: result.batchId, error: null }, remoteBlockedReason: null };
  } catch (error) {
    if (deps.isAuthError(error)) {
      input.state.authBlockedAt = deps.now().toISOString();
      input.remoteDisabledByAuth.value = true;
      await saveStateAtomically(deps.statePath, input.state);
      return { record: { ...recordBase, batchId: null, error: error instanceof Error ? error.message : "授权失败" }, remoteBlockedReason: "auth" };
    }
    await saveStateAtomically(deps.statePath, input.state);
    return { record: { ...recordBase, batchId: null, error: error instanceof Error ? error.message : "远端提交失败" }, remoteBlockedReason: null };
  }
}

// ─── 单来源处理 ───────────────────────────────────────────────────────────────

type WorkItem = Readonly<{ url: string; type: "pending" | "candidate" | "retry" | "overlap" }>;

type SourcePassResult = { report: SourceReport; submission: PassReport["submissions"][number] | null };

async function runSourcePass(input: {
  sourceKey: string;
  urls: readonly string[];
  state: IncrementalState;
  deps: IncrementalDeps;
  options: IncrementalPassOptions;
  remoteDisabledByAuth: { value: boolean };
}): Promise<SourcePassResult> {
  const { sourceKey, urls, state, deps, options } = input;
  const source = state.sources[sourceKey] ?? initialState(sourceKey);
  state.sources[sourceKey] = source;
  const kind = QUALIFIED_SOURCES[sourceKey]!.kind;
  const nowIso = deps.now().toISOString();

  const finish = (
    outcome: SourceOutcome,
    remoteBlockedReason: SourceReport["remoteBlockedReason"],
    scanRange: ScanRange,
    extra: Partial<SourceCounts>,
    submission: SourcePassResult["submission"] = null,
  ): SourcePassResult => ({
    report: {
      sourceKey,
      kind,
      outcome,
      disabledReason: source.disabled?.reason ?? null,
      remoteBlockedReason,
      lastSuccessfulCheckAt: source.lastSuccessfulCheckAt,
      scanRange,
      counts: countsOf(source, deps.maxAttempts, extra),
    },
    submission,
  });

  if (options.readmit?.includes(sourceKey)) source.disabled = null;
  if (source.disabled) {
    return finish("blocked", "disabled", { mode: "none", checkedUrls: 0, note: `来源已停用：${source.disabled.reason}` }, {});
  }

  // ── 中断恢复（提交边界后中断）：有待提交批次时直接重放提交，不做新一轮抓取 ──
  if (source.pendingBatch) {
    const batchFileSha = await sha256Hex(await readFile(source.pendingBatch.path, "utf8"));
    if (batchFileSha !== source.pendingBatch.sha256) {
      throw new BatchKeyConflictError(source.pendingBatch.idempotencyKey, source.pendingBatch.sha256, batchFileSha);
    }
    const submission = await submitPendingBatch({ source, state, deps, options, remoteDisabledByAuth: input.remoteDisabledByAuth });
    return finish(
      "ok",
      submission?.remoteBlockedReason ?? null,
      { mode: "none", checkedUrls: 0, note: `中断恢复：重放待提交批次 ${source.pendingBatch?.idempotencyKey ?? "（已提交）"}` },
      {},
      submission?.record ?? null,
    );
  }

  // ── 组装工作清单：遗留排队 → 本 pass 候选 → 失败重试 → 有界重叠复查（去重） ──
  const retryUrls = source.failures.filter((failure) => failure.attempts < deps.maxAttempts).map((failure) => failure.url);
  const submittableSeen = Object.values(source.seen).filter((record) => record.submittedSha256 !== null);
  const overlapUrls = [...submittableSeen]
    .sort((a, b) => (a.lastCheckedAt < b.lastCheckedAt ? 1 : -1))
    .slice(0, deps.overlapLimit)
    .map((record) => record.url);
  const work: WorkItem[] = [];
  const enqueued = new Set<string>();
  for (const [type, list] of [
    ["pending", source.pending] as const,
    ["candidate", urls as readonly string[]] as const,
    ["retry", retryUrls] as const,
    ["overlap", overlapUrls] as const,
  ]) {
    for (const url of list) {
      if (enqueued.has(url)) continue;
      enqueued.add(url);
      work.push({ url, type });
    }
  }

  if (work.length === 0 && Object.values(source.seen).every((record) => record.submittedSha256 !== null)) {
    return finish("empty", null, { mode: "none", checkedUrls: 0, note: "本 pass 无候选、无遗留排队、无重试、无重叠复查，也没有待恢复的暂存记录" }, {});
  }

  // ── 证据阶段：逐条抓取（礼貌通道 + 预算）；单条失败不阻塞其它候选 ──
  const noCursor = submittableSeen.length === 0;
  const scanMode: ScanRange["mode"] = noCursor ? "provided-candidates" : "overlap-rescan";
  let checkedUrls = 0;
  let fetchedOk = 0;
  let candidates = 0;
  let duplicates = 0;
  let updated = 0;
  let failed = 0;
  let retried = 0;
  let deferred = 0;
  let requestFailures = 0;
  let parseFailures = 0;
  const batchRecords: SeenRecord[] = [];

  for (let index = 0; index < work.length; index += 1) {
    const item = work[index]!;
    if (checkedUrls >= deps.fetchBudgetPerSource) {
      // 预算耗尽：候选/排队/重试保留待办（不从待办消失）；重叠复查顺延到下个 pass。
      deferred += 1;
      if (item.type !== "overlap" && !source.pending.includes(item.url)) source.pending.push(item.url);
      continue;
    }

    let recordKey: string | null = null;
    try {
      recordKey = recordKeyForUrl(item.url, kind);
    } catch {
      recordFail(source, item.url, null, "parse", "无法从 URL 确定稳定记录键", nowIso);
      failed += 1;
      parseFailures += 1;
      continue;
    }
    checkedUrls += 1;
    if (item.type === "retry") retried += 1;
    // 实际处理即从遗留排队移除（失败会进重试队列，不靠 pending 保留）。
    if (item.type === "pending") source.pending = source.pending.filter((url) => url !== item.url);

    let fetched: Awaited<ReturnType<typeof politeFetchHtml>>;
    try {
      fetched = await politeFetchHtml(item.url, { fetchImpl: deps.fetchImpl });
    } catch (error) {
      if (error instanceof AccessRestrictedError) {
        // 访问限制/许可边界变化：立即停用来源并停止后续远端操作；
        // 未处理候选保留排队，恢复需运营重新准入。
        source.disabled = { reason: error.message, at: nowIso };
        for (const remaining of work.slice(index)) {
          if (remaining.type !== "overlap" && !source.pending.includes(remaining.url)) source.pending.push(remaining.url);
        }
        await saveStateAtomically(deps.statePath, state);
        return finish(
          "blocked",
          "disabled",
          { mode: scanMode, checkedUrls, note: `有界扫描在第 ${checkedUrls} 条后因访问限制停止；范围不含全量` },
          { candidates, duplicates, updated, failed, retried, deferred },
        );
      }
      recordFail(source, item.url, recordKey, "request", error instanceof Error ? error.message : "抓取失败", nowIso);
      failed += 1;
      requestFailures += 1;
      continue;
    }

    // 成功取得响应：来源检查成功（无论后续分类如何）。
    fetchedOk += 1;

    // 证据边界：快照按内容寻址落盘（许可范围：本地内部核验，不入仓库）。
    const snapshotDir = join(deps.outDir, "snapshots");
    await mkdir(snapshotDir, { recursive: true });
    const snapshotPath = join(snapshotDir, `${sourceKey}--${recordKey}--${fetched.sha256.slice(0, 8)}.html`);
    await writeFile(snapshotPath, fetched.html, { mode: 0o600 });

    const seen = source.seen[recordKey];
    const entryKey = `${sourceKey}--${recordKey}`;
    const record: SeenRecord = {
      url: item.url,
      recordKey,
      entryKey,
      sha256: fetched.sha256,
      snapshotPath,
      fetchedAt: fetched.fetchedAt,
      lastCheckedAt: nowIso,
      submittedSha256: seen?.submittedSha256 === fetched.sha256 ? seen.submittedSha256 : null,
      submittedBatchId: seen?.submittedSha256 === fetched.sha256 ? seen.submittedBatchId : null,
    };

    if (seen && seen.submittedSha256 === fetched.sha256) {
      // 重复发现：同记录键同内容且已提交过，不重复出版本。
      source.seen[recordKey] = { ...record, submittedSha256: seen.submittedSha256, submittedBatchId: seen.submittedBatchId };
      duplicates += 1;
      clearFail(source, item.url);
      continue;
    }

    if (seen && seen.submittedSha256 !== null) updated += 1;
    else candidates += 1;

    let entry: IngestionEntry;
    try {
      entry = await extractEntry({
        kind,
        html: fetched.html,
        url: item.url,
        recordKey,
        entryKey,
        fetchedAt: fetched.fetchedAt,
        sourceKey,
      });
    } catch (error) {
      recordFail(source, item.url, recordKey, "parse", error instanceof Error ? error.message : "抽取失败", nowIso);
      failed += 1;
      parseFailures += 1;
      continue;
    }
    clearFail(source, item.url);
    source.seen[recordKey] = record;
    batchRecords.push(record);
  }

  // ── 中断恢复（证据边界后中断）：已见未提交记录直接从快照重建，不重抓 ──
  for (const record of Object.values(source.seen)) {
    if (record.submittedSha256 !== null || batchRecords.some((item) => item.recordKey === record.recordKey)) continue;
    try {
      await rebuildEntryFromSeen(sourceKey, record);
      batchRecords.push({ ...record, lastCheckedAt: nowIso });
      candidates += 1;
    } catch (error) {
      // 快照丢失等证据故障：按请求失败记入重试队列（下个 pass 重抓）。
      recordFail(source, record.url, record.recordKey, "request", error instanceof Error ? error.message : "快照证据丢失", nowIso);
      failed += 1;
      requestFailures += 1;
    }
  }

  // 证据阶段边界：先持久化，再进入成品构建。
  if (fetchedOk > 0) source.lastSuccessfulCheckAt = nowIso;
  await saveStateAtomically(deps.statePath, state);

  const scanRange: ScanRange = {
    mode: scanMode,
    checkedUrls,
    note: noCursor
      ? `无可靠游标：仅扫描提供的候选（本轮实际检查 ${checkedUrls} 个 URL），不宣称全量覆盖`
      : `有界扫描：候选/重试 + 最近 ${deps.overlapLimit} 条重叠复查（本轮实际检查 ${checkedUrls} 个 URL），不宣称全量覆盖`,
  };

  if (batchRecords.length === 0) {
    const produced = candidates + updated + duplicates;
    const outcome: SourceOutcome = produced > 0
      ? "ok"
      : parseFailures > requestFailures
        ? "parse_failure"
        : requestFailures > 0
          ? "request_failure"
          : "parse_failure";
    return finish(outcome, null, scanRange, { candidates, duplicates, updated, failed, retried, deferred });
  }

  // ── 成品落盘边界：确定性构建 → 本地（服务端同款）校验 → 原子持久化待提交批次 ──
  source.passSeq += 1;
  const idempotencyKey = `lcaq03-${sourceKey}-p${source.passSeq}`;
  const entries: IngestionEntry[] = [];
  for (const record of batchRecords) {
    entries.push(await rebuildEntryFromSeen(sourceKey, record));
  }
  const batch: IngestionBatch = { contractVersion: PLATFORM_CONTENT_CONTRACT_VERSION, idempotencyKey, items: entries };
  const validation = await validateBatch(batch);
  if (!validation.ok) {
    // 本地校验失败不提交：相关记录记为解析失败待办（不消失），批次不落盘。
    for (const record of batchRecords) {
      recordFail(source, record.url, record.recordKey, "parse", `本地批次校验未通过（${validation.issues.length} 条 issue）`, nowIso);
    }
    await saveStateAtomically(deps.statePath, state);
    return finish("parse_failure", null, scanRange, { candidates, duplicates, updated, failed: failed + batchRecords.length, retried, deferred });
  }

  const batchDir = join(deps.outDir, "batches");
  await mkdir(batchDir, { recursive: true });
  const batchPath = join(batchDir, `${idempotencyKey}.json`);
  const batchJson = `${JSON.stringify(batch, null, 2)}\n`;
  await writeFile(batchPath, batchJson, { mode: 0o600 });
  source.pendingBatch = {
    idempotencyKey,
    path: batchPath,
    sha256: await sha256Hex(batchJson),
    recordKeys: batchRecords.map((record) => record.recordKey),
    builtAt: nowIso,
  };
  await saveStateAtomically(deps.statePath, state);

  // ── MCP 提交边界（LCM-09 runner：submit + inspect + 原子检查点；永不发布） ──
  const submission = await submitPendingBatch({ source, state, deps, options, remoteDisabledByAuth: input.remoteDisabledByAuth });
  return finish("ok", submission?.remoteBlockedReason ?? null, scanRange, { candidates, duplicates, updated, failed, retried, deferred }, submission?.record ?? null);
}

// ─── Pass 入口 ───────────────────────────────────────────────────────────────

export async function loadIncrementalState(statePath: string): Promise<IncrementalState> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as IncrementalState;
    if (parsed && parsed.version === 1 && typeof parsed.sources === "object" && parsed.sources !== null) return parsed;
  } catch {
    // 首次运行或状态缺失：从空状态开始。
  }
  return { version: 1, updatedAt: new Date(0).toISOString(), sources: {}, authBlockedAt: null };
}

export async function runIncrementalPass(deps: IncrementalDeps, options: IncrementalPassOptions): Promise<PassReport> {
  const state = await loadIncrementalState(deps.statePath);

  // 候选按准入来源分组；未准入 URL 直接拒绝（requireQualifiedSource 抛 AccessRestrictedError）。
  const bySource = new Map<string, string[]>();
  for (const url of options.urls) {
    const config = requireQualifiedSource(url);
    const list = bySource.get(config.sourceKey) ?? [];
    list.push(url);
    bySource.set(config.sourceKey, list);
  }

  // 冲突预检：任一来源的待提交批次与磁盘内容不符时，整个 pass 停下等运营处置。
  for (const source of Object.values(state.sources)) {
    if (!source.pendingBatch) continue;
    const actual = await sha256Hex(await readFile(source.pendingBatch.path, "utf8"));
    if (actual !== source.pendingBatch.sha256) {
      throw new BatchKeyConflictError(source.pendingBatch.idempotencyKey, source.pendingBatch.sha256, actual);
    }
  }

  // 运营重新授权：清除全局授权停止标记。
  if (options.reauthorized) state.authBlockedAt = null;

  const remoteDisabledByAuth = { value: false };
  const reports: SourceReport[] = [];
  const submissions: { sourceKey: string; idempotencyKey: string; batchId: string | null; error: string | null }[] = [];

  for (const sourceKey of Object.keys(QUALIFIED_SOURCES)) {
    const result = await runSourcePass({
      sourceKey,
      urls: bySource.get(sourceKey) ?? [],
      state,
      deps,
      options,
      remoteDisabledByAuth,
    });
    reports.push(result.report);
    if (result.submission) submissions.push(result.submission);
  }

  state.updatedAt = deps.now().toISOString();
  await saveStateAtomically(deps.statePath, state);

  return { runAt: state.updatedAt, statePath: deps.statePath, sources: reports, submissions };
}
