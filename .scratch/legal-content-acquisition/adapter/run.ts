/**
 * 本地采集 CLI：抓取准入来源详情页 → 确定性抽取 → 生成 IngestionBatch 成品文件 →
 * 本地（服务端同款校验器）复核 → 落盘快照与运行清单。
 *
 * 提交复用现有 scripts/platform-content-runner.ts（CONTENT_BATCH_FILE=本命令输出的批次文件），
 * 默认停在人工审阅（不发布）；本工具不持有任何凭证。
 *
 * 用法：bun run.ts --url https://... [--out runs/20260930-xxxx] [--label real-run]
 * 真实来源只允许 LCAQ-01 准入清单内的详情页；列表页/摘要页会直接拒绝。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { politeFetchHtml, sha256Hex } from "./http";
import { CLEANING_NOTES } from "./extract";
import { extractLegislationPage, type LegislationExtraction } from "./legislation";
import { extractJudgmentPage, type JudgmentExtraction } from "./judgment";
import { buildJudgmentEntry, buildLegislationEntry, validateBatch } from "./emit";
import { PLATFORM_CONTENT_CONTRACT_VERSION, type IngestionBatch, type IngestionEntry } from "./deps";
import { QUALIFIED_SOURCES, requireQualifiedSource, AccessRestrictedError } from "./sources";

function flagValue(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function flag(name: string): boolean {
  return Bun.argv.includes(name);
}

function recordKeyForUrl(url: string, kind: string): string {
  const path = new URL(url).pathname;
  const segments = path.split("/").filter(Boolean);
  if (kind === "legislation") {
    // /zcfgk/c100009/c5233383/content.html → c5233383
    const contentId = segments.filter((segment) => /^c\d+$/u.test(segment)).at(-1);
    if (contentId) return contentId;
  }
  const last = segments.at(-1)?.replace(/\.html?$/u, "");
  if (last && /^\d+$/u.test(last)) return last;
  throw new Error(`无法从 URL 确定稳定记录键：${url}`);
}

async function main(): Promise<void> {
  const urls = Bun.argv.filter((arg, index) => Bun.argv[index - 1] === "--url");
  if (urls.length === 0) throw new Error("请提供 --url <详情页 URL>（可多次）");
  const outDir = flagValue("--out") ?? `runs/${new Date().toISOString().replace(/[-:TZ.]/gu, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
  await mkdir(outDir, { recursive: true });

  const items: IngestionBatch["items"] = [];
  const sourceSummaries: unknown[] = [];
  for (const url of urls) {
    const config = requireQualifiedSource(url);
    const fetched = await politeFetchHtml(url);
    const snapshotPath = join(outDir, `${config.sourceKey}-${basename(new URL(url).pathname).replace(/[^\w.-]/gu, "_")}.snapshot.html`);
    await writeFile(snapshotPath, fetched.html, { mode: 0o600 });
    const recordKey = recordKeyForUrl(url, config.kind);
    const entryKey = `${config.sourceKey}--${recordKey}`;
    let entry: IngestionEntry;
    if (config.kind === "legislation") {
      const extracted = extractLegislationPage({ html: fetched.html, url });
      const complete = extracted.articles.length > 0 && extracted.effectiveEvidence !== null;
      const built = await buildLegislationEntry({
        extracted,
        sourceKey: config.sourceKey,
        url,
        recordKey,
        fetchedAt: fetched.fetchedAt,
        entryKey,
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
      entry = built;
    } else {
      const extracted = extractJudgmentPage({ html: fetched.html, url });
      entry = await buildJudgmentEntry({ extracted, sourceKey: config.sourceKey, url, recordKey, fetchedAt: fetched.fetchedAt, entryKey });
    }
    items.push(entry);
    sourceSummaries.push({
      sourceKey: config.sourceKey,
      kind: config.kind,
      url,
      recordKey,
      entryKey,
      httpStatus: fetched.status,
      snapshotPath,
      snapshotSha256: fetched.sha256,
      fetchedAt: fetched.fetchedAt,
      trail: fetched.trail,
    });
  }

  const batch: IngestionBatch = {
    contractVersion: PLATFORM_CONTENT_CONTRACT_VERSION,
    idempotencyKey: flagValue("--idempotency-key") ?? `lcaq02-${new Date().toISOString().slice(0, 10)}-real-sources`,
    items,
  };
  const validation = await validateBatch(batch);
  const batchPath = join(outDir, "batch.json");
  await writeFile(batchPath, `${JSON.stringify(batch, null, 2)}\n`, { mode: 0o600 });
  const manifest = {
    pipelineVersion: "lcaq02-adapter-v1",
    runAt: new Date().toISOString(),
    cleaningNotes: CLEANING_NOTES,
    deterministicOnly: true,
    sources: sourceSummaries,
    batchPath,
    batchSha256: await sha256Hex(JSON.stringify(batch)),
    validationOk: validation.ok,
    validationIssues: validation.ok ? [] : validation.issues,
  };
  const manifestPath = join(outDir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ batchPath, manifestPath, validationOk: validation.ok, issues: validation.ok ? 0 : validation.issues.length }, null, 2));
  if (!validation.ok) {
    console.error(JSON.stringify(validation.issues, null, 2));
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  if (error instanceof AccessRestrictedError) {
    console.error(`[access-restricted] ${error.message}`);
  } else {
    console.error(error instanceof Error ? error.message : "采集失败");
  }
  process.exitCode = 1;
});
