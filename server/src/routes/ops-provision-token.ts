import { Hono } from "hono";
import { rotateIdpProvisionTokenSchema } from "@surreal-ck/shared";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requirePlatformOperator } from "../ops/operator-auth";
import {
  HttpIdpAdminClient,
  IdpAdminError,
  IDP_PROVISION_TOKEN_SECRET_NAME,
  type ProvisionTokenSource,
} from "../invitations/idp-admin-client";
import { PlatformSecretError, type PlatformSecretStore } from "../platform/secret-store";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const PURPOSE = "IdP admin service-principal provision token（scopes: tenant.read/user.read/user.provision）";

/**
 * IdP provision token 免部署轮换（ops 控制面）：
 * - POST rotate：subscription.manage；候选 token 先经 IdP 只读探测
 *   （GET /admin/tenants + 租户解析）验证为活，再 AES-256-GCM 密封 UPSERT 进
 *   _system.platform_secret:idp_provision_token，并写 platform_secret_event
 *   审计（actor subject + 元数据，不含明文/密文）。下一次邀请调用即生效，
 *   无需改 GitHub secret、无需重部署。token 明文不出现在响应/日志/审计。
 * - GET status：quota.read；报告现行来源（store/env/未配置）、密封行元数据
 *   与 IdP 只读连通性探测结果。
 *
 * 兜底语义：密封行存在 → store 优先；无密封行 → 回退 IDP_PROVISION_TOKEN；
 * 密封行存在但解封失败/被吊销 → 按错误暴露，不静默回退 env。
 */
export function createOpsProvisionTokenRoutes(input: {
  tokenSource: ProvisionTokenSource;
  secretStore: Pick<PlatformSecretStore, "put" | "describe"> | null;
  envTokenConfigured: boolean;
  baseUrl: string;
  tenantSlug: string;
  fetchImpl?: FetchLike;
  requireOperator?: typeof requirePlatformOperator;
}) {
  const requireOperator = input.requireOperator ?? requirePlatformOperator;
  const fetchImpl = input.fetchImpl ?? fetch;
  const probeClient = (token: string) =>
    new HttpIdpAdminClient({ baseUrl: input.baseUrl, provisionToken: token, tenantSlug: input.tenantSlug }, fetchImpl);

  return new Hono<AppBindings>()
    .post("/api/ops/idp-provision-token/rotate", requireOperator("subscription.manage"), async (c) => {
      const parsed = rotateIdpProvisionTokenSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new HttpError(400, "idp-provision-token-invalid-request", "轮换请求无效", parsed.error.flatten());
      }
      if (!input.secretStore) {
        throw new HttpError(503, "idp-provision-store-not-configured", "PLATFORM_SECRET_KEY 未配置，密封仓不可用");
      }
      const operator = c.var.platformOperator;
      const actor = operator?.subject ?? "unknown";
      try {
        await probeClient(parsed.data.token).probe();
      } catch (error) {
        if (error instanceof IdpAdminError) {
          throw new HttpError(400, "idp-provision-token-invalid", `IdP 拒绝该 token（${error.code}${error.status ? `，HTTP ${error.status}` : ""}）`);
        }
        throw new HttpError(502, "idp-provision-probe-failed", "无法连通 IdP 验证候选 token");
      }
      let meta;
      try {
        meta = await input.secretStore.put(IDP_PROVISION_TOKEN_SECRET_NAME, parsed.data.token, {
          actor,
          purpose: PURPOSE,
          action: "rotate",
          source: "ops_api",
          detail: { verifiedAgainst: "GET /admin/tenants" },
        });
      } catch (error) {
        if (error instanceof PlatformSecretError) {
          throw new HttpError(500, error.code, error.message);
        }
        throw error;
      }
      return c.json({
        rotated: true,
        secretName: IDP_PROVISION_TOKEN_SECRET_NAME,
        source: "store",
        updatedAt: meta.updatedAt,
        updatedBy: meta.updatedBy,
      });
    })
    .get("/api/ops/idp-provision-token/status", requireOperator("quota.read"), async (c) => {
      const entry = input.secretStore ? await input.secretStore.describe(IDP_PROVISION_TOKEN_SECRET_NAME) : null;
      let resolved: Awaited<ReturnType<ProvisionTokenSource>> = null;
      let unsealError: string | null = null;
      try {
        resolved = await input.tokenSource();
      } catch (error) {
        if (!(error instanceof PlatformSecretError)) throw error;
        unsealError = error.code;
      }
      const idp: { reachable: boolean; status: number | null; error: string | null } = {
        reachable: false,
        status: null,
        error: null,
      };
      if (resolved) {
        try {
          await probeClient(resolved.token).probe();
          idp.reachable = true;
        } catch (error) {
          if (error instanceof IdpAdminError) {
            idp.status = error.status ?? null;
            idp.error = error.code;
          } else {
            idp.error = "probe-failed";
          }
        }
      }
      return c.json({
        configured: resolved !== null,
        source: resolved?.source ?? null,
        env: { configured: input.envTokenConfigured },
        store: {
          sealKeyConfigured: input.secretStore !== null,
          entry: entry
            ? { updatedAt: entry.updatedAt, updatedBy: entry.updatedBy, purpose: entry.purpose }
            : null,
          unsealError,
        },
        idp,
      });
    });
}
