import { env } from "../env";
import type { PlatformSecretStore } from "../platform/secret-store";

export type IdpAdminClientConfig = Readonly<{
  baseUrl: string;
  /** Opaque revocable service principal bearer (ma_hono admin_service_principals). */
  provisionToken: string;
  tenantSlug: string;
}>;

export type IdpUser = Readonly<{
  id: string;
  email: string;
  displayName: string;
  status: string;
}>;

export type EnsureUserResult = Readonly<{
  user: IdpUser;
  /** true = 本次新建（activationUrl 仅此时返回）；false = 幂等复用既有用户。 */
  created: boolean;
  /** 一次性激活链接：仅新建用户返回；复用既有用户恒为 null（不重复签发）。 */
  activationUrl: string | null;
}>;

export class IdpAdminError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "IdpAdminError";
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const normalizeEmail = (email: string) => email.trim().toLowerCase();

function asUser(value: unknown): IdpUser | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.email !== "string") return null;
  return {
    id: row.id,
    email: row.email,
    displayName: typeof row.display_name === "string" ? row.display_name : "",
    status: typeof row.status === "string" ? row.status : "unknown",
  };
}

/**
 * ma_hono admin API 客户端：使用可吊销 service principal bearer
 *（scopes: tenant.read / user.read / user.provision），不调用 /admin/login，
 * 不缓存人类 admin session，不读取人类 admin 密码。
 *
 * 仅调用：GET /admin/tenants、GET .../users、POST .../users。
 * admin API 无邀请邮件通道：激活交接物恒为一次性 activation_url，由运营转交。
 */
export class HttpIdpAdminClient {
  private tenantId: string | null = null;

