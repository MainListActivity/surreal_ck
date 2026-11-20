import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Surreal } from "surrealdb";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { loadTemplatePackScripts } from "@surreal-ck/shared/template-packs";
import { loadPlatformContentScripts } from "@surreal-ck/shared/platform-content-schema";
import { ensureSystemSchema } from "./system-schema";
import { materializeWorkspaceMigrationSql } from "./workspace-migration-execution";
import { probeNativeQuotaHttp, verifyNativeQuotaRootHandshake } from "./native-quota/startup-gate";
import { SurrealNativeQuotaClient } from "./native-quota/client";

const binary = process.env.SURREAL_BINARY;
const previousBinary = process.env.SURREAL_PREVIOUS_BINARY;
const certifiedBinary = process.env.SURREAL_4_CERTIFIED_BINARY;
const certifiedEngine = process.env.SURREAL_4_CERTIFIED_ENGINE ?? "rocksdb";
const forwardMissing = [!previousBinary && "SURREAL_PREVIOUS_BINARY", !certifiedBinary && "SURREAL_4_CERTIFIED_BINARY"].filter(Boolean);

async function start(executable: string, path: string) {
  const port = 34000 + Math.floor(Math.random() * 10000);
  const url = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn([executable, "start", "--allow-all", "--bind", `127.0.0.1:${port}`,
    "--user", "root", "--pass", "test-upgrade", path], { stdout: "ignore", stderr: "ignore" });
  const db = new Surreal();
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(`${url}/health`)).ok; } catch { /* startup */ }
      if (ready) break;
      await Bun.sleep(100);
    }
    if (!ready) throw new Error("isolated upgrade database did not become ready");
    await db.connect(`${url}/rpc`, { reconnect: false });
    await db.signin({ username: "root", password: "test-upgrade" });
    return { db, url, async close() { await db.close(); proc.kill("SIGTERM"); await proc.exited; } };
  } catch (error) {
    await db.close(); proc.kill(); await proc.exited; throw error;
  }
}

async function schemas(db: Surreal) {
  await db.query("DEFINE NAMESPACE IF NOT EXISTS main; USE NS main; DEFINE DATABASE IF NOT EXISTS _system;");
  await db.use({ namespace: "main", database: "_system" });
  const client = {
    use: async (scope: { namespace: string; database: string }) => db.use(scope),
    query: async (sql: string, params?: Record<string, unknown>) => db.query(sql, params).collect(),
  };
  const system = await ensureSystemSchema(client, { namespace: "main" });
  expect(system.toVersion).toBe(49);
  for (const database of ["platform_content", "ws_upgrade"]) {
    await db.query(`DEFINE DATABASE IF NOT EXISTS ${database};`);
    await db.use({ namespace: "main", database });
    if (database === "platform_content") {
      for (const script of await loadPlatformContentScripts()) await db.query(script.sql).collect();
    } else {
      for (const script of await loadTemplateScripts({ oidcJwksUrl: "http://127.0.0.1:9/jwks" })) {
        await db.query(await materializeWorkspaceMigrationSql(client, script)).collect();
      }
      for (const pack of await loadTemplatePackScripts({ selectedPacks: ["legal-starter", "bankruptcy-claims"] })) {
        await db.query(pack.sql).collect();
      }
      await db.query("DEFINE TABLE IF NOT EXISTS upgrade_probe SCHEMALESS; UPSERT upgrade_probe:kept SET payload = 'preserved';");
    }
  }
}

async function verify(db: Surreal, url: string) {
  const capability = await probeNativeQuotaHttp({ surrealUrl: `${url}/rpc`, production: false });
  expect(capability.storage.storage_version).toBe(32772);
  expect(capability.fork.release).toBe("4.0.1-native-quota.1");
  await db.use({ namespace: "main", database: "_system" });
  await verifyNativeQuotaRootHandshake({ client: new SurrealNativeQuotaClient(db) });
  await db.use({ namespace: "main", database: "ws_upgrade" });
  const [rows] = await db.query<[Array<{ payload: string }>]>("SELECT payload FROM upgrade_probe:kept;");
  expect(rows?.[0]?.payload).toBe("preserved");
}

async function rowCounts(db: Surreal, database: string) {
  await db.use({ namespace: "main", database });
  const [info] = await db.query<[{ tables: Record<string, string> }]>("INFO FOR DB;");
  const counts: Record<string, number> = {};
  for (const [table, definition] of Object.entries(info.tables).sort(([a], [b]) => a.localeCompare(b))) {
    if (definition.toUpperCase().includes(" AS SELECT ")) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error("unsupported fixture table identifier");
    const [rows] = await db.query<[Array<{ count: number }>]>(`SELECT count() AS count FROM \`${table}\` GROUP ALL;`);
    counts[table] = rows[0]?.count ?? 0;
  }
  return counts;
}

