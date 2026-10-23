import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Surreal } from "surrealdb";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "../env";
import { CONTENT_MIGRATION_TABLES, migrateLegacyPlatformContent, migrateLegacyPlatformContentIfNeeded } from "./migrate-legacy";

/**
 * CL02：pre-start 钩子的迁移调用链边界回归（隔离、无真实 DB、无网络）。
 *
 * 1) 真实入口 `server/src/content/migrate-legacy-cli.ts`：全部使用真实模块（`surrealdb`、`../env`、
 *    `./schema`、`./migrate-legacy`），只在 `Surreal` 原型方法上装本文件作用域的 spy（不注册任何
 *    mock.module，避免 Bun 进程级模块替身泄漏到同进程的其它测试文件）。
 *    --writes-frozen 守卫、IfNeeded 选择、marker 幂等短路、_system 只读来源与 CONTENT_DATABASE
 *    只写目标，全部由被测代码决定。
 * 2) 数据夹具注入普通表记录、`cites_*` 关系记录与 v7 facet 回填输入，使复制循环真实执行；
 *    断言 schema 引导先于迁移、目标写入表在白名单内、来源零写入，并对 M7（复制写入未授权表）
 *    与 M8（schema 引导挪到迁移之后）两个变异副本给出红→绿证据。
 * 3) 黑盒执行真实 `scripts/deploy/origin-pre-start.sh`：PATH 上的 bun 为只记录 argv 的替身，
 *    只校验 cwd 与 `bun run` 参数（不执行真实 CLI）；钩子变异（丢掉 flag）必须被同一断言检出。
 */

type Role = "content" | "_system" | "other";
type Phase = "schema" | "migration";
type Call = {
  role: Role;
  database: string;
  kind: "connect" | "query" | "select" | "create" | "upsert" | "relate" | "close";
  phase: Phase;
  table?: string;
  sql?: string;
  content?: Record<string, unknown>;
  /** connect 观测：命名空间与维护身份是否与预期一致（只记录布尔，绝不记录用户名/口令本身）。 */
  namespace?: string;
  authPresent?: boolean;
  authUsernameMatches?: boolean;
  authPasswordMatches?: boolean;
};
type Row = Record<string, unknown>;

// env 使用真实模块（test/setup-env.ts 提供所需变量）；root 口令只用于断言不进入记录。
const TEST_ROOT_PASSWORD = env.SURREAL_ROOT_PASS;

const calls: Call[] = [];
let markerRows: Row[] = [];
/** schema 引导读到的当前版本；6 表示待执行 7/8/9，其中 7 会触发 facet 回填。 */
let schemaVersion = 6;
let schemaBootstrapCalls = 0;
let phase: Phase = "schema";
/** 来源库 `_system` 的夹具数据：table -> rows。 */
let sourceDataset: Record<string, Row[]> = {};
/** v7 facet 回填补丁查询的输入行。 */
let publishedRows: Row[] = [];
/** 目标库（CONTENT_DATABASE）已写入的行：table -> rows。 */
const targetRows = new Map<string, Row[]>();

function resetFixture(): void {
  calls.length = 0;
  markerRows = [];
  schemaVersion = 6;
  schemaBootstrapCalls = 0;
  phase = "schema";
  sourceDataset = {};
  publishedRows = [];
  targetRows.clear();
}

function roleFor(database: string): Role {
  return database === "_system" ? "_system" : database === env.CONTENT_DATABASE ? "content" : "other";
}

function tableOf(id: unknown): string {
  return String(id).split(":")[0];
}

function pushRow(table: string, row: Row): void {
  const rows = targetRows.get(table) ?? [];
  rows.push(row);
  targetRows.set(table, rows);
}

function rowsFor(table: string): Row[] {
  return targetRows.get(table) ?? [];
}

function record(role: Role, database: string, kind: Call["kind"], extra: Partial<Call> = {}): void {
  calls.push({ role, database, kind, phase, ...extra });
}

