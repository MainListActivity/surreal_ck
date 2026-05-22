import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().max(65535).default(8080),

  SURREAL_URL: z.string().min(1),
  SURREAL_NS: z.string().min(1).default("main"),
  SURREAL_ROOT_USER: z.string().min(1),
  SURREAL_ROOT_PASS: z.string().min(1),

  OIDC_ISSUER: z.string().url(),
  OIDC_JWKS_URL: z.string().url(),
  OIDC_AUDIENCE: z.string().min(1),

  IDP_HOOK_SECRET: z.string().min(8),
  IDP_SCOPE_API_URL: z.string().url().optional(),
  IDP_SCOPE_API_TOKEN: z.string().optional(),
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
