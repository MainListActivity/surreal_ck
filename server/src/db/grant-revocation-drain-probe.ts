import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { Surreal } from "surrealdb";

/**
 * LCA13 发布门禁排空探针：为 origin-release.sh 的 REVOCATION_GATE_DRAIN_SEC
 * 提供可独立重跑的真实引擎证据。
 *
 * 门禁在激活「不含撤销过滤」的目标前停掉 origin 服务（冻结唯一撤销写入
 * 路径）并静置 DRAIN_SEC，再读取 _system 撤销计数。其安全性依赖两个事实：
 *   A) 停服瞬间已送达引擎但尚未提交的 in-flight 写入，在写进程死亡后是否
 *      仍落库、以多大延迟落库——本探针用独立写进程在派发后 process.exit
 *      硬退出（与 systemctl stop 的 TCP 拆除一致，不发 WS close 帧）建模，
 *      由只读连接逐条测「断连后落库」延迟，验证静置窗口覆盖它；
 *   B) 停服后才产生的写入没有发送通道——进程已死，行不会出现。
 * 若 (A) 的观测上界逼近或超过 DRAIN_SEC，门禁排空假设不成立。
 *
 * 用法（本机公司 fork，禁止上游 surrealdb）：
 *   SURREAL_BINARY=~/.surrealdb/surreal bun run src/db/grant-revocation-drain-probe.ts
 * 可调：DRAIN_SEC（默认 3）、DRAIN_INFLIGHT_WRITES（默认 15）、
 *       DRAIN_DELIVERY_SETTLE_MS（写进程派发后到自杀的送达窗口，默认 10）。
 * 输出：逐阶段计数与延迟分布（ms）；任何断言失败退出码 1。
 * 副作用仅限临时目录下的本地引擎实例与短期写进程，结束时清理。
 */

const DRAIN_SEC = Number(process.env.DRAIN_SEC ?? "3");
const INFLIGHT_WRITES = Number(process.env.DRAIN_INFLIGHT_WRITES ?? "15");
// 写进程派发后、自杀前的送达窗口：让消息到引擎但不等响应（停服瞬间
// in-flight 请求的真实形态）。0 = 立即死亡，多数写不会送达。
const DELIVERY_SETTLE_MS = Number(process.env.DRAIN_DELIVERY_SETTLE_MS ?? "250");
// 写混合两类引擎内工作时长：FAST 档须 < settle（死亡前提交，证明消息
// 确实送达引擎），SLOW 档 > settle（死亡瞬间仍在执行中——排空要测的
// 正是这一类在断连后是否落库、以多大延迟落库）。
const ENGINE_WORK_FAST_MS = Number(process.env.DRAIN_ENGINE_WORK_FAST_MS ?? "30");
const ENGINE_WORK_BASE_MS = Number(process.env.DRAIN_ENGINE_WORK_BASE_MS ?? "400");
const ENGINE_WORK_SPAN_MS = Number(process.env.DRAIN_ENGINE_WORK_SPAN_MS ?? "500");
const surrealBinary =
  process.env.SURREAL_BINARY ?? `${process.env.HOME}/.surrealdb/surreal`;
const POLL_MS = 2;

function fail(message: string): never {
  console.error(`drain-probe: ${message}`);
  process.exit(1);
}

async function signin(endpoint: string): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(`${endpoint}/rpc`, {
    namespace: "main",
    authentication: { username: "root", password: "root" },
  });
  await db.use({ database: "_system" });
  return db;
}

