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
  CONTENT_DATABASE: z.string().regex(/^[a-z][a-z0-9_]*$/u).default("platform_content"),
  CONTENT_PUBLISHER_SECRET: z.string().min(32).optional(),

  OIDC_ISSUER: z.string().url(),
  OIDC_JWKS_URL: z.string().url(),
  OIDC_AUDIENCE: z.string().min(1),
  // 独立运营端 / 内容 MCP 的 audience；生产环境由 IdP 单独注册资源标识。
  OIDC_OPS_AUDIENCE: z.string().min(1).optional(),
  /** 运营 SPA 的 public client；后端只代理该 client 的 PKCE token exchange。 */
  OIDC_OPS_CLIENT_ID: z.string().min(1).optional(),
  // 运营端登出撤销 access/refresh token 的 RFC 7009 端点；缺省按 issuer 推导 /revoke。
  OIDC_REVOKE_ENDPOINT: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_TOKEN_ENDPOINT: z.string().url().optional(),
  // 运营端的 OAuth access token 在每次 MCP 调用时通过此端点确认未被撤销；
  // 缺省时按 issuer 的 RFC 7662 相对端点推导。
  OIDC_INTROSPECTION_ENDPOINT: z.string().url().optional(),
  OIDC_TOKEN_AUTH_METHOD: z.enum(["client_secret_basic", "client_secret_post"]).default("client_secret_basic"),

  IDP_HOOK_SECRET: z.string().min(8),
  IDP_SCOPE_API_URL: z.string().url().optional(),

  // G2 运营代办开通：server → IdP 可吊销 service principal（scopes:
  // tenant.read / user.read / user.provision）。生产由
  // ORIGIN_ENV_IDP_PROVISION_TOKEN → server.env 的 IDP_PROVISION_TOKEN，
  // 仅作初始装配/应急兜底；_system.platform_secret 密封行存在时一律优先
  //（免部署轮换的现行值）。两者皆无 /api/ops/invitations 返回
  // invite-idp-not-configured（fail closed）。
  // 禁止配置人类 admin 密码（IDP_ADMIN_EMAIL / IDP_ADMIN_PASSWORD）。
  IDP_ADMIN_BASE_URL: z.string().url().optional(),
  IDP_PROVISION_TOKEN: z.string().min(1).optional(),
  IDP_ADMIN_TENANT: z.string().min(1).optional(),
  // 平台密封密钥仓的 AES-256-GCM 主密钥（64 hex / 32 bytes）：解封 _system
  // .platform_secret 中的运行时密文（如轮换后的 provision token）。只存在
  // 于 server 进程环境（ORIGIN_ENV_PLATFORM_SECRET_KEY → server.env），
  // 缺省时密封仓不可用：token 源回退 IDP_PROVISION_TOKEN，轮换端点返回 503。
  PLATFORM_SECRET_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),

  // 逗号分隔的 OIDC subject 列表；启动时 upsert 进 _system.system_admin。
  // 当前 MVP 中该表非空即开启创建 workspace 能力，不做逐 subject 授权。
  SYSTEM_ADMIN_SUBJECTS: z.string().optional(),

  // 首次部署可选的运营主体 bootstrap；必须同时配置能力，且只补缺失记录，不会
  // 自动重新启用已禁用的主体或已撤销的能力。能力名以逗号分隔。
  PLATFORM_OPERATOR_SUBJECTS: z.string().optional(),
  PLATFORM_OPERATOR_CAPABILITIES: z.string().optional(),
  PLATFORM_OPERATOR_DISPLAY_NAME: z.string().min(1).optional(),
  PLATFORM_OPERATOR_GRANTOR_SUBJECT: z.string().min(1).optional(),

  // 逗号分隔的可选模板包；空配置保持通用工作区，不播种垂直模板。
  WORKSPACE_TEMPLATE_PACKS: z
    .string()
    .optional()
    .transform((value) => [...new Set((value ?? "").split(",").map((name) => name.trim()).filter(Boolean))]),

  RECONCILE_INTERVAL_SEC: z.coerce.number().int().positive().default(3600),

  // 虚拟员工 runtime（VER06）：会话续约点必须低于 employee access 的 session
  // DURATION（1h）；关停 deadline 之外另给 abort 宽限；启动 reconcile 有界并发。
  EMPLOYEE_SESSION_RENEW_AFTER_SEC: z.coerce.number().int().positive().default(2700),
  EMPLOYEE_RUNTIME_SHUTDOWN_DEADLINE_MS: z.coerce.number().int().positive().default(30000),
  EMPLOYEE_SHUTDOWN_ABORT_GRACE_MS: z.coerce.number().int().positive().default(5000),
  EMPLOYEE_STARTUP_RECONCILE_CONCURRENCY: z.coerce.number().int().positive().default(4),

  MASTRA_OBSERVABILITY_RETENTION_DAYS: z.coerce.number().int().positive().max(3650).default(30),

  // AI 模型 provider / model / key（生产装配 AiChatService 用；三个齐备才接线，否则 /api/chat 返回 501）。
  AI_PROVIDER: z.string().min(1).optional(),
  AI_MODEL: z.string().min(1).optional(),
  AI_API_KEY: z.string().min(1).optional(),
  AI_DELIVERY_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  INTERNAL_AI_COMPANY_STATUS_URL: z.preprocess(value => value === "" ? undefined : value, z.string().url().optional()),
  AI_BASE_URL: z.string().url().optional(),

  // 资源保存确认动作的 embedding provider key（与 chat 模型设置分离；openai-compatible）。
  // 未配置时：无 profile 的 workspace 照常保存（embedding disabled），有 profile 的保存会失败。
  EMBEDDING_API_KEY: z.string().min(1).optional(),

  // TypeSafe 决策模型（System One / Jev）：意图分类的单意图捷径。key 缺省即纯 LLM 分类。
  // 空串与哨兵值 UNSET 一律按未配置处理：发布端以 UNSET 删除主机上的键，
  // 进程侧即使读到 KEY=UNSET 也不启用 Jev（兜底，防旧发布脚本写残值）。
  TYPESAFE_API_KEY: z.preprocess(
    (value) => (value === "" || value === "UNSET" ? undefined : value),
    z.string().min(1).optional(),
  ),
  JEV_MODEL: z.string().min(1).default("jev-latest"),
  JEV_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
  JEV_TIMEOUT_MS: z.coerce.number().int().positive().default(1500),

  // 债权人令牌入口：pepper 用于 token 哈希与门户会话 HMAC；缺省时 mint/open 返回 501。
  CLAIMS_PORTAL_TOKEN_PEPPER: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(32).optional(),
  ),
  // 债权申报附件 R2（S3 兼容）。五个键必须齐备才算配置；缺任一则上传/下载 501。
  CLAIMS_ATTACHMENT_ACCOUNT_ID: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  CLAIMS_ATTACHMENT_ACCESS_KEY_ID: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  CLAIMS_ATTACHMENT_SECRET_ACCESS_KEY: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  CLAIMS_ATTACHMENT_BUCKET: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  CLAIMS_ATTACHMENT_ENDPOINT: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
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
