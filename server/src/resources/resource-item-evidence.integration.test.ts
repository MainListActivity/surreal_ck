import { describe, expect, test } from "bun:test";
import { Surreal } from "surrealdb";
import { homedir } from "node:os";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";

/**
 * LCA14 返工回归（真实 SurrealDB fork，memory 实例）：
 * `resource_item.evidence` 在 008 里只是裸 `TYPE array`，SCHEMAFULL 表上
 * 隐式生成的 `evidence.*` 子字段非 FLEXIBLE，对象元素写入被引擎拒绝，
 * POST /api/resources/research/save 在所有 workspace 的 persisting 阶段
 * 事务整体回滚。049 增量补显式 FLEXIBLE 子定义并修复既有 workspace。
 *
 * 验证矩阵：
 * - 缺陷复现：v≤48 模板链下对象数组写入被拒（字符串数组/空数组不受影响）；
 * - 修复：追加应用 049 后同一对象数组可写可读，INFO 断言 FLEXIBLE；
 * - 幂等：047 重复应用无错误，既有数据行原样保留；
 * - 全新 workspace：全链（含 049）开箱即可写对象证据。
 */

const FIX_MIGRATION = "049-resource-item-evidence-flexible.surql";
const LEGACY_LAST_VERSION = 48;

async function spawnSurreal() {
  const port = 19000 + Math.floor(Math.random() * 10000);
  const password = crypto.randomUUID();
  const binary = process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`;
  const proc = Bun.spawn(
    [binary, "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "t", "--pass", password, "memory"],
    { stdout: "ignore", stderr: "ignore" },
  );
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) {
        return { url: `ws://127.0.0.1:${port}/rpc`, password, proc };
      }
    } catch { /* 等待启动 */ }
    await Bun.sleep(50);
  }
  proc.kill();
  throw new Error("local surrealdb failed to start");
}

const opened: Surreal[] = [];
function track<T extends Surreal>(db: T): T {
  opened.push(db);
  return db;
}
async function closeAll() {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
}

async function openDatabase(url: string, password: string, database: string) {
  const db = track(new Surreal());
  await db.connect(url);
  await db.signin({ username: "t", password });
  await db.query(`DEFINE NAMESPACE IF NOT EXISTS test; USE NS test; DEFINE DATABASE IF NOT EXISTS ${database};`);
  await db.use({ namespace: "test", database });
  return db;
}

async function applyVersions(db: Surreal, predicate: (version: number) => boolean) {
  const scripts = await loadTemplateScripts({ oidcJwksUrl: "http://127.0.0.1:65535/jwks" });
  for (const script of scripts.filter((script) => predicate(script.version))) {
    await db.query(script.sql).collect();
  }
}

const OBJECT_EVIDENCE = [
  {
    text: "保证期间为主债务履行期届满之日起六个月",
    sourceUrl: "https://example.test/civil-code-692",
    sourceTitle: "民法典第692条",
    capturedAt: "2026-10-02T08:00:00.000Z",
    order: 0,
  },
  { text: "补充笔记", capturedAt: "2026-10-02T08:01:00.000Z", order: 1 },
];

async function createResourceItem(db: Surreal, id: string, evidence: unknown) {
  return db.query(
    `CREATE resource_item:${id} CONTENT {
      resource_type: "generic_note",
      title: "研究摘要",
      summary: "整理要点",
      evidence: $evidence,
      tags: [],
      structured_payload: {},
      quality: "user-confirmed",
      content_hash: "c-${id}",
      evidence_hash: "e-${id}",
      source_hash: "s-${id}",
      created_by: user:tester
    };`,
    { evidence },
  ).collect();
}

describe("LCA14 返工：resource_item.evidence 对象数组落库（真实 fork）", () => {
  test("v≤48 缺陷复现 → 049 修复对象数组写读 → 幂等且不改写既有行", async () => {
    const { url, password, proc } = await spawnSurreal();
    try {
      const db = await openDatabase(url, password, "ws_legacy");

      // 既有 workspace 缺陷态：模板链止于 48。
      await applyVersions(db, (version) => version <= LEGACY_LAST_VERSION);

      // 缺陷复现：对象证据被拒；字符串数组（现状兼容形态）可写。
      let rejected: unknown = null;
      try {
        await createResourceItem(db, "broken", OBJECT_EVIDENCE);
      } catch (error) {
        rejected = error;
      }
      expect(String(rejected)).toMatch(/evidence/);
      await createResourceItem(db, "legacy_strings", ["旧字符串证据"]);

      // 应用 049 增量：同一对象数组写入恢复。
      const fix = (await loadTemplateScripts()).find((script) => script.name === FIX_MIGRATION);
      if (!fix) throw new Error(`${FIX_MIGRATION} missing`);
      await db.query(fix.sql).collect();

      await createResourceItem(db, "repaired", OBJECT_EVIDENCE);
      const [rows] = await db.query<[Array<{ evidence: unknown[] }>]>(
        "SELECT evidence FROM resource_item:repaired;",
      );
      expect(rows?.[0]?.evidence).toEqual(OBJECT_EVIDENCE);

      // schema 断言：evidence.* 已是 FLEXIBLE object。
      const [info] = await db.query<[{ fields: Record<string, string> }]>(
        "INFO FOR TABLE resource_item;",
      );
      expect(info?.fields["evidence.*"]).toMatch(/FLEXIBLE/);

      // 幂等：049 重放无错误；既有字符串行原样保留（不改写数据）。
      await db.query(fix.sql).collect();
      const [legacy] = await db.query<[Array<{ evidence: unknown }>]>(
        "SELECT evidence FROM resource_item:legacy_strings;",
      );
      expect(legacy?.[0]?.evidence).toEqual(["旧字符串证据"]);
    } finally {
      await closeAll();
      proc.kill();
    }
  }, 60_000);

  test("全新 workspace 全链（含 049）开箱可写对象证据", async () => {
    const { url, password, proc } = await spawnSurreal();
    try {
      const db = await openDatabase(url, password, "ws_fresh");
      await applyVersions(db, () => true);
      await createResourceItem(db, "fresh", OBJECT_EVIDENCE);
      const [rows] = await db.query<[Array<{ evidence: unknown[] }>]>(
        "SELECT evidence FROM resource_item:fresh;",
      );
      expect(rows?.[0]?.evidence).toEqual(OBJECT_EVIDENCE);
    } finally {
      await closeAll();
      proc.kill();
    }
  }, 60_000);
});
