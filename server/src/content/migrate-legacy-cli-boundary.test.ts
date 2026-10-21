import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Surreal } from "surrealdb";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONTENT_MIGRATION_TABLES, migrateLegacyPlatformContent, migrateLegacyPlatformContentIfNeeded } from "./migrate-legacy";

/**
 * CL02：pre-start 钩子的迁移调用链边界回归（隔离、无真实 DB、无网络）。
 *
 * 1) 真实入口 `server/src/content/migrate-legacy-cli.ts`：`surrealdb` 用真实模块，
 *    只在 `Surreal` 原型方法上装本文件作用域的 spy；`./migrate-legacy` 用真实实现。
 *    --writes-frozen 守卫、IfNeeded 选择、marker 幂等短路、_system 只读来源与 CONTENT_DATABASE 只写目标，
 *    全部由被测代码决定。`../env` 与 `./schema` 用 mock.module，结束时显式 mock.restore() 复原。
 * 2) 不变量与变异检测：同一替身下直接调用真实的 IfNeeded 与无守卫的 migrateLegacyPlatformContent，
 *    验证“已迁移却继续读来源/重写 marker”和“越界写入”会被边界检查器判红。
 * 3) 黑盒执行真实 `scripts/deploy/origin-pre-start.sh`：PATH 上的 bun 为只记录 argv 的替身，
 *    校验 cwd、bun run 参数与 --writes-frozen；钩子变异（丢掉 flag）必须被同一断言检出。
 */

type Call = {
  role: "content" | "_system" | "other";
  database: string;
  kind: "connect" | "query" | "select" | "create" | "upsert" | "relate" | "close";
  table?: string;
  sql?: string;
  content?: Record<string, unknown>;
};

const SENTINEL_PASSWORD = "boundary-fixture-not-a-real-password";

const env: Record<string, string> = {
  SURREAL_URL: "ws://127.0.0.1:65535/rpc",
  SURREAL_NS: "boundary_ns",
  SURREAL_ROOT_USER: "boundary-root",
  SURREAL_ROOT_PASS: SENTINEL_PASSWORD,
  CONTENT_DATABASE: "platform_content",
};

const schemaCalls: string[] = [];
const calls: Call[] = [];
let markerRows: Array<Record<string, unknown>> = [];

function resetFixture(): void {
  calls.length = 0;
  schemaCalls.length = 0;
  markerRows = [];
}

// 只 mock 两个无副作用的模块；surrealdb 保持真实，避免进程级 mock 泄漏到其它测试文件。
mock.module("../env", () => ({ env }));
mock.module("./schema", () => ({
  ensurePlatformContentSchema: async (db: unknown) => {
    schemaCalls.push("ensurePlatformContentSchema");
    return { db, fromVersion: 0, toVersion: 0, appliedVersions: [] };
  },
}));

type Scope = { role: Call["role"]; database: string };
const scopes = new WeakMap<object, Scope>();

function scopeFor(database: string): Scope {
  const role: Call["role"] = database === "_system" ? "_system" : database === env.CONTENT_DATABASE ? "content" : "other";
  return { role, database };
}

function record(instance: object, kind: Call["kind"], extra: Partial<Call> = {}): void {
  const scope = scopes.get(instance);
  if (scope) calls.push({ ...scope, kind, ...extra });
}

function tableOf(id: unknown): string {
  // StringRecordId 与 RecordId 的字符串形式都是 "table:id"，SDK 的私有字段不可枚举。
  return String(id).split(":")[0];
}

/** 在真实 Surreal 原型上一次性装本文件作用域的 spy：不替换包模块，也不在每个测试重复安装。 */
const surrealdbSpiesInstalled = { value: false };
function installSurrealSpiesOnce(): void {
  if (surrealdbSpiesInstalled.value) return;
  surrealdbSpiesInstalled.value = true;
  installSurrealSpies();
}