/** 替身查询应答：schema 引导、marker、来源/目标表读取、v7 facet 回填共用同一套规则。 */
function answerQuery(role: Role, sql: string): unknown {
  const q = sql.trim();
  if (/DEFINE DATABASE IF NOT EXISTS/i.test(q)) {
    schemaBootstrapCalls += 1;
    return [[]];
  }
  if (/SELECT version FROM platform_content_schema_version:current/i.test(q)) return [[{ version: schemaVersion }]];
  if (/FROM content_migration_state:legacy/i.test(q)) return [markerRows];
  if (/FROM content_publication_projection/i.test(q)) return [publishedRows];
  if (/FROM content_search_facet/i.test(q)) return [[]];
  const table = /^SELECT \* FROM ([a-z_]+)/i.exec(q)?.[1];
  if (table) return [role === "_system" ? (sourceDataset[table] ?? []) : rowsFor(table)];
  return [[]];
}

function installSurrealSpiesOnce(): void {
  if (spiesInstalled.value) return;
  spiesInstalled.value = true;
  for (const method of ["connect", "query", "select", "create", "upsert", "relate", "close", "use"] as const) {
    originalSurrealMethods.set(method, (Surreal.prototype as unknown as Record<string, unknown>)[method]);
  }
  spyOn(Surreal.prototype, "connect").mockImplementation(async function (this: object, _url: string, options?: {
    namespace?: string;
    database?: string;
    authentication?: { username?: string; password?: string };
  }) {
    const database = String(options?.database ?? "");
    scopes.set(this, { role: roleFor(database), database });
    const authentication = options?.authentication;
    record(roleFor(database), database, "connect", {
      namespace: options?.namespace,
      authPresent: Boolean(authentication),
      authUsernameMatches: authentication?.username === env.SURREAL_ROOT_USER,
      authPasswordMatches: authentication?.password === env.SURREAL_ROOT_PASS,
    });
    return undefined as never;
  });
  spyOn(Surreal.prototype, "use").mockImplementation(async function () {
    return undefined as never;
  });
  spyOn(Surreal.prototype, "query").mockImplementation(async function (this: object, sql: string) {
    const scope = scopes.get(this) ?? { role: "other" as Role, database: "" };
    if (/content_migration_state:legacy/i.test(sql)) phase = "migration";
    record(scope.role, scope.database, "query", { sql });
    return answerQuery(scope.role, sql) as never;
  });
  spyOn(Surreal.prototype, "select").mockImplementation(async function (this: object, id: unknown) {
    const scope = scopes.get(this) ?? { role: "other" as Role, database: "" };
    record(scope.role, scope.database, "select");
    return (rowsFor(tableOf(id)).find((row) => String(row.id) === String(id))) as never;
  });
  const writeSpy = (kind: "create" | "upsert") => spyOn(Surreal.prototype, kind).mockImplementation(function (this: object, id: unknown) {
    const scope = scopes.get(this) ?? { role: "other" as Role, database: "" };
    record(scope.role, scope.database, kind, { table: tableOf(id) });
    const index = calls.length - 1;
    return {
      content: async (data: Row) => {
        calls[index] = { ...calls[index], content: data };
        if (scope.role === "content") pushRow(tableOf(id), { id: String(id), ...data });
        return data;
      },
    } as never;
  });
  writeSpy("create");
  writeSpy("upsert");
  spyOn(Surreal.prototype, "relate").mockImplementation(async function (this: object, from: unknown, edge: unknown, to: unknown, data: Row) {
    const scope = scopes.get(this) ?? { role: "other" as Role, database: "" };
    record(scope.role, scope.database, "relate", { table: tableOf(edge) });
    if (scope.role === "content") pushRow(tableOf(edge), { id: String(edge), in: String(from), out: String(to), ...data });
    return undefined as never;
  });
  spyOn(Surreal.prototype, "close").mockImplementation(async function (this: object) {
    const scope = scopes.get(this) ?? { role: "other" as Role, database: "" };
    record(scope.role, scope.database, "close");
    return undefined as never;
  });
}

const scopes = new WeakMap<object, { role: Role; database: string }>();
const originalSurrealMethods = new Map<string, unknown>();
const spiesInstalled = { value: false };

beforeEach(() => {
  installSurrealSpiesOnce();
  resetFixture();
});

