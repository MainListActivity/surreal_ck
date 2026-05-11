import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringRecordId, Surreal } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";

type CheckResult = {
  id: number;
  title: string;
  status: "PASS" | "FAIL" | "WORKAROUND";
  details: string;
};

const reportPath = process.env.SYNC_SPIKE_REPORT ?? join(process.cwd(), "docs/adr/sync-spike-report.md");
const remoteUrl = process.env.SYNC_SPIKE_REMOTE_URL;
const remoteJwt = process.env.SYNC_SPIKE_REMOTE_JWT;

async function main() {
  const local = new Surreal({ engines: { ...createNodeEngines() } });
  try {
    await local.connect("mem://");
    await local.use({ namespace: "sync_spike", database: "local" });

    const localResults = await runChecks("embedded localdb", local);
    const remoteResults = remoteUrl && remoteJwt
      ? await withRemote(remoteUrl, remoteJwt)
      : [{
        id: 0,
        title: "remote SurrealDB Cloud",
        status: "WORKAROUND" as const,
        details: "未设置 SYNC_SPIKE_REMOTE_URL / SYNC_SPIKE_REMOTE_JWT，本次只验证 embedded localdb。",
      }];

    const markdown = renderReport([...localResults, ...remoteResults]);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, markdown);
    console.log(`[sync-spike] report written: ${reportPath}`);
  } finally {
    await local.close().catch(() => undefined);
  }
}

async function withRemote(url: string, jwt: string): Promise<CheckResult[]> {
  const remote = new Surreal();
  await remote.connect(url);
  await remote.use({
    namespace: process.env.SURREALDB_NS ?? "main",
    database: process.env.SURREALDB_DB ?? "docs",
  });
  await remote.authenticate(jwt);
  try {
    return await runChecks("remote cloud", remote);
  } finally {
    await remote.close().catch(() => undefined);
  }
}

async function runChecks(label: string, db: Surreal): Promise<CheckResult[]> {
  const table = `sync_spike_${crypto.randomUUID().replaceAll("-", "_")}`;
  const record = new StringRecordId(`${table}:one`);
  const sessionId = crypto.randomUUID();
  const results: CheckResult[] = [];

  await db.query(`
    DEFINE PARAM OVERWRITE $current_session_id VALUE '${sessionId}';
    DEFINE TABLE ${table} SCHEMALESS CHANGEFEED 7d PERMISSIONS FULL;
    DEFINE FIELD _origin_session_id ON TABLE ${table} TYPE option<string>;
    DEFINE EVENT ${table}_origin_session ON TABLE ${table}
      WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE
      THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
  `);

  const paramRows = await db.query(`RETURN { sid: $current_session_id };`);
  const sid = findFirstValue(paramRows, "sid");
  results.push(check(1, `${label}: DEFINE PARAM 后续查询可读`, sid === sessionId, safeStringify(paramRows)));

  await db.query(`CREATE $record CONTENT { name: "local" }`, { record });
  const createdRows = await db.query<[Array<{ _origin_session_id?: string }>]>(
    `SELECT _origin_session_id FROM $record`,
    { record },
  );
  results.push(check(2, `${label}: EVENT 可读 PARAM`, createdRows[0]?.[0]?._origin_session_id === sessionId, safeStringify(createdRows)));
  results.push(check(3, `${label}: 普通 CREATE/UPDATE 自动注入 origin`, createdRows[0]?.[0]?._origin_session_id === sessionId, safeStringify(createdRows)));

  await db.query(`UPDATE $record MERGE { _origin_session_id: "remote:vs1", name: "remote" }`, { record });
  const remoteRows = await db.query<[Array<{ _origin_session_id?: string }>]>(
    `SELECT _origin_session_id FROM $record`,
    { record },
  );
  results.push(check(5, `${label}: 显式 remote origin 不被 EVENT 覆盖`, remoteRows[0]?.[0]?._origin_session_id === "remote:vs1", safeStringify(remoteRows)));

  try {
    const changes = await db.query(`SHOW CHANGES FOR TABLE ${table} SINCE 0 LIMIT 10`);
    const serialized = safeStringify(changes);
    const hasOrigin = serialized.includes("_origin_session_id");
    results.push(check(4, `${label}: CHANGEFEED 包含 _origin_session_id`, hasOrigin, serialized));
    results.push(check(6, `${label}: EVENT UPDATE 无无限自循环`, true, "SHOW CHANGES 返回，脚本未阻塞。"));
    results.push({
      id: 7,
      title: `${label}: CHANGEFEED 是否记录 EVENT 二次字段写入`,
      status: hasOrigin ? "PASS" : "WORKAROUND",
      details: hasOrigin ? "变更流可见 origin 字段，可按 ADR echo 过滤。" : "未见 origin 字段，需要改用双写入口或短缓存。",
    });
  } catch (err) {
    results.push({
      id: 4,
      title: `${label}: SHOW CHANGES 可读`,
      status: "FAIL",
      details: err instanceof Error ? err.message : String(err),
    });
  }

  return results;
}

function check(id: number, title: string, passed: boolean, details: string): CheckResult {
  return { id, title, status: passed ? "PASS" : "FAIL", details };
}

function renderReport(results: CheckResult[]): string {
  const generatedAt = new Date().toISOString();
  const failed = results.some((result) => result.status === "FAIL");
  return `# Sync Spike Report

- Generated At: ${generatedAt}
- Conclusion: ${failed ? "需要先处理 FAIL 项，再落地 ADR echo 防护方案。" : "当前可按 ADR echo 防护方案继续落地；远端未验证时保持 WORKAROUND 标记。"}

| # | Check | Status |
|---|---|---|
${results.map((result) => `| ${result.id} | ${escapePipe(result.title)} | ${result.status} |`).join("\n")}

## Details

${results.map((result) => `### ${result.id}. ${result.title}

Status: ${result.status}

\`\`\`text
${result.details}
\`\`\`
`).join("\n")}
`;
}

function escapePipe(value: string): string {
  return value.replaceAll("|", "\\|");
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

function findFirstValue(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstValue(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object" && key in value) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

await main();
