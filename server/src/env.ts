import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().max(65535).default(8080),

  SURREAL_URL: z.string().min(1),
  SURREAL_NS: z.string().min(1).default("main"),
  SURREAL_ROOT_USER: z.string().min(1),
  SURREAL_ROOT_PASS: z.string().min(1),
  SURREAL_LOG_QUERIES: z.string().optional(),

  OIDC_ISSUER: z.string().url(),
  OIDC_JWKS_URL: z.string().url(),
  OIDC_AUDIENCE: z.string().min(1),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_TOKEN_ENDPOINT: z.string().url().optional(),
  OIDC_TOKEN_AUTH_METHOD: z.enum(["client_secret_basic", "client_secret_post"]).default("client_secret_basic"),

  IDP_HOOK_SECRET: z.string().min(8),
  IDP_SCOPE_API_URL: z.string().url().optional(),

  // 逗号分隔的 OIDC subject 列表；启动时 upsert 进 _system.system_admin。
  // 当前 MVP 中该表非空即开启创建 workspace 能力，不做逐 subject 授权。
  SYSTEM_ADMIN_SUBJECTS: z.string().optional(),

  RECONCILE_INTERVAL_SEC: z.coerce.number().int().positive().default(3600),

  MASTRA_OBSERVABILITY_RETENTION_DAYS: z.coerce.number().int().positive().max(3650).default(30),

  // AI 模型 provider / model / key（生产装配 AiChatService 用；三个齐备才接线，否则 /api/chat 返回 501）。
  AI_PROVIDER: z.string().min(1).optional(),
  AI_MODEL: z.string().min(1).optional(),
  AI_API_KEY: z.string().min(1).optional(),
  AI_BASE_URL: z.string().url().optional(),
});

export type ServerEnv = z.infer<typeof EnvSchema>;

export function loadEnv(input: NodeJS.ProcessEnv = process.env): ServerEnv {
  const parsed = EnvSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  const details = parsed.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));

  console.error("[env] invalid configuration", details);
  process.exitCode = 1;
  throw new Error("Invalid server environment configuration");
}

export let env = loadEnv();

export function overrideEnv(updates: Partial<ServerEnv>) {
  env = { ...env, ...updates };
}
