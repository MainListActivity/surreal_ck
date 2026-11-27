import { Surreal } from "surrealdb";
import { env } from "../env";
import { legacyContentMigrationCompleted } from "./migrate-legacy";

// origin-pre-start.sh --check：只读判断一次性迁移是否已完成，不建 schema、不写任何记录。
const target = new Surreal();
try {
  await target.connect(env.SURREAL_URL, {
    namespace: env.SURREAL_NS,
    database: env.CONTENT_DATABASE,
    authentication: { username: env.SURREAL_ROOT_USER, password: env.SURREAL_ROOT_PASS },
  });
  console.log(await legacyContentMigrationCompleted(target) ? "pre-start: not-needed" : "pre-start: needed");
} finally {
  await target.close();
}
