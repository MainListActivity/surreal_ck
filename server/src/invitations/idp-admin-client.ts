import { env } from "../env";

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

/** 由环境装配；缺少 IDP_PROVISION_TOKEN 时返回 null，invite 服务据此 fail closed。 */
export function createIdpAdminClientFromEnv(): HttpIdpAdminClient | null {
  if (!env.IDP_PROVISION_TOKEN) return null;
  const baseUrl = env.IDP_ADMIN_BASE_URL ?? new URL(env.OIDC_ISSUER).origin;
  const tenantSlug = env.IDP_ADMIN_TENANT
    ?? env.OIDC_ISSUER.replace(/\/+$/, "").split("/").pop()
    ?? "ck";
  return new HttpIdpAdminClient({
    baseUrl: baseUrl.replace(/\/+$/, ""),
    provisionToken: env.IDP_PROVISION_TOKEN,
    tenantSlug,
  });
}
