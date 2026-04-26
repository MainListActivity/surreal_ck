/**
 * Integration test for identity bootstrap with embedded DB.
 * Run with: bun run scripts/test-app-bootstrap.ts
 *
 * Cannot run inside `bun test` due to NAPI worker thread incompatibility in Bun 1.3.x.
 * Does NOT call db.close() — known surrealdb-node constraint.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Surreal, RecordId, DateTime } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";

let passed = 0;
let failed = 0;

function ok(label: string) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label: string, err: unknown) {
  console.error(`  ✗ ${label}:`, err);
  failed++;
}

// ─── 复用 db/index.ts 的辅助逻辑（内联，避免 NAPI 约束冲突）───────────────────

function stripSchemaHeader(raw: string): string {
  return raw
    .replace(/^OPTION\s+IMPORT\s*;?\s*/im, "")
    .replace(/^USE\s+NS\s+\S+\s+DB\s+\S+\s*;?\s*/im, "");
}

async function loadSchema(db: Surreal): Promise<void> {
  const schemaPath = join(process.cwd(), "schema/main.surql");
  if (!existsSync(schemaPath)) {
    throw new Error(`schema not found: ${schemaPath}`);
  }
  const raw = await Bun.file(schemaPath).text();
  const schema = stripSchemaHeader(raw).replace(/DEFINE BUCKET[^;]*;/gs, "");
  await db.query(schema);
}

// ─── 集成测试 ─────────────────────────────────────────────────────────────────

const dbDir = join(tmpdir(), `bootstrap-test-${Date.now()}`);
mkdirSync(dbDir, { recursive: true });
const dbPath = join(dbDir, "test.db");

const db = new Surreal({ engines: { ...createNodeEngines() } });

try {
  await db.connect(`surrealkv://${dbPath.replaceAll("\\", "/")}`);
  await db.use({ namespace: "main", database: "u_test0001" });
  await loadSchema(db);
  ok("初始化 embedded DB 并加载 schema");
} catch (e) {
  fail("初始化 embedded DB 并加载 schema", e);
  process.exit(1);
}

// ─── 模拟 bootstrapLocalIdentity 核心逻辑 ────────────────────────────────────

type Claims = { sub: string; email?: string; name?: string; preferred_username?: string; picture?: string };

async function bootstrap(claims: Claims) {
  const userIdHex = Bun.hash.wyhash(claims.sub).toString(16).padStart(16, "0");
  const userId = new RecordId("app_user", userIdHex);
  const displayName =
    claims.preferred_username ?? claims.name ?? claims.email?.split("@")[0] ?? claims.sub.slice(0, 8);

  const userRows = await db.query<[{ id: RecordId; subject: string; email?: string }[]]>(
    `UPSERT $userId CONTENT {
      subject: $subject,
      email: $email,
      name: $name,
      display_name: $displayName,
      avatar: $avatar
    }`,
    {
      userId,
      subject: claims.sub,
      email: claims.email,
      name: claims.name,
      displayName,
      avatar: claims.picture,
    }
  );
  const user = userRows[0]?.[0];
  if (!user) throw new Error("app_user 写入失败");

  // 查询或创建默认 workspace
  const wsRows = await db.query<[{ id: RecordId; name: string; slug: string }[]]>(
    `SELECT id, name, slug FROM workspace WHERE owner = $userId LIMIT 1`,
    { userId }
  );
  let ws = wsRows[0]?.[0];

  if (!ws) {
    const wsIdHex = Bun.hash.wyhash(`${claims.sub}:default`).toString(16).padStart(16, "0");
    const wsId = new RecordId("workspace", wsIdHex);
    const slugBase = displayName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 20);
    const slug = `${slugBase || "workspace"}-${userIdHex.slice(0, 6)}`;

    const newWsRows = await db.query<[{ id: RecordId; name: string; slug: string }[]]>(
      `UPSERT $wsId CONTENT { owner: $userId, name: $wsName, slug: $slug }`,
      { wsId, userId, wsName: `${displayName} 的工作区`, slug }
    );
    ws = newWsRows[0]?.[0];
    if (!ws) throw new Error("workspace 创建失败");
  }

  return { user, workspace: ws };
}

// ─── 测试场景 ─────────────────────────────────────────────────────────────────

// Happy path: 首次 bootstrap 创建 user 和 workspace
try {
  const { user, workspace } = await bootstrap({
    sub: "oidc-sub-test-001",
    email: "alice@example.com",
    name: "Alice",
  });
  if (user.subject !== "oidc-sub-test-001") throw new Error(`subject 不匹配: ${user.subject}`);
  if (!workspace.slug) throw new Error("workspace slug 为空");
  ok("首次 bootstrap 创建 app_user 和 workspace");
} catch (e) {
  fail("首次 bootstrap 创建 app_user 和 workspace", e);
}

// Happy path: 同一 claims 再次 bootstrap 不重复创建 workspace
try {
  await bootstrap({ sub: "oidc-sub-test-001", email: "alice@example.com", name: "Alice" });

  const wsCountRows = await db.query<[{ count: number }[]]>(
    `SELECT count() as count FROM workspace GROUP ALL`
  );
  const count = wsCountRows[0]?.[0]?.count ?? 0;
  if (count !== 1) throw new Error(`workspace 数量应为 1，实际为 ${count}`);
  ok("重复 bootstrap 不增加 workspace 数量");
} catch (e) {
  fail("重复 bootstrap 不增加 workspace 数量", e);
}

// Happy path: 缺少 email 的 claims 也能成功 bootstrap
try {
  const { user } = await bootstrap({ sub: "oidc-sub-test-002" });
  if (user.subject !== "oidc-sub-test-002") throw new Error("subject 不匹配");
  const wsCountRows = await db.query<[{ count: number }[]]>(
    `SELECT count() as count FROM workspace GROUP ALL`
  );
  const count = wsCountRows[0]?.[0]?.count ?? 0;
  if (count !== 2) throw new Error(`第二个用户的 workspace 未创建，总数为 ${count}`);
  ok("缺少 email 时仍创建 user 和 workspace");
} catch (e) {
  fail("缺少 email 时仍创建 user 和 workspace", e);
}

// Verification: getAppBootstrap 能读到 user 和 workspace
try {
  const userRows = await db.query<[{ id: unknown; subject: string }[]]>(
    `SELECT id, subject FROM app_user WHERE subject = 'oidc-sub-test-001' LIMIT 1`
  );
  const user = userRows[0]?.[0];
  if (!user) throw new Error("未找到 app_user");

  const wsRows = await db.query<[{ id: unknown; name: string; slug: string }[]]>(
    `SELECT id, name, slug FROM workspace WHERE owner = $userId LIMIT 1`,
    { userId: user.id }
  );
  const ws = wsRows[0]?.[0];
  if (!ws) throw new Error("未找到 workspace");
  ok("getAppBootstrap 可读路径验证通过（user + workspace 均可查询）");
} catch (e) {
  fail("getAppBootstrap 可读路径验证通过", e);
}

// ─── 结果 ─────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
try {
  rmSync(dbDir, { recursive: true, force: true });
} catch (e) {
  console.warn("[cleanup] failed to remove temp DB directory:", e);
}

// Do not call db.close(): surrealdb-node can segfault under Bun. Force exit so
// open embedded-engine handles do not keep this verification script alive.
process.exit(failed > 0 ? 1 : 0);
