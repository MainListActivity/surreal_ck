import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppBindings } from "../hono-types";
import { requireOidc } from "../middleware/oidc";
import { readInternalIdentity } from "../internal-ai/identity";
import type { Queryable } from "../internal-ai/store";
import { HttpError } from "../http-error";

export function createInternalAiIdentityRoutes(input: { db: () => Promise<Queryable>; requireUser?: MiddlewareHandler<AppBindings> }) {
  return new Hono<AppBindings>().get("/api/internal-ai/identity", input.requireUser ?? requireOidc(), async c => {
    const query = z.object({ workspaceSlug: z.string().regex(/^[a-z0-9-]{1,40}$/) }).strict().safeParse(c.req.query());
    if (!query.success) throw new HttpError(400, "internal-ai-identity-query-invalid", "仅允许查询自身工作区身份");
    c.header("cache-control", "no-store");
    return c.json(await readInternalIdentity(await input.db(), c.var.user.subject, query.data.workspaceSlug));
  });
}
