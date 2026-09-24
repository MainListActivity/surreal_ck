import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import {
  assignProductEntitlementSchema,
  grantContentCollectionSchema,
  publishProductRevisionSchema,
} from "@surreal-ck/shared";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
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
  requireCustomer?: () => MiddlewareHandler<AppBindings>;
}) {
  const requireCustomer = input.requireCustomer ?? requireOidc;
  return new Hono<AppBindings>()
    .get("/api/workspaces/:slug/product-entitlement", requireCustomer(), async (c) => {
      try {
        return c.json(await input.service.getForCustomer(c.var.user.subject, c.req.param("slug")));
      } catch (error) {
        return fail(error);
      }
    })
    .get("/api/ops/product-entitlements/workspaces/:slug", requirePlatformOperator("quota.read"), async (c) => {
      try {
        return c.json(await input.service.getForOperator(operator(c), c.req.param("slug")));
      } catch (error) {
        return fail(error);
      }
    })
    .post("/api/ops/product-entitlements/revisions", requirePlatformOperator("subscription.manage"), async (c) => {
      const parsed = publishProductRevisionSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new HttpError(400, "product-entitlement-invalid_request", "产品版本无效");
      try {
        return c.json(await input.service.publishRevision(operator(c), parsed.data), 201);
      } catch (error) {
        return fail(error);
      }
    })
    .post("/api/ops/product-entitlements/assignments", requirePlatformOperator("subscription.manage"), async (c) => {
      const parsed = assignProductEntitlementSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new HttpError(400, "product-entitlement-invalid_request", "产品分配无效");
      try {
        return c.json(await input.service.assign(operator(c), parsed.data));
      } catch (error) {
        return fail(error);
      }
    })
    .post("/api/ops/product-entitlements/grants", requirePlatformOperator("subscription.manage"), async (c) => {
      const parsed = grantContentCollectionSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new HttpError(400, "product-entitlement-invalid_request", "内容增量授权无效");
      try {
        return c.json(await input.service.grant(operator(c), parsed.data));
      } catch (error) {
        return fail(error);
      }
    });
}
