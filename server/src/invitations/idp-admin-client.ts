import { env } from "../env";

export type IdpAdminClientConfig = Readonly<{
  baseUrl: string;
  email: string;
  password: string;
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
 * ma_hono admin API 客户端：admin session（白名单邮箱 + bootstrap 密码，12h）→
 * POST /admin/tenants/{id}/users 建用户（409 = 邮箱已存在 → 经列表幂等复用）。
 * admin API 无邀请邮件通道：激活交接物恒为一次性 activation_url，由运营转交。
 */
export class HttpIdpAdminClient {
  private sessionToken: string | null = null;
  private sessionExpiresAt = 0;
  private tenantId: string | null = null;

  constructor(
    private readonly config: IdpAdminClientConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly sessionTtlMs = 11 * 60 * 60 * 1000,
  ) {}

  private async login(): Promise<string> {
    if (this.sessionToken && Date.now() < this.sessionExpiresAt) return this.sessionToken;
    const res = await this.fetchImpl(`${this.config.baseUrl}/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: this.config.email, password: this.config.password }),
    });
    const body = await res.json().catch(() => null) as { session_token?: unknown; error?: unknown } | null;
    if (!res.ok || typeof body?.session_token !== "string") {
      throw new IdpAdminError(
        "idp-admin-login-failed",
        `IdP admin 登录失败（${res.status}）`,
        res.status,
      );
    }
    this.sessionToken = body.session_token;
    this.sessionExpiresAt = Date.now() + this.sessionTtlMs;
    return this.sessionToken;
  }

  private async admin(path: string, init?: RequestInit, retryOn401 = true): Promise<Response> {
    const token = await this.login();
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const res = await this.fetchImpl(`${this.config.baseUrl}${path}`, { ...init, headers });
    if (res.status === 401 && retryOn401) {
      this.sessionToken = null;
      this.sessionExpiresAt = 0;
      return this.admin(path, init, false);
    }
    return res;
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

/** 由环境装配；凭证不全返回 null，invite 服务据此 fail closed。 */
export function createIdpAdminClientFromEnv(): HttpIdpAdminClient | null {
  if (!env.IDP_ADMIN_EMAIL || !env.IDP_ADMIN_PASSWORD) return null;
  const baseUrl = env.IDP_ADMIN_BASE_URL ?? new URL(env.OIDC_ISSUER).origin;
  const tenantSlug = env.IDP_ADMIN_TENANT
    ?? env.OIDC_ISSUER.replace(/\/+$/, "").split("/").pop()
    ?? "ck";
  return new HttpIdpAdminClient({
    baseUrl: baseUrl.replace(/\/+$/, ""),
    email: env.IDP_ADMIN_EMAIL,
    password: env.IDP_ADMIN_PASSWORD,
    tenantSlug,
  });
}