// ── 写进程模式：被拉起的短生命周期 origin 写者替身 ─────────────────────
// 连接→派发 N 条 sleep+CREATE（引擎持有未提交事务）→静置送达窗口→
// process.exit 硬退出：socket 直接 FIN，没有 WS close 帧，与 systemctl
// stop 的进程死亡等价。每条语句打印 dispatched=<seq> 供 orchestrator 对账。
if (process.argv[2] === "writer") {
  const endpoint = process.argv[3];
  if (!endpoint) fail("writer mode requires endpoint arg");
  const db = await signin(endpoint);
  for (let i = 0; i < INFLIGHT_WRITES; i += 1) {
    const engineWorkMs = i % 2 === 0
      ? ENGINE_WORK_FAST_MS
      : ENGINE_WORK_BASE_MS + ((i * 13) % ENGINE_WORK_SPAN_MS);
    void db
      .query(
        `RETURN sleep(${engineWorkMs}ms);` +
          " CREATE drain_probe SET seq=$s, phase='inflight';",
        { s: 100 + i },
      )
      .catch(() => undefined);
    console.log(`writer: dispatched seq=${100 + i} engineWorkMs=${engineWorkMs}`);
  }
  if (DELIVERY_SETTLE_MS > 0) await Bun.sleep(DELIVERY_SETTLE_MS);
  process.exit(0);
}

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      listener.close(() => resolve(address.port));
    });
  });
}

async function waitUntilReady(endpoint: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const probe = Bun.spawn(
      [surrealBinary, "is-ready", "--endpoint", endpoint],
      { stdout: "ignore", stderr: "ignore" },
    );
    if ((await probe.exited) === 0) return;
    await Bun.sleep(100);
  }
  fail("local SurrealDB did not become ready");
}

async function countRows(reader: Surreal): Promise<number> {
  const result = await reader.query<{ count: number }[][]>(
    "SELECT count() AS count FROM drain_probe GROUP ALL;",
  );
  return result[0]?.[0]?.count ?? 0;
}

const port = await allocatePort();
const endpoint = `ws://127.0.0.1:${port}`;
const workingDirectory = await mkdtemp(join(tmpdir(), "drain-probe-"));
const engine = Bun.spawn(
  [
    surrealBinary, "start", "--no-banner", "--log", "warn",
    "--bind", `127.0.0.1:${port}`,
    "--user", "root", "--pass", "root",
    `rocksdb:${join(workingDirectory, "data")}`,
  ],
  { stdout: "ignore", stderr: "pipe" },
);
void engine.stderr.text().then((text) => {
  if (text.trim()) console.error("[engine]", text.trim());
});