function installSurrealSpies(): void {
  spyOn(Surreal.prototype, "connect").mockImplementation(async function (this: object, _url: string, options?: { database?: string }) {
    const scope = scopeFor(String(options?.database ?? ""));
    scopes.set(this, scope);
    record(this, "connect");
    return undefined as unknown as Awaited<ReturnType<typeof Surreal.prototype.connect>>;
  });
  spyOn(Surreal.prototype, "query").mockImplementation(async function (this: object, sql: string) {
    record(this, "query", { sql });
    if (/content_migration_state:legacy/i.test(sql)) return [markerRows] as never;
    return [[]] as never;
  });
  spyOn(Surreal.prototype, "select").mockImplementation(async function (this: object) {
    record(this, "select");
    return undefined as never;
  });
  spyOn(Surreal.prototype, "create").mockImplementation(function (this: object, id: unknown) {
    record(this, "create", { table: tableOf(id) });
    const index = calls.length - 1;
    return {
      content: async (data: Record<string, unknown>) => {
        if (index >= 0) calls[index] = { ...calls[index], content: data };
        return data;
      },
    } as never;
  });
  spyOn(Surreal.prototype, "upsert").mockImplementation(function (this: object, id: unknown) {
    record(this, "upsert", { table: tableOf(id) });
    const index = calls.length - 1;
    return {
      content: async (data: Record<string, unknown>) => {
        if (index >= 0) calls[index] = { ...calls[index], content: data };
        return data;
      },
    } as never;
  });
  spyOn(Surreal.prototype, "relate").mockImplementation(async function (this: object) {
    record(this, "relate");
    return undefined as never;
  });
  spyOn(Surreal.prototype, "close").mockImplementation(async function (this: object) {
    record(this, "close");
    return undefined as never;
  });
}

beforeEach(installSurrealSpiesOnce);
afterAll(() => {
  // 只复原本文件的 mock 注册；原型 spy 由进程结束回收。
  mock.restore();
});

const CLI_ENTRY = join(import.meta.dir, "migrate-legacy-cli.ts");

