/**
 * 一次性诊断脚本（用完即删，勿进生产路径）。
 *
 * 用 root 连接连到 _system 库，把 system_admin 表里所有 subject 以可肉眼比对的形态打印：
 *   "<值>"(len=N)
 * 长度、首尾空白、不可见字符一眼可见。
 *
 * 用法（在 server/ 目录下，带项目实际 env 跑）：
 *   cd server && bun run --env-file=../.env ../.scratch/workspace-as-db/diagnose-system-admin.ts
 * （--env-file 路径按你实际 .env 位置调整；脚本不接受、不打印任何 token。）
 *
 * 对比方法：在浏览器 DevTools 解出 token 的 sub，按同样的 "..."(len=N) 形态贴出来，
 * 与下面打印的 storedSubjects 逐字符比——大小写 / 空白 / 前缀 / 编码差异即可定位。
 */
import { Surreal } from "surrealdb";

function show(value: unknown): string {
  if (typeof value !== "string") return `<non-string ${typeof value}: ${String(value)}>`;
  // JSON.stringify 暴露换行 / 引号等不可见字符，再附长度
  return `${JSON.stringify(value)} (len=${value.length})`;
}

async function main() {
  const url = process.env.SURREAL_URL;
  const ns = process.env.SURREAL_NS;
  const user = process.env.SURREAL_ROOT_USER;
  const pass = process.env.SURREAL_ROOT_PASS;

  if (!url || !ns || !user || !pass) {
    console.error("缺少 env：SURREAL_URL / SURREAL_NS / SURREAL_ROOT_USER / SURREAL_ROOT_PASS");
    process.exit(1);
  }

  const db = new Surreal();
  await db.connect(url, { reconnect: false });
  await db.signin({ username: user, password: pass });
  await db.use({ namespace: ns, database: "_system" });

  const result = await db.query("SELECT subject, email, note, added_at FROM system_admin;");
  const rows = (Array.isArray(result) ? result[0] : []) as Array<Record<string, unknown>>;

  console.log(`\nsystem_admin 共 ${rows.length} 行：\n`);
  for (const row of rows) {
    console.log("  subject =", show(row.subject));
    console.log("    email =", show(row.email), " note =", show(row.note));
    console.log("");
  }
  console.log("把你浏览器 token 的 sub 按 \"...\"(len=N) 形态贴来对比。\n");

  await db.close();
}

main().catch((err) => {
  console.error("诊断失败：", err);
  process.exit(1);
});
