import { Surreal } from "surrealdb";
import { env } from "../env";

/**
 * 发布门禁受控检查（LCA13）：`_system.content_grant_revocation` 是否存在撤销行。
 *
 * 撤销是追加式事实，旧代码（不含撤销过滤）会把已撤销赠送复活为有效来源；
 * origin-release.sh 在激活任何不含撤销过滤的目标前调用本检查。
 *
 * 用法：bun run --env-file=<server.env> src/db/grant-revocation-check-cli.ts
 * 输出：stdout `grant_revocations=<n>`（表尚不存在按 0 处理——门禁前发布
 * 的 _system 不可能有撤销写入路径）。
 * 退出码：0=查询成功；2=连接/查询失败（调用方必须按「不可证明安全」拒绝）。
 */
function fail(message: string): never {
  console.error(`grant-revocation-check: ${message}`);
  process.exit(2);
}

const timeout = setTimeout(() => fail("timed out after 10s"), 10_000);

const db = new Surreal();
try {
  await db.connect(env.SURREAL_URL, {
    namespace: env.SURREAL_NS,
    database: "_system",
    authentication: {
      username: env.SURREAL_ROOT_USER,
      password: env.SURREAL_ROOT_PASS,
    },
  });
  let result: unknown;
  try {
    result = await db.query(
      "SELECT count() AS count FROM content_grant_revocation GROUP ALL;",
    );
  } catch (error) {
    // 门禁前版本的 _system 没有该表：查询报 "does not exist" 按 0 行处理。
    if (error instanceof Error && error.message.includes("does not exist")) {
      result = [[]];
    } else {
      throw error;
    }
  }
  const statements = Array.isArray(result) ? result : [];
  const rows = Array.isArray(statements[0])
    ? (statements[0] as { count?: unknown }[])
    : [];
  const count = typeof rows[0]?.count === "number" ? rows[0].count : 0;
  console.log(`grant_revocations=${count}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  clearTimeout(timeout);
  await db.close().catch(() => undefined);
}
