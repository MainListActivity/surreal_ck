import { Surreal } from "surrealdb";
import { env } from "../env";
import { GRANT_REVOCATION_TABLE, parseRevocationCount, revocationTableDefined } from "./grant-revocation-count";

/**
 * 发布门禁受控检查（LCA13）：`_system.content_grant_revocation` 是否存在撤销行。
 *
 * 撤销是追加式事实，旧代码（不含撤销过滤）会把已撤销赠送复活为有效来源；
 * origin-release.sh 在激活任何不含撤销过滤的目标前调用本检查。
 *
 * 用法：bun run --env-file=<server.env> src/db/grant-revocation-check-cli.ts
 * 输出：stdout 恰好一行 `grant_revocations=<n>`。撤销表未在 INFO FOR DB 中定义 → 0（门禁前发布的 _system 不可能有撤销写入路径）。
 * 退出码：0=计数成功；2=连接、查询或结果形状异常（调用方必须按「不可证明安全」拒绝）。
 * 解析与失败关闭规则见 grant-revocation-count.ts；本入口不依据错误文本把任何失败回落为 0。
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
  let count = 0;
  if (revocationTableDefined(await db.query("INFO FOR DB;"))) {
    count = parseRevocationCount(
      await db.query(`SELECT count() AS count FROM ${GRANT_REVOCATION_TABLE} GROUP ALL;`),
    );
  }
  console.log(`grant_revocations=${count}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  clearTimeout(timeout);
  await db.close().catch(() => undefined);
}
