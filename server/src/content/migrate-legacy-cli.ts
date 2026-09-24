import { Surreal } from "surrealdb";
import { env } from "../env";
import { ensurePlatformContentSchema } from "./schema";
import { migrateLegacyPlatformContent } from "./migrate-legacy";

if (!process.argv.includes("--writes-frozen")) {
  throw new Error("stop all old content writers, then pass --writes-frozen");
}
const root = new Surreal();
const source = new Surreal();
try {
  const authentication = { username: env.SURREAL_ROOT_USER, password: env.SURREAL_ROOT_PASS };
  await root.connect(env.SURREAL_URL, {
    namespace: env.SURREAL_NS, database: env.CONTENT_DATABASE, authentication,
  });
  await ensurePlatformContentSchema(root);
  await source.connect(env.SURREAL_URL, {
    namespace: env.SURREAL_NS, database: "_system", authentication,
  });
  const summary = await migrateLegacyPlatformContent({ source, target: root, writesFrozen: true });
  console.info("[platform-content] migration verified", summary);
} finally {
  await Promise.all([root.close(), source.close()]);
}