try {
  await waitUntilReady(endpoint);
  const reader = await signin(endpoint);
  await reader.query("DEFINE DATABASE IF NOT EXISTS _system;");
  await reader.query("DEFINE TABLE drain_probe SCHEMAFULL;");
  await reader.query(
    "DEFINE FIELD seq ON TABLE drain_probe TYPE int;" +
      " DEFINE FIELD phase ON TABLE drain_probe TYPE string;",
  );

  // A) 断连前已被确认的写：全部已落库（基线，trivially true 但须实测）。
  const baseline = await signin(endpoint);
  for (let i = 0; i < 5; i += 1) {
    await baseline.query(
      "CREATE drain_probe SET seq=$s, phase='acked';",
      { s: i },
    );
  }
  const acked = await countRows(reader);
  if (acked !== 5) fail(`acked baseline: expected 5 rows, got ${acked}`);
  await baseline.close().catch(() => undefined);

  // B) in-flight 写：拉起写进程，它把 sleep+CREATE 送达引擎后硬退出
  //    （不响应、不 close 帧）。写进程退出时刻即 systemctl stop 完成时刻；
  //    之后只读连接按 POLL_MS 轮询，记录每行首次可见相对死亡时刻的延迟。
  const writerProcess = Bun.spawn(
    [
      process.execPath, new URL(import.meta.url).pathname,
      "writer", endpoint,
    ],
    {
      stdout: "pipe",
      stderr: "inherit",
      env: {
        ...process.env,
        DRAIN_INFLIGHT_WRITES: String(INFLIGHT_WRITES),
        DRAIN_DELIVERY_SETTLE_MS: String(DELIVERY_SETTLE_MS),
      },
      cwd: join(import.meta.dir, "..", ".."),
    },
  );
  const writerStdout = await new Response(writerProcess.stdout).text();
  const dispatchedSeqs = [...writerStdout.matchAll(/dispatched seq=(\d+)/g)]
    .map((m) => Number(m[1]));
  await writerProcess.exited;
  const closedAt = Date.now(); // 写进程死亡 = 冻结生效时刻

  const atClose = await reader.query<{ seq: number }[][]>(
    "SELECT seq FROM drain_probe WHERE phase='inflight';",
  );
  const seen = new Map<number, number>();
  for (const row of atClose[0] ?? []) seen.set(row.seq, 0);
  const landedBeforeClose = seen.size;

  const deadline = closedAt + DRAIN_SEC * 1000;
  while (Date.now() < deadline) {
    const rows = await reader.query<{ seq: number }[][]>(
      "SELECT seq FROM drain_probe WHERE phase='inflight';",
    );
    for (const row of rows[0] ?? []) {
      if (!seen.has(row.seq)) seen.set(row.seq, Date.now() - closedAt);
    }
    if (seen.size >= dispatchedSeqs.length) break;
    await Bun.sleep(POLL_MS);
  }
  const landed = seen.size;
  const postClose = [...seen.entries()]
    .filter(([, latency]) => latency > 0)
    .map(([, latency]) => latency)
    .sort((a, b) => a - b);
  const maxLatency = postClose.at(-1) ?? 0;
  // seq 奇偶区分快慢档：偶=FAST（死亡前应提交）奇=SLOW（死亡时在途）。
  const fastSeqs = dispatchedSeqs.filter((s) => s % 2 === 0);
  const slowSeqs = dispatchedSeqs.filter((s) => s % 2 === 1);
  const fastLanded = fastSeqs.filter((s) => seen.has(s)).length;
  const slowLanded = slowSeqs.filter((s) => seen.has(s)).length;
  console.log(
    `drain-probe: inflight dispatched=${dispatchedSeqs.length} ` +
      `fast_landed=${fastLanded}/${fastSeqs.length} ` +
      `slow_landed=${slowLanded}/${slowSeqs.length} ` +
      `landed_before_close=${landedBeforeClose} ` +
      `landed_after_disconnect=${postClose.length} ` +
      `postclose_latencies_ms=${JSON.stringify(postClose)} max=${maxLatency} ` +
      `settle_ms=${DELIVERY_SETTLE_MS} ` +
      `never_landed=${dispatchedSeqs.length - landed}`,
  );
  // FAST 档必须全部落库，否则说明消息未送达、慢档结论不可信。
  if (fastLanded !== fastSeqs.length) {
    fail(
      `delivery unproven: ${fastLanded}/${fastSeqs.length} fast writes ` +
        "landed before death",
    );
  }
  if (postClose.length > 0 && maxLatency >= DRAIN_SEC * 1000) {
    fail(
      `in-flight write landed ${maxLatency}ms after disconnect, beyond ` +
        `DRAIN_SEC=${DRAIN_SEC}s window`,
    );
  }

  // C) 冻结后的写：死亡进程不再有写入通道——用一条已关闭连接模拟，SDK
  //    直接报错，行数不得增长。
  const frozen = await signin(endpoint);
  await frozen.close();
  const beforePostClose = await countRows(reader);
  const postCloseError = await frozen
    .query("CREATE drain_probe SET seq=999, phase='postclose';")
    .then(() => null)
    .catch((error: unknown) => error);
  if (postCloseError === null) {
    fail("write on closed connection unexpectedly succeeded");
  }
  await Bun.sleep(200);
  const afterPostClose = await countRows(reader);
  if (afterPostClose !== beforePostClose) {
    fail(
      `row count grew after writer death: ${beforePostClose} -> ${afterPostClose}`,
    );
  }
  console.log(
    `drain-probe: postclose write rejected=${postCloseError instanceof Error ? postCloseError.message : String(postCloseError)} ` +
      `rows_stable=${afterPostClose}`,
  );

  await reader.close();
  console.log(
    `drain-probe: PASS (binary=${surrealBinary}, drain=${DRAIN_SEC}s, ` +
      `inflight_landed=${landed}/${dispatchedSeqs.length}, ` +
      `max_postclose_landing=${maxLatency}ms)`,
  );
} finally {
  engine.kill();
  await engine.exited;
  await rm(workingDirectory, { force: true, recursive: true });
}