test.skipIf(!binary)("4.0 全部 schema、可选模板包和启动门禁", async () => {
  const instance = await start(binary!, "memory");
  try {
    await schemas(instance.db);
    await verify(instance.db, instance.url);
    expect(await instance.db.query("RETURN 1;").collect()).toEqual([1]);
    expect(await instance.db.query("SELECT * FROM upgrade_probe WHERE false;").collect()).toEqual([[]]);
    await expect(instance.db.query("BEGIN TRANSACTION; THROW 'sdk-root-cause'; COMMIT TRANSACTION;").collect())
      .rejects.toThrow("sdk-root-cause");
  }
  finally { await instance.close(); }
}, 120_000);

test("SDK 2.2.2 禁用自动重连时 connect 拒绝不可达端点", async () => {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing test port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
  const db = new Surreal();
  try {
    await expect(db.connect(`ws://127.0.0.1:${port}/rpc`, { reconnect: false })).rejects.toBeInstanceOf(Error);
  } finally { await db.close(); }
}, 10_000);

test.skipIf(forwardMissing.length > 0)(`3.3 RocksDB → 认证 4.0 引擎新目录导入与旧目录恢复${forwardMissing.length ? `（跳过：需设置 ${forwardMissing.join("、")}；等待认证构建）` : ""}`, async () => {
  expect(certifiedEngine).toBe("rocksdb");
  const directory = await mkdtemp(join(tmpdir(), "sck-upgrade-"));
  const path = join(directory, "data");
  try {
    const old = await start(previousBinary!, `rocksdb://${path}`);
    const databases = ["_system", "platform_content", "ws_upgrade"];
    const counts: Record<string, Record<string, number>> = {};
    try {
      await schemas(old.db);
      for (const database of databases) {
        counts[database] = await rowCounts(old.db, database);
        const process = Bun.spawn([previousBinary!, "export", "--endpoint", old.url,
          "--user", "root", "--pass", "test-upgrade", "--namespace", "main", "--database", database,
          join(directory, database + ".surql")], { stdout: "pipe", stderr: "pipe" });
        const errors = await new Response(process.stderr).text();
        expect(await process.exited, errors).toBe(0);
      }
    }
    finally { await old.close(); }
    const snapshot = join(directory, "snapshot");
    await cp(path, snapshot, { recursive: true });
    const target = await start(certifiedBinary!, `${certifiedEngine}://${join(directory, "target")}`);
    try {
      const capability = await probeNativeQuotaHttp({ surrealUrl: `${target.url}/rpc`, production: true });
      expect(capability.backend.name).toBe(certifiedEngine);
      expect(capability.storage.storage_version).toBe(32772);
      await target.db.query("DEFINE NAMESPACE IF NOT EXISTS main;");
      await target.db.use({ namespace: "main" });
      for (const database of databases) {
        await target.db.query(`DEFINE DATABASE IF NOT EXISTS ${database};`);
        await target.db.use({ namespace: "main", database });
        await target.db.query("ALTER DATABASE COMPATIBILITY 3;");
        const process = Bun.spawn([certifiedBinary!, "import", "--endpoint", target.url,
          "--user", "root", "--pass", "test-upgrade", "--namespace", "main", "--database", database,
          join(directory, database + ".surql")], { stdout: "pipe", stderr: "pipe" });
        const errors = await new Response(process.stderr).text();
        expect(await process.exited, errors).toBe(0);
        expect(await rowCounts(target.db, database)).toEqual(counts[database]!);
      }
      await target.db.use({ namespace: "main", database: "ws_upgrade" });
      const [rows] = await target.db.query<[Array<{ payload: string }>]>("SELECT payload FROM upgrade_probe:kept;");
      expect(rows?.[0]?.payload).toBe("preserved");
      await verify(target.db, target.url);
    } finally { await target.close(); }
    const restored = await start(previousBinary!, `rocksdb://${path}`);
    try {
      for (const database of databases) expect(await rowCounts(restored.db, database)).toEqual(counts[database]!);
      await restored.db.use({ namespace: "main", database: "ws_upgrade" });
      const [rows] = await restored.db.query<[Array<{ payload: string }>]>("SELECT payload FROM upgrade_probe:kept;");
      expect(rows?.[0]?.payload).toBe("preserved");
    } finally { await restored.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 180_000);