async function runCliEntry(options: { skipFlag?: boolean } = {}): Promise<{ ok: true } | { ok: false; error: Error }> {
  // 真实调用由 origin-pre-start.sh 传入 --writes-frozen；bun test 自身的 process.argv 不含该参数。
  const injected = !options.skipFlag;
  const originalArgv = process.argv;
  if (injected) process.argv = [...process.argv.filter((arg) => arg !== "--writes-frozen"), "--writes-frozen"];
  try {
    await import(`${CLI_ENTRY}?boundary=${crypto.randomUUID()}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  } finally {
    if (injected) process.argv = originalArgv;
  }
}

class FakeDb {
  constructor(readonly database: string) {}
  #push(role: Call["role"], kind: Call["kind"], extra: Partial<Call> = {}) {
    calls.push({ role, database: this.database, kind, ...extra });
  }
  get role(): Call["role"] {
    return this.database === "_system" ? "_system" : this.database === env.CONTENT_DATABASE ? "content" : "other";
  }
  async query(sql: string) {
    this.#push(this.role, "query", { sql });
    if (/content_migration_state:legacy/i.test(sql)) return [markerRows];
    return [[]];
  }
  async select() { this.#push(this.role, "select"); return undefined; }
  #write(kind: "create" | "upsert", id: { text?: string }) {
    this.#push(this.role, kind, { table: tableOf(id) });
    const index = calls.length - 1;
    return { async content(data: Record<string, unknown>) { calls[index] = { ...calls[index], content: data }; return data; } };
  }
  create(id: { text?: string }) { return this.#write("create", id); }
  upsert(id: { text?: string }) { return this.#write("upsert", id); }
  async relate() { this.#push(this.role, "relate"); }
}

/** 直接调用真实迁移函数（不经 CLI 入口），用于不变量与变异检测。 */
async function callIfNeeded(writesFrozen = true): Promise<unknown> {
  return migrateLegacyPlatformContentIfNeeded({
    source: new FakeDb("_system"),
    target: new FakeDb(env.CONTENT_DATABASE),
    writesFrozen,
  });
}

const ALLOWED_TARGET_TABLES = new Set<string>([...CONTENT_MIGRATION_TABLES, "content_migration_state"]);

/** 任何对来源写入、或目标越出白名单的写操作都算违规。返回违规描述（空数组表示无）。 */
function boundaryViolations(recorded: Call[]): string[] {
  const violations: string[] = [];
  for (const call of recorded) {
    const isWrite = call.kind === "create" || call.kind === "upsert" || call.kind === "relate";
    if (!isWrite) {
      if (call.role === "_system" && call.sql && !/^\s*(SELECT|INFO\b)/i.test(call.sql.trim())) {
        violations.push(`non-read query on _system: ${call.sql.slice(0, 60)}`);
      }
      continue;
    }
    if (call.role === "_system") violations.push(`${call.kind} on _system source`);
    if (call.role === "other") violations.push(`${call.kind} on unexpected database ${call.database}`);
    if (call.role === "content" && call.table && !ALLOWED_TARGET_TABLES.has(call.table)) {
      violations.push(`${call.kind} on unlisted target table ${call.table}`);
    }
  }
  return violations;
}

const connectedDatabases = () => calls.filter((call) => call.kind === "connect").map((call) => call.database);

describe("CL02 pre-start 迁移调用链边界（真实 CLI 入口，替身 DB）", () => {
  beforeEach(resetFixture);

  test("空目标：只连每个库一次（root 内容库 + _system 来源），schema 先于迁移，来源只读、目标只写白名单表，并写 marker", async () => {
    const result = await runCliEntry();
    expect(result.ok).toBe(true);
    expect(schemaCalls).toEqual(["ensurePlatformContentSchema"]);
    expect(connectedDatabases().sort()).toEqual(["_system", env.CONTENT_DATABASE].sort());
    expect(boundaryViolations(calls)).toEqual([]);
    const sourceQueries = calls.filter((call) => call.role === "_system" && call.kind === "query");
    expect(sourceQueries.length).toBeGreaterThan(0);
    for (const query of sourceQueries) expect(query.sql ?? "").toMatch(/^\s*SELECT\b/i);
    const markerWrite = calls.find((call) => call.kind === "upsert" && call.table === "content_migration_state");
    expect(markerWrite?.role).toBe("content");
    expect(markerWrite?.content).toMatchObject({ source_database: "_system" });
    expect(JSON.stringify(calls)).not.toContain(SENTINEL_PASSWORD);
  });

  test("已迁移 marker（verified_at 非空）：幂等短路——不读来源、不复制、不重写 marker", async () => {
    markerRows = [{ source_database: "_system", verified_at: new Date(0) }];
    const result = await runCliEntry();
    expect(result.ok).toBe(true);
    expect(schemaCalls).toEqual(["ensurePlatformContentSchema"]);
    expect(calls.filter((call) => call.role === "_system" && call.kind === "query")).toEqual([]);
    expect(calls.filter((call) => ["create", "relate", "upsert"].includes(call.kind))).toEqual([]);
  });

  test("未验证 marker（verified_at 为空）不算已完成：仍执行复制并写入新 marker", async () => {
    markerRows = [{ source_database: "_system", verified_at: null }];
    const result = await runCliEntry();
    expect(result.ok).toBe(true);
    expect(calls.some((call) => call.kind === "upsert" && call.table === "content_migration_state")).toBe(true);
  });

  test("缺少 --writes-frozen：入口在建立任何连接之前拒绝", async () => {
    resetFixture();
    const original = process.argv;
    process.argv = original.filter((arg) => arg !== "--writes-frozen");
    try {
      const result = await runCliEntry({ skipFlag: true });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("writes-frozen");
      expect(calls).toEqual([]);
      expect(schemaCalls).toEqual([]);
    } finally {
      process.argv = original;
    }
  });

  test("边界检查器自检：来源写入、未授权目标表、来源非只读查询、异常数据库都必须被检出", () => {
    expect(boundaryViolations([{ role: "_system", database: "_system", kind: "query", sql: "DELETE content_item;" }]))
      .toEqual(["non-read query on _system: DELETE content_item;"]);
    expect(boundaryViolations([{ role: "_system", database: "_system", kind: "create", table: "content_item" }]))
      .toEqual(["create on _system source"]);
    expect(boundaryViolations([{ role: "content", database: env.CONTENT_DATABASE, kind: "create", table: "system_admin" }]))
      .toEqual(["create on unlisted target table system_admin"]);
    expect(boundaryViolations([{ role: "other", database: "platform_content_v2", kind: "upsert", table: "content_item" }]))
      .toEqual(["upsert on unexpected database platform_content_v2"]);
    expect(boundaryViolations(calls)).toEqual([]);
  });
});

describe("CL02 不变量变异检测：绕过 IfNeeded、未冻结与越界写入必须判红", () => {
  beforeEach(resetFixture);

  test("已迁移目标：真实 IfNeeded 零来源读取、零写；无守卫入口继续读来源并重写 marker，行为可区分", async () => {
    markerRows = [{ source_database: "_system", verified_at: new Date(0) }];
    const guarded = await callIfNeeded();
    expect(guarded).toBe("already-migrated");
    expect(calls.filter((call) => call.role === "_system" && call.kind === "query")).toEqual([]);
    expect(calls.filter((call) => ["create", "relate", "upsert"].includes(call.kind))).toEqual([]);
    expect(boundaryViolations(calls)).toEqual([]);

    resetFixture();
    markerRows = [{ source_database: "_system", verified_at: new Date(0) }];
    await migrateLegacyPlatformContent({
      source: new FakeDb("_system"),
      target: new FakeDb(env.CONTENT_DATABASE),
      writesFrozen: true,
    });
    expect(calls.filter((call) => call.role === "_system" && call.kind === "query").length).toBeGreaterThan(0);
    expect(calls.some((call) => call.kind === "upsert" && call.table === "content_migration_state")).toBe(true);
  });

  test("未冻结（--writes-frozen 缺失等价）：真实 IfNeeded 在建立任何连接之前抛错", async () => {
    await expect(callIfNeeded(false)).rejects.toThrow("writes must be frozen");
    expect(calls).toEqual([]);
  });

  test("越界写入变异：真实迁移的写入全在目标白名单表；换成来源、未授权表或异常数据库即被判红", async () => {
    await callIfNeeded();
    expect(boundaryViolations(calls)).toEqual([]);
    expect(calls.filter((call) => call.kind === "create").every((call) => call.role === "content")).toBe(true);

    expect(boundaryViolations([...calls, { role: "_system", database: "_system", kind: "upsert", table: "content_migration_state" }]))
      .toContain("upsert on _system source");
    expect(boundaryViolations([...calls, { role: "content", database: env.CONTENT_DATABASE, kind: "create", table: "system_admin" }]))
      .toContain("create on unlisted target table system_admin");
    expect(boundaryViolations([...calls, { role: "other", database: "platform_content_v2", kind: "create", table: "content_item" }]))
      .toContain("create on unexpected database platform_content_v2");
  });
});

const REPO_ROOT = join(import.meta.dir, "../../..");
const SOURCE_HOOK = join(REPO_ROOT, "scripts/deploy/origin-pre-start.sh");
const tempDirs: string[] = [];

describe("CL02 黑盒：真实 scripts/deploy/origin-pre-start.sh 传给 CLI 的参数", () => {
  type HookFixture = { root: string; envFile: string; argvFile: string; script: string; home: string };

  afterAll(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeHookFixture(): HookFixture {
    const dir = mkdtempSync(join(tmpdir(), "hook-boundary-"));
    tempDirs.push(dir);
    const root = join(dir, "root");
    const content = join(root, "releases", "rel-boundary");
    mkdirSync(join(content, "server", "src", "content"), { recursive: true });
    // 只满足脚本 cd 的路径存在性；bun 是替身，不会真的执行它
    writeFileSync(join(content, "server", "src", "content", "migrate-legacy-cli.ts"), "// boundary fixture placeholder\n");
    const envFile = join(dir, "server.env");
    writeFileSync(envFile, "FIXTURE_ONLY=1\n");
    const argvFile = join(dir, "argv.json");
    // 钩子把 $HOME/.bun/bin 前置到 PATH：替身必须放在夹具 HOME 下，真实 bun 才会被遮蔽。
    const home = join(dir, "home");
    const bunBin = join(home, ".bun", "bin");
    mkdirSync(bunBin, { recursive: true });
    const bunStub = join(bunBin, "bun");
    writeFileSync(bunStub, [
      "#!/usr/bin/env bash",
      "{",
      "  printf '{\"which\":\"%s\",\"home\":\"%s\",\"pwd\":\"%s\",\"args\":[' \"$(command -v bun)\" \"$HOME\" \"$(pwd)\"",
      "  sep=",
      "  for a in \"$@\"; do printf '%s\"%s\"' \"$sep\" \"$a\"; sep=,; done",
      "  printf ']}\\n'",
      "} > \"$ARGV_FILE\"",
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(bunStub, 0o755);
    const scriptDir = join(dir, "scripts", "deploy");
    mkdirSync(scriptDir, { recursive: true });
    const script = join(scriptDir, "origin-pre-start.sh");
    copyFileSync(SOURCE_HOOK, script);
    return { root, envFile, argvFile, script, home };
  }

  type Recorded = { which: string; home: string; pwd: string; args: string[] };

  function runHook(fixture: HookFixture, script: string = fixture.script, envFile: string | null = fixture.envFile) {
    const environment: Record<string, string> = {
      PATH: `/bin:/usr/bin:${join(fixture.home, ".bun", "bin")}`,
      HOME: fixture.home,
      ARGV_FILE: fixture.argvFile,
    };
    if (envFile !== null) environment.ORIGIN_ENV_FILE = envFile;
    return Bun.spawnSync(["bash", script], {
      cwd: join(fixture.root, "releases", "rel-boundary"),
      env: environment,
      timeout: 10_000,
    });
  }

  const EXPECTED_TAIL = (envFile: string) => [`--env-file=${envFile}`, "src/content/migrate-legacy-cli.ts", "--writes-frozen"];

  test("钩子在发布目录 server/ 下经 bun run 调 CLI，并传 --writes-frozen；bun 为夹具替身", async () => {
    const fixture = makeHookFixture();
    const proc = runHook(fixture);
    expect(proc.exitCode).toBe(0);
    const recorded = await Bun.file(fixture.argvFile).json() as Recorded;
    expect(recorded.which).toBe(join(fixture.home, ".bun", "bin", "bun"));
    expect(recorded.home).toBe(fixture.home);
    expect(realpathSync(recorded.pwd)).toBe(realpathSync(join(fixture.root, "releases", "rel-boundary", "server")));
    expect(recorded.args).toEqual(["run", ...EXPECTED_TAIL(fixture.envFile)]);
  });

  test("缺少 ORIGIN_ENV_FILE 时钩子在执行 CLI 之前失败（set -u 参数展开）", () => {
    const fixture = makeHookFixture();
    const proc = runHook(fixture, fixture.script, null);
    expect(proc.exitCode).not.toBe(0);
  });

  test("变异（钩子丢掉 --writes-frozen）：同一 argv 断言必须检出", async () => {
    const fixture = makeHookFixture();
    const realText = readFileSync(fixture.script, "utf8");
    expect(realText).toContain("src/content/migrate-legacy-cli.ts --writes-frozen");
    const mutated = join(dirname(fixture.script), "origin-pre-start.mutant.sh");
    writeFileSync(mutated, realText.replace(" --writes-frozen", ""));
    const proc = runHook(fixture, mutated);
    expect(proc.exitCode).toBe(0);
    const recorded = await Bun.file(fixture.argvFile).json() as Recorded;
    expect(recorded.args).toEqual(["run", "--env-file=" + fixture.envFile, "src/content/migrate-legacy-cli.ts"]);
    expect(recorded.args).not.toEqual(["run", ...EXPECTED_TAIL(fixture.envFile)]);
  });
});