afterAll(() => {
  // 复原原型方法：Bun 可能在同一进程/VM 中继续运行其它测试文件。
  for (const [method, original] of originalSurrealMethods) {
    (Surreal.prototype as unknown as Record<string, unknown>)[method] = original;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CLI_ENTRY = join(import.meta.dir, "migrate-legacy-cli.ts");

async function runCliEntry(options: { skipFlag?: boolean; entry?: string } = {}): Promise<{ ok: true } | { ok: false; error: Error }> {
  // 真实调用由 origin-pre-start.sh 传入 --writes-frozen；bun test 自身的 process.argv 不含该参数。
  const injected = !options.skipFlag;
  const originalArgv = process.argv;
  if (injected) process.argv = [...process.argv.filter((arg) => arg !== "--writes-frozen"), "--writes-frozen"];
  try {
    await import(`${options.entry ?? CLI_ENTRY}?boundary=${crypto.randomUUID()}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  } finally {
    if (injected) process.argv = originalArgv;
  }
}

/** 直接调用真实迁移函数用的轻量 DB（不经过 Surreal 类，因此同时覆盖不变量的独立路径）。 */
class FakeDb {
  constructor(readonly database: string) {}
  get role(): Role {
    return roleFor(this.database);
  }
  async query(sql: string) {
    if (/content_migration_state:legacy/i.test(sql)) phase = "migration";
    record(this.role, this.database, "query", { sql });
    return answerQuery(this.role, sql);
  }
  async select(id: unknown) {
    record(this.role, this.database, "select");
    return rowsFor(tableOf(id)).find((row) => String(row.id) === String(id));
  }
  #write(kind: "create" | "upsert", id: unknown) {
    const role = this.role;
    record(role, this.database, kind, { table: tableOf(id) });
    const index = calls.length - 1;
    return {
      content: async (data: Row) => {
        calls[index] = { ...calls[index], content: data };
        if (role === "content") pushRow(tableOf(id), { id: String(id), ...data });
        return data;
      },
    };
  }
  create(id: unknown) { return this.#write("create", id); }
  upsert(id: unknown) { return this.#write("upsert", id); }
  async relate(from: unknown, edge: unknown, to: unknown, data: Row) {
    record(this.role, this.database, "relate", { table: tableOf(edge) });
    pushRow(tableOf(edge), { id: String(edge), in: String(from), out: String(to), ...data });
  }
}

/** 普通表、cites_* 关系与引用闭合的最小数据集；v7 facet 回填另有 publishedRows。 */
function installCopyDataset(): void {
  sourceDataset = {
    content_source: [{ id: "content_source:src1" }],
    content_item: [{ id: "content_item:item1", current_version: "content_version:v1" }],
    content_version: [{ id: "content_version:v1", item: "content_item:item1", source: "content_source:src1" }],
    legal_article_version: [{ id: "legal_article_version:law1" }],
    content_citation: [{ id: "content_citation:cit1", document_version: "legal_article_version:law1" }],
    citation_resolution: [{ id: "citation_resolution:res1", citation: "content_citation:cit1" }],
    cites_article: [{
      id: "cites_article:edge1",
      in: "content_citation:cit1",
      out: "legal_article_version:law1",
      resolution_revision: "citation_resolution:res1",
    }],
  };
  publishedRows = [{
    id: "content_publication_projection:p1",
    item: "content_item:item1",
    version: "content_version:v1",
    kind: "article",
  }];
}

const ALLOWED_TARGET_TABLES = new Set<string>([...CONTENT_MIGRATION_TABLES, "content_migration_state", "content_search_facet"]);

/** 来源零写、目标只写白名单表；迁移阶段（marker 检出之后）不允许任何写形态的原始 query。 */
function boundaryViolations(recorded: Call[]): string[] {
  const violations: string[] = [];
  for (const call of recorded) {
    if (call.kind === "query") {
      const sql = (call.sql ?? "").trim();
      if (/^(SELECT|INFO)\b/i.test(sql)) continue;
      if (call.role === "_system") violations.push(`non-read query on _system: ${sql.slice(0, 60)}`);
      else if (call.phase === "migration") violations.push(`non-read query in migration on ${call.role}: ${sql.slice(0, 60)}`);
      continue;
    }
    if (call.kind !== "create" && call.kind !== "upsert" && call.kind !== "relate") continue;
    if (call.role === "_system") violations.push(`${call.kind} on _system source`);
    else if (call.role === "other") violations.push(`${call.kind} on unexpected database ${call.database}`);
    else if (call.table && !ALLOWED_TARGET_TABLES.has(call.table)) violations.push(`${call.kind} on unlisted target table ${call.table}`);
  }
  return violations;
}

/** schema 引导必须在迁移 marker 检查与来源读取之前。 */
function orderingViolations(recorded: Call[]): string[] {
  const indexOf = (predicate: (call: Call) => boolean) => recorded.findIndex(predicate);
  const schema = indexOf((call) => call.kind === "query" && /DEFINE DATABASE IF NOT EXISTS/i.test(call.sql ?? ""));
  const marker = indexOf((call) => call.kind === "query" && /content_migration_state:legacy/i.test(call.sql ?? ""));
  const source = indexOf((call) => call.role === "_system" && call.kind === "query");
  const violations: string[] = [];
  if (schema < 0) violations.push("schema bootstrap did not run");
  if (marker < 0) violations.push("migration marker check did not run");
  if (schema >= 0 && marker >= 0 && schema > marker) violations.push("schema bootstrap ran after the migration started");
  if (schema >= 0 && source >= 0 && schema > source) violations.push("schema bootstrap ran after source reads");
  return violations;
}

/** 连接必须使用预期的服务与命名空间、且携带预期的维护身份；只比对结果，不保存秘密。 */
function identityViolations(recorded: Call[]): string[] {
  const violations: string[] = [];
  const connects = recorded.filter((call) => call.kind === "connect");
  if (connects.length === 0) violations.push("no connection recorded");
  for (const connect of connects) {
    const label = `${connect.role}:${connect.database}`;
    if (!connect.authPresent) violations.push(`${label} connected without authentication`);
    else if (!connect.authUsernameMatches || !connect.authPasswordMatches) {
      violations.push(`${label} used an unexpected maintenance identity`);
    }
    if (connect.namespace !== env.SURREAL_NS) violations.push(`${label} used an unexpected namespace`);
  }
  return violations;
}

const tablesWrittenOnTarget = () => calls
  .filter((call) => call.role === "content" && (call.kind === "create" || call.kind === "upsert" || call.kind === "relate"))
  .map((call) => call.table ?? "");

const connectedDatabases = () => calls.filter((call) => call.kind === "connect").map((call) => call.database);

describe("CL02 pre-start 迁移调用链边界（真实 CLI 入口，替身 DB + 非空数据集）", () => {
  test("schema 先于迁移；复制普通表与 cites_* 关系；v7 facet 回填；来源只读、目标只写白名单表；写 marker", async () => {
    installCopyDataset();
    const result = await runCliEntry();
    expect(result.ok).toBe(true);

    expect(orderingViolations(calls)).toEqual([]);
    expect(boundaryViolations(calls)).toEqual([]);
    expect(identityViolations(calls)).toEqual([]);
    expect(connectedDatabases().sort()).toEqual(["_system", env.CONTENT_DATABASE].sort());
    expect(schemaBootstrapCalls).toBeGreaterThan(0);

    // 普通表复制：真实 create 发生在目标库
    const created = calls.filter((call) => call.kind === "create" && call.role === "content").map((call) => call.table);
    for (const table of ["content_source", "content_item", "content_version", "legal_article_version", "content_citation", "citation_resolution"]) {
      expect(created).toContain(table);
    }
    // cites_* 关系复制走 relate
    expect(calls.some((call) => call.kind === "relate" && call.table === "cites_article" && call.role === "content")).toBe(true);
    // v7 facet 回填在 schema 阶段创建 content_search_facet
    expect(calls.some((call) => call.phase === "schema" && call.kind === "query" && /CREATE content_search_facet/i.test(call.sql ?? ""))).toBe(true);
    expect(tablesWrittenOnTarget().every((table) => ALLOWED_TARGET_TABLES.has(table))).toBe(true);

    // 来源只读
    const sourceQueries = calls.filter((call) => call.role === "_system" && call.kind === "query");
    expect(sourceQueries.length).toBeGreaterThan(0);
    for (const query of sourceQueries) expect(query.sql ?? "").toMatch(/^\s*SELECT\b/i);

    const markerWrite = calls.find((call) => call.kind === "upsert" && call.table === "content_migration_state");
    expect(markerWrite?.role).toBe("content");
    expect(markerWrite?.content).toMatchObject({ source_database: "_system" });
    expect(JSON.stringify(calls)).not.toContain(TEST_ROOT_PASSWORD);
  });

  test("已迁移 marker：即使来源有数据也幂等短路——不读来源、不复制、不重写 marker", async () => {
    installCopyDataset();
    markerRows = [{ source_database: "_system", verified_at: new Date(0) }];
    const result = await runCliEntry();
    expect(result.ok).toBe(true);
    expect(calls.filter((call) => call.kind === "query" && /DEFINE DATABASE IF NOT EXISTS/i.test(call.sql ?? "")).length).toBeGreaterThan(0);
    expect(calls.filter((call) => call.role === "_system" && call.kind === "query")).toEqual([]);
    expect(calls.filter((call) => ["create", "relate", "upsert"].includes(call.kind))).toEqual([]);
    expect(targetRows.size).toBe(0);
  });

  test("未验证 marker 不算完成：仍执行复制并写入新 marker", async () => {
    installCopyDataset();
    markerRows = [{ source_database: "_system", verified_at: null }];
    const result = await runCliEntry();
    expect(result.ok).toBe(true);
    expect(calls.some((call) => call.kind === "upsert" && call.table === "content_migration_state")).toBe(true);
    expect(calls.some((call) => call.kind === "create" && call.table === "content_item")).toBe(true);
  });

  test("缺少 --writes-frozen：入口在建立任何连接之前拒绝，错误信息指明写入冻结", async () => {
    const original = process.argv;
    process.argv = original.filter((arg) => arg !== "--writes-frozen");
    try {
      const result = await runCliEntry({ skipFlag: true });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("writes-frozen");
      expect(calls).toEqual([]);
      expect(schemaBootstrapCalls).toBe(0);
    } finally {
      process.argv = original;
    }
  });

  test("边界检查器自检：来源写入、来源非只读查询、未授权目标表、异常数据库、迁移阶段写查询都必须被检出", () => {
    expect(boundaryViolations([{ role: "_system", database: "_system", kind: "query", phase: "migration", sql: "DELETE content_item;" }]))
      .toEqual(["non-read query on _system: DELETE content_item;"]);
    expect(boundaryViolations([{ role: "_system", database: "_system", kind: "create", phase: "migration", table: "content_item" }]))
      .toEqual(["create on _system source"]);
    expect(boundaryViolations([{ role: "content", database: env.CONTENT_DATABASE, kind: "create", phase: "migration", table: "system_admin" }]))
      .toEqual(["create on unlisted target table system_admin"]);
    expect(boundaryViolations([{ role: "other", database: "platform_content_v2", kind: "upsert", phase: "migration", table: "content_item" }]))
      .toEqual(["upsert on unexpected database platform_content_v2"]);
    expect(boundaryViolations([{ role: "content", database: env.CONTENT_DATABASE, kind: "query", phase: "migration", sql: "UPSERT content_item CONTENT {}" }]))
      .toEqual(["non-read query in migration on content: UPSERT content_item CONTENT {}"]);
    expect(boundaryViolations(calls)).toEqual([]);
  });

  test("顺序检查器自检：schema 在迁移之后必须被判红", () => {
    expect(orderingViolations([
      { role: "content", database: env.CONTENT_DATABASE, kind: "query", phase: "migration", sql: "SELECT * FROM content_migration_state:legacy;" },
      { role: "content", database: env.CONTENT_DATABASE, kind: "query", phase: "migration", sql: "DEFINE DATABASE IF NOT EXISTS platform_content;" },
    ])).toContain("schema bootstrap ran after the migration started");
  });
});

describe("CL02 不变量变异检测：绕过 IfNeeded、未冻结与越界写入必须判红", () => {
  test("已迁移目标：真实 IfNeeded 零来源读取、零写；无守卫入口继续读来源并重写 marker，行为可区分", async () => {
    installCopyDataset();
    markerRows = [{ source_database: "_system", verified_at: new Date(0) }];
    phase = "migration";
    const guarded = await migrateLegacyPlatformContentIfNeeded({
      source: new FakeDb("_system"),
      target: new FakeDb(env.CONTENT_DATABASE),
      writesFrozen: true,
    });
    expect(guarded).toBe("already-migrated");
    expect(calls.filter((call) => call.role === "_system" && call.kind === "query")).toEqual([]);
    expect(calls.filter((call) => ["create", "relate", "upsert"].includes(call.kind))).toEqual([]);

    resetFixture();
    installCopyDataset();
    phase = "migration";
    await migrateLegacyPlatformContent({
      source: new FakeDb("_system"),
      target: new FakeDb(env.CONTENT_DATABASE),
      writesFrozen: true,
    });
    expect(calls.filter((call) => call.role === "_system" && call.kind === "query").length).toBeGreaterThan(0);
    expect(calls.some((call) => call.kind === "upsert" && call.table === "content_migration_state")).toBe(true);
  });

  test("未冻结（--writes-frozen 缺失等价）：真实 IfNeeded 在建立任何连接之前抛错", async () => {
    await expect(migrateLegacyPlatformContentIfNeeded({
      source: new FakeDb("_system"),
      target: new FakeDb(env.CONTENT_DATABASE),
      writesFrozen: false,
    })).rejects.toThrow("writes must be frozen");
    expect(calls).toEqual([]);
  });
});

const REPO_ROOT = join(import.meta.dir, "../../..");
const SOURCE_CLI = join(import.meta.dir, "migrate-legacy-cli.ts");
const SOURCE_MIGRATE = join(import.meta.dir, "migrate-legacy.ts");
const SOURCE_HOOK = join(REPO_ROOT, "scripts/deploy/origin-pre-start.sh");
const tempDirs: string[] = [];

/** 在仓库内建变异副本：真实相对导入（../env、./schema、./migrate-legacy）经同层 stub 解析到真实模块。 */
function makeMutantFixture(): { dir: string; cli: (mutate: boolean) => string; migrate: (mutate: boolean) => string } {
  const dir = mkdtempSync(join(import.meta.dir, ".boundary-mutant-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "content"), { recursive: true });
  writeFileSync(join(dir, "env.ts"), 'export { env } from "../../env";\n');
  writeFileSync(join(dir, "content", "schema.ts"), 'export * from "../../schema";\n');
  const replace = (source: string, text: string, pairs: Array<[string, string]>) => {
    let out = text;
    for (const [from, to] of pairs) {
      expect(out.includes(from)).toBe(true);
      out = out.split(from).join(to);
    }
    return out;
  };
  const write = (target: string, text: string) => {
    writeFileSync(target, text);
    return target;
  };
  // CLI 的 ./migrate-legacy 固定解析到干净副本；M7 变异体写到独立文件，避免互换。
  const cleanMigrate = write(join(dir, "content", "migrate-legacy.ts"), readFileSync(SOURCE_MIGRATE, "utf8"));
  type CliMutation = "clean" | "m8" | "m9" | "m10" | "m11";
  const cliMutations: Record<Exclude<CliMutation, "clean">, Array<[string, string]>> = {
    // M8：schema 引导挪到迁移之后
    m8: [[
      "  await ensurePlatformContentSchema(root);\n  await source.connect(env.SURREAL_URL, {",
      "  await source.connect(env.SURREAL_URL, {",
    ], [
      "  if (summary === \"already-migrated\") {",
      "  await ensurePlatformContentSchema(root);\n  if (summary === \"already-migrated\") {",
    ]],
    // M9：错误维护身份（假值，不含任何真实秘密）
    m9: [[
      "const authentication = { username: env.SURREAL_ROOT_USER, password: env.SURREAL_ROOT_PASS };",
      'const authentication = { username: "fixture-unapproved-principal", password: "fixture-wrong-auth" };',
    ]],
    // M10：省略 authentication
    m10: [[", authentication,", ","]],
    // M11：错误命名空间
    m11: [["namespace: env.SURREAL_NS", 'namespace: "fixture_wrong_namespace"']],
  };
  const cli = (kind: CliMutation) => {
    const original = readFileSync(SOURCE_CLI, "utf8");
    const text = kind === "clean" ? original : replace(SOURCE_CLI, original, cliMutations[kind]);
    return write(join(dir, "content", kind === "clean" ? "migrate-legacy-cli.ts" : `migrate-legacy-cli.${kind}.ts`), text);
  };
  const migrate = (mutate: boolean) => {
    if (!mutate) return cleanMigrate;
    const original = readFileSync(SOURCE_MIGRATE, "utf8");
    const text = replace(SOURCE_MIGRATE, original, [[
      "await input.target.create(id).content(content);",
      "await input.target.create(new StringRecordId(\"system_admin:rogue\")).content(content);",
    ]]);
    return write(join(dir, "content", "migrate-legacy.m7.ts"), text);
  };
  return { dir, cli, migrate };
}

describe("CL02 M7/M8 变异：夹具注入数据后必须判红（同一不变量对真实入口判绿）", () => {
  test("M7（复制循环把 create 写到未授权表 system_admin）：检查器判红；未变异副本判绿", async () => {
    const fixture = makeMutantFixture();
    installCopyDataset();
    phase = "migration";
    const mutantEntry = fixture.migrate(true);
    const mutant = await import(`${mutantEntry}?m7=${crypto.randomUUID()}`) as typeof import("./migrate-legacy");
    await expect(mutant.migrateLegacyPlatformContentIfNeeded({
      source: new FakeDb("_system"),
      target: new FakeDb(env.CONTENT_DATABASE),
      writesFrozen: true,
    })).rejects.toThrow();
    expect(boundaryViolations(calls)).toContain("create on unlisted target table system_admin");

    resetFixture();
    installCopyDataset();
    phase = "migration";
    const cleanEntry = fixture.migrate(false);
    const clean = await import(`${cleanEntry}?m7-clean=${crypto.randomUUID()}`) as typeof import("./migrate-legacy");
    await clean.migrateLegacyPlatformContentIfNeeded({
      source: new FakeDb("_system"),
      target: new FakeDb(env.CONTENT_DATABASE),
      writesFrozen: true,
    });
    expect(boundaryViolations(calls)).toEqual([]);
  });

  test("M8（schema 引导挪到迁移之后）：顺序检查器判红；真实入口判绿", async () => {
    const fixture = makeMutantFixture();
    installCopyDataset();
    const mutantEntry = fixture.cli("m8");
    await runCliEntry({ entry: mutantEntry });
    expect(orderingViolations(calls)).toContain("schema bootstrap ran after the migration started");

    resetFixture();
    installCopyDataset();
    const cleanEntry = fixture.cli("clean");
    const clean = await runCliEntry({ entry: cleanEntry });
    expect(clean.ok).toBe(true);
    expect(orderingViolations(calls)).toEqual([]);
  });
});

describe("CL02 维护身份与命名空间：错误/缺失认证与错误命名空间必须判红", () => {
  test("M9（错误维护身份）：identityViolations 判红；真实入口判绿；记录中不含口令", async () => {
    const fixture = makeMutantFixture();
    installCopyDataset();
    const mutant = await runCliEntry({ entry: fixture.cli("m9") });
    expect(mutant.ok).toBe(true);
    expect(identityViolations(calls).join("\n")).toContain("used an unexpected maintenance identity");
    expect(JSON.stringify(calls)).not.toContain(TEST_ROOT_PASSWORD);

    resetFixture();
    installCopyDataset();
    const clean = await runCliEntry({ entry: fixture.cli("clean") });
    expect(clean.ok).toBe(true);
    expect(identityViolations(calls)).toEqual([]);
  });

  test("M10（省略 authentication）：identityViolations 判红；真实入口判绿", async () => {
    const fixture = makeMutantFixture();
    installCopyDataset();
    const mutant = await runCliEntry({ entry: fixture.cli("m10") });
    expect(mutant.ok).toBe(true);
    expect(identityViolations(calls).join("\n")).toContain("connected without authentication");

    resetFixture();
    installCopyDataset();
    const clean = await runCliEntry({ entry: fixture.cli("clean") });
    expect(clean.ok).toBe(true);
    expect(identityViolations(calls)).toEqual([]);
  });

  test("M11（错误命名空间）：identityViolations 判红；真实入口判绿", async () => {
    const fixture = makeMutantFixture();
    installCopyDataset();
    const mutant = await runCliEntry({ entry: fixture.cli("m11") });
    expect(mutant.ok).toBe(true);
    expect(identityViolations(calls).join("\n")).toContain("used an unexpected namespace");

    resetFixture();
    installCopyDataset();
    const clean = await runCliEntry({ entry: fixture.cli("clean") });
    expect(clean.ok).toBe(true);
    expect(identityViolations(calls)).toEqual([]);
  });
});

describe("CL02 黑盒：真实 scripts/deploy/origin-pre-start.sh 传给 CLI 的参数（只到 argv）", () => {
  type HookFixture = { root: string; envFile: string; argvFile: string; script: string; home: string };

  function makeHookFixture(): HookFixture {
    const dir = mkdtempSync(join(tmpdir(), "hook-boundary-"));
    tempDirs.push(dir);
    const root = join(dir, "root");
    const content = join(root, "releases", "rel-boundary");
    mkdirSync(join(content, "server", "src", "content"), { recursive: true });
    // 只满足脚本 cd 的路径存在性；bun 是替身，不执行真实 CLI。
    writeFileSync(join(content, "server", "src", "content", "migrate-legacy-cli.ts"), "// boundary fixture placeholder\n");
    const envFile = join(dir, "server.env");
    writeFileSync(envFile, "FIXTURE_ONLY=1\n");
    const argvFile = join(dir, "argv.json");
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

  const expectedArgs = (envFile: string) => ["run", `--env-file=${envFile}`, "src/content/migrate-legacy-cli.ts", "--writes-frozen"];

  /** 正例与变异用例共用同一断言：参数、替身来源与执行目录。 */
  function assertInvocation(recorded: Recorded, fixture: HookFixture): void {
    expect(recorded.which).toBe(join(fixture.home, ".bun", "bin", "bun"));
    expect(recorded.home).toBe(fixture.home);
    expect(realpathSync(recorded.pwd)).toBe(realpathSync(join(fixture.root, "releases", "rel-boundary", "server")));
    expect(recorded.args).toEqual(expectedArgs(fixture.envFile));
  }

  test("钩子在发布目录 server/ 下经 bun run 调 CLI，并传 --writes-frozen", async () => {
    const fixture = makeHookFixture();
    const proc = runHook(fixture);
    expect(proc.exitCode).toBe(0);
    assertInvocation(await Bun.file(fixture.argvFile).json() as Recorded, fixture);
  });

  test("缺少 ORIGIN_ENV_FILE 时钩子在执行 CLI 之前失败（set -u 参数展开）", () => {
    const fixture = makeHookFixture();
    const proc = runHook(fixture, fixture.script, null);
    expect(proc.exitCode).not.toBe(0);
  });

  test("变异（钩子丢掉 --writes-frozen）：共用断言必须判红", async () => {
    const fixture = makeHookFixture();
    const realText = readFileSync(fixture.script, "utf8");
    expect(realText).toContain("src/content/migrate-legacy-cli.ts --writes-frozen");
    const mutated = join(dirname(fixture.script), "origin-pre-start.mutant.sh");
    writeFileSync(mutated, realText.replace(" --writes-frozen", ""));
    const proc = runHook(fixture, mutated);
    expect(proc.exitCode).toBe(0);
    const recorded = await Bun.file(fixture.argvFile).json() as Recorded;
    expect(() => assertInvocation(recorded, fixture)).toThrow();
    expect(recorded.args).toEqual(["run", `--env-file=${fixture.envFile}`, "src/content/migrate-legacy-cli.ts"]);
  });
});
