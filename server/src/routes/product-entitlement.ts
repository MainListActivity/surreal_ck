import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import {
  assignProductEntitlementSchema,
  grantContentCollectionSchema,
  publishProductRevisionSchema,
  repairContentDeliverySchema,
  revokeContentGrantSchema,
} from "@surreal-ck/shared";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { inspectProductRevisionRaw } from "../product-entitlement/inspect";
import { requireOidc } from "../middleware/oidc";
import { requirePlatformOperator } from "../ops/operator-auth";
import { ProductEntitlementError, ProductEntitlementService, type ProductActor } from "../product-entitlement/service";

function fail(error: unknown): never {
  if (!(error instanceof ProductEntitlementError)) throw error;
  const status = error.code === "not_found" ? 404
    : error.code === "conflict" || error.code === "no_subscription" ? 409
    : error.code === "invalid_request" ? 400
    : 403;
  throw new HttpError(status, `product-entitlement-${error.code}`, error.message);
}

function operator(c: { var: AppBindings["Variables"] }): ProductActor {
  const current = c.var.platformOperator;
  if (!current) throw new HttpError(403, "platform-operator-required", "需要平台运营身份");
  return { subject: current.subject, capabilities: current.capabilities };
}

export function createProductEntitlementRoutes(input: {
  service: ProductEntitlementService;
  /** 运营只读诊断（LCA05）：读产品修订原始模板行与表结构；默认走真实实现。 */
  inspectRevision?: (id: string) => Promise<unknown>;
  requireCustomer?: () => MiddlewareHandler<AppBindings>;
  /** 测试注入点：默认 requirePlatformOperator（每请求重查能力与 token 活跃性）。 */
  requireOperator?: typeof requirePlatformOperator;
}) {
  const requireCustomer = input.requireCustomer ?? requireOidc;
  const requireOperator = input.requireOperator ?? requirePlatformOperator;
  const inspectRevision = input.inspectRevision ?? inspectProductRevisionRaw;
  return new Hono<AppBindings>()
    .get("/api/workspaces/:slug/product-entitlement", requireCustomer(), async (c) => {
      try {
        return c.json(await input.service.getForCustomer(c.var.user.subject, c.req.param("slug")));
      } catch (error) {
        return fail(error);
      }
    })
    .get("/api/ops/product-entitlements/revisions/:id/inspect", requireOperator("subscription.manage"), async (c) => {
      try {
        return c.json(await inspectRevision(c.req.param("id")));
      } catch (error) {
        return fail(error);
      }
    })
    .get("/api/ops/product-entitlements/workspaces/:slug", requireOperator("quota.read"), async (c) => {
      try {
        return c.json(await input.service.getForOperator(operator(c), c.req.param("slug")));
      } catch (error) {
        return fail(error);
      }
    })
    .post("/api/ops/product-entitlements/revisions", requireOperator("subscription.manage"), async (c) => {
      const parsed = publishProductRevisionSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new HttpError(400, "product-entitlement-invalid_request", "产品版本无效");
      try {
        return c.json(await input.service.publishRevision(operator(c), parsed.data), 201);
      } catch (error) {
        return fail(error);
      }
    })
    .post("/api/ops/product-entitlements/assignments", requireOperator("subscription.manage"), async (c) => {
      const parsed = assignProductEntitlementSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new HttpError(400, "product-entitlement-invalid_request", "产品分配无效");
      try {
        return c.json(await input.service.assign(operator(c), parsed.data));
      } catch (error) {
        return fail(error);
      }
    })
    .post("/api/ops/product-entitlements/grants", requireOperator("entitlement.gift"), async (c) => {
      const parsed = grantContentCollectionSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new HttpError(400, "product-entitlement-invalid_request", "内容增量授权无效");
      try {
        return c.json(await input.service.grant(operator(c), parsed.data));
      } catch (error) {
        return fail(error);
      }
    })
    // LCA13：内容赠送与交付修复独立持能；查看=quota.read，订阅调整=subscription.manage。
    .post("/api/ops/product-entitlements/grants/revoke", requireOperator("entitlement.gift"), async (c) => {
      const parsed = revokeContentGrantSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new HttpError(400, "product-entitlement-invalid_request", "撤销请求无效");
      try {
        return c.json(await input.service.revokeGrant(operator(c), parsed.data));
      } catch (error) {
        return fail(error);
      }
    })
    .get("/api/ops/product-entitlements/workspaces/:slug/delivery-preview", requireOperator("entitlement.repair"), async (c) => {
      try {
        return c.json(await input.service.describeDeliveryRepair(operator(c), c.req.param("slug")));
      } catch (error) {
        return fail(error);
      }
    })
    .post("/api/ops/product-entitlements/workspaces/:slug/delivery-repair", requireOperator("entitlement.repair"), async (c) => {
      const parsed = repairContentDeliverySchema.safeParse({ ...(await c.req.json().catch(() => null)), workspaceSlug: c.req.param("slug") });
      if (!parsed.success) throw new HttpError(400, "product-entitlement-invalid_request", "交付修复请求无效");
      try {
        return c.json(await input.service.repairDelivery(operator(c), parsed.data));
      } catch (error) {
        return fail(error);
      }
    })
    .get("/api/ops/product-entitlements/exceptions", requireOperator("quota.read"), async (c) => {
      try {
        return c.json(await input.service.exceptions(operator(c), {
          limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
          offset: c.req.query("offset") ? Number(c.req.query("offset")) : undefined,
        }));
      } catch (error) {
        return fail(error);
      }
    });
}