  constructor(
    private readonly config: IdpAdminClientConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async admin(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${this.config.provisionToken}`);
    if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return this.fetchImpl(`${this.config.baseUrl}${path}`, { ...init, headers });
  }

  private async resolveTenantId(): Promise<string> {
    if (this.tenantId) return this.tenantId;
    const res = await this.admin("/admin/tenants");
    const body = await res.json().catch(() => null) as
      | { tenants?: Array<{ id?: unknown; slug?: unknown }> }
      | null;
    if (!res.ok || !Array.isArray(body?.tenants)) {
      throw new IdpAdminError("idp-admin-tenant-list-failed", `IdP 租户列表不可用（${res.status}）`, res.status);
    }
    const tenant = body.tenants.find((t) => t.slug === this.config.tenantSlug);
    if (!tenant || typeof tenant.id !== "string") {
      throw new IdpAdminError("idp-admin-tenant-missing", `IdP 租户 ${this.config.tenantSlug} 不存在`);
    }
    this.tenantId = tenant.id;
    return tenant.id;
  }

  /** 只读连通性探测：GET /admin/tenants + 租户解析，验证 token 与 tenant.read 可用。 */
  async probe(): Promise<string> {
    return this.resolveTenantId();
  }

  async findUserByEmail(email: string): Promise<IdpUser | null> {
    const tenantId = await this.resolveTenantId();
    const res = await this.admin(`/admin/tenants/${tenantId}/users`);
    const body = await res.json().catch(() => null) as { users?: unknown[] } | null;
    if (!res.ok || !Array.isArray(body?.users)) {
      throw new IdpAdminError("idp-admin-user-list-failed", `IdP 用户列表不可用（${res.status}）`, res.status);
    }
    const wanted = normalizeEmail(email);
    for (const raw of body.users) {
      const user = asUser(raw);
      if (user && normalizeEmail(user.email) === wanted) return user;
    }
    return null;
  }

  async ensureUser(input: { email: string; displayName: string }): Promise<EnsureUserResult> {
    const tenantId = await this.resolveTenantId();
    const res = await this.admin(`/admin/tenants/${tenantId}/users`, {
      method: "POST",
      body: JSON.stringify({
        email: input.email.trim(),
        display_name: input.displayName.trim(),
      }),
    });
    const body = await res.json().catch(() => null) as
      | { user?: unknown; activation_url?: unknown; error?: unknown }
      | null;
    if (res.status === 409) {
      const existing = await this.findUserByEmail(input.email);
      if (!existing) {
        throw new IdpAdminError("idp-admin-user-conflict-unresolved", "IdP 报邮箱冲突但按邮箱查无此人");
      }
      return { user: existing, created: false, activationUrl: null };
    }
    if (!res.ok) {
      throw new IdpAdminError(
        "idp-admin-provision-failed",
        `IdP 建用户失败（${res.status}${body && typeof body.error === "string" ? `: ${body.error}` : ""}）`,
        res.status,
      );
    }
    const user = asUser(body?.user);
    if (!user) throw new IdpAdminError("idp-admin-user-malformed", "IdP 返回的用户对象不完整");
    return {
      user,
      created: true,
      activationUrl: typeof body?.activation_url === "string" ? body.activation_url : null,
    };
  }
}

export const IDP_PROVISION_TOKEN_SECRET_NAME = "idp_provision_token";

export type ResolvedProvisionToken = Readonly<{
  token: string;
  /** store = 密封密钥仓（轮换后的现行值）；env = IDP_PROVISION_TOKEN 兜底/初始装配。 */
  source: "store" | "env";
}>;

/**
 * 每次调用解析一次有效 provision token：
 * 1. _system.platform_secret:idp_provision_token 存在 → 解封即现行值（轮换结果）。
 * 2. 无密封行 → 回退环境变量 IDP_PROVISION_TOKEN（bootstrap / 应急兜底）。
 * 3. 两者皆无 → null（调用方 fail closed）。
 *
 * 密封行存在但解封失败（密钥错配/密文损坏）时向上抛错，不静默回退 env，
 * 避免已被轮换顶替的旧值复活。密封行中已被 IdP 吊销的 token 同样不回退：
 * IdP 返回 403 即由正常错误路径暴露，运营须再次轮换。
 */
export type ProvisionTokenSource = () => Promise<ResolvedProvisionToken | null>;

export function createProvisionTokenSource(input: {
  secretStore: Pick<PlatformSecretStore, "get"> | null;
  envToken?: string;
}): ProvisionTokenSource {
  return async () => {
    if (input.secretStore) {
      const stored = await input.secretStore.get(IDP_PROVISION_TOKEN_SECRET_NAME);
      if (stored) return { token: stored.value, source: "store" };
    }
    if (input.envToken) return { token: input.envToken, source: "env" };
    return null;
  };
}

/** 懒装配的 IdP admin 客户端来源：每次调用按现行 token 新建，轮换即刻生效。 */
export type IdpAdminClientSource = () => Promise<HttpIdpAdminClient | null>;

export function createIdpAdminClientSource(input: {
  tokenSource: ProvisionTokenSource;
  baseUrl?: string;
  tenantSlug?: string;
  fetchImpl?: FetchLike;
}): IdpAdminClientSource {
  return async () => {
    const resolved = await input.tokenSource();
    if (!resolved) return null;
    const baseUrl = input.baseUrl ?? env.IDP_ADMIN_BASE_URL ?? new URL(env.OIDC_ISSUER).origin;
    const tenantSlug = input.tenantSlug ?? env.IDP_ADMIN_TENANT
      ?? env.OIDC_ISSUER.replace(/\/+$/, "").split("/").pop()
      ?? "ck";
    return new HttpIdpAdminClient({
      baseUrl: baseUrl.replace(/\/+$/, ""),
      provisionToken: resolved.token,
      tenantSlug,
    }, input.fetchImpl);
  };
}

/** 由环境装配 token 源 + 客户端来源；token 缺失时解析为 null，invite 服务据此 fail closed。 */
export function createIdpAdminClientFromEnv(input: {
  secretStore?: Pick<PlatformSecretStore, "get"> | null;
} = {}): IdpAdminClientSource {
  return createIdpAdminClientSource({
    tokenSource: createProvisionTokenSource({
      secretStore: input.secretStore ?? null,
      envToken: env.IDP_PROVISION_TOKEN,
    }),
  });
}
