/**
 * SCK-LCA-03 隔离联调启动器：vanilla SurrealDB 3.2.3 (memory) + fixture IdP +
 * 候选 Bun server（native-quota 启动门以 stub 跳过，其余全部走真实启动路径）。
 * 本机一次性环境，无生产连接、无真实数据；随机 root 口令不输出到仓库。
 *
 * 用法：bun .scratch/sck-lca-03-e2e/boot-e2e.ts
 * 产出：fixture IdP :19001，server :18080，surreal ws://127.0.0.1:19000/rpc。
 * 完成后保持进程；Ctrl+C 一并收尾。
 */

import { spawn, type Subprocess } from "bun";
import { homedir } from "node:os";

export const SURREAL_PORT = 19000;
export const IDP_PORT = 19001;
export const SERVER_PORT = 8080;
export const SURREAL_URL = `ws://127.0.0.1:${SURREAL_PORT}/rpc`;
export const ISSUER = `http://127.0.0.1:${IDP_PORT}`;
export const ROOT_USER = "e2e-root";
export const ROOT_PASS = crypto.randomUUID();
export const NS = "main";

const surrealBin = `${homedir()}/.surrealdb/surreal`;

export async function startStack(options: { seed?: boolean } = {}): Promise<{
  surrealProc: Subprocess;
  shutdown: () => Promise<void>;
}> {
  const surrealProc = spawn([surrealBin, "start", "--allow-all", "--bind", `127.0.0.1:${SURREAL_PORT}`, "--user", ROOT_USER, "--pass", ROOT_PASS, "memory"], {
    stdout: "ignore",
    stderr: "ignore",
  });

  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${SURREAL_PORT}/health`)).ok) break;
    } catch { /* starting */ }
    await Bun.sleep(50);
  }

  // fixture IdP 作为同进程子服务拉起（端口隔离、issuer 固定）。
  const idp = spawn([process.execPath, `${import.meta.dir}/fixture-idp.ts`], {
    env: { ...process.env, PORT: String(IDP_PORT), APP_BASE: `http://127.0.0.1:${SERVER_PORT}`, IDP_HOOK_SECRET: "fixture-hook-secret" },
    stdout: "ignore",
    stderr: "inherit",
  });

  Object.assign(process.env, {
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: String(SERVER_PORT),
    SURREAL_URL,
    SURREAL_NS: NS,
    SURREAL_ROOT_USER: ROOT_USER,
    SURREAL_ROOT_PASS: ROOT_PASS,
    CONTENT_DATABASE: "platform_content",
    CONTENT_PUBLISHER_SECRET: "fixture-publisher-secret-at-least-32-chars",
    OIDC_ISSUER: ISSUER,
    OIDC_JWKS_URL: `${ISSUER}/jwks.json`,
    OIDC_AUDIENCE: "fixture-aud",
    OIDC_CLIENT_ID: "fixture-web",
    OIDC_CLIENT_SECRET: "fixture-secret",
    OIDC_TOKEN_ENDPOINT: `${ISSUER}/token`,
    OIDC_TOKEN_AUTH_METHOD: "client_secret_basic",
    IDP_SCOPE_API_URL: `${ISSUER}/scope`,
    IDP_HOOK_SECRET: "fixture-hook-secret",
    SYSTEM_ADMIN_SUBJECTS: "alice",
    PLATFORM_OPERATOR_SUBJECTS: "ops1",
    PLATFORM_OPERATOR_CAPABILITIES: "subscription.manage,quota.read",
    PLATFORM_OPERATOR_DISPLAY_NAME: "fixture ops",
    PLATFORM_OPERATOR_GRANTOR_SUBJECT: "fixture",
    WORKSPACE_TEMPLATE_PACKS: "",
  });

  const { startServer } = await import("../../server/src/startup");
  const fakeCapability = { capabilities: [], format: "native-quota-capability" } as never;
  const running = await startServer({
    // 本机 vanilla SurrealDB 没有 native-quota 扩展面；本票联调不验证额度门，单独 stub。
    probeNativeQuotaHttp: async () => fakeCapability,
    verifyNativeQuotaRootHandshake: async () => undefined,
  });

  console.info(`[e2e] surreal ${SURREAL_URL} | idp ${ISSUER} | server http://127.0.0.1:${SERVER_PORT}`);

  // 种子/联调脚本共用连接信息（随机 root 口令只在 /tmp，0600）。
  const envFile = [
    `SURREAL_URL=${SURREAL_URL}`,
    `NS=${NS}`,
    `ROOT_USER=${ROOT_USER}`,
    `ROOT_PASS=${ROOT_PASS}`,
    `ISSUER=${ISSUER}`,
    `SERVER=http://127.0.0.1:${SERVER_PORT}`,
  ].join("\n");
  await Bun.write("/tmp/sck-lca-03-e2e.env", envFile, { mode: 0o600 });

  return {
    surrealProc,
    async shutdown() {
      await running.shutdown("e2e");
      idp.kill();
      surrealProc.kill();
      await surrealProc.exited;
    },
  };
}

if (import.meta.main) {
  await startStack();
  await new Promise(() => undefined);
}
