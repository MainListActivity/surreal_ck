import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import type { WorkspaceCreator } from "../workspaces/create-workspace";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function createWorkspaceRoutes(
  workspaceCreator: WorkspaceCreator,
  requireUser: () => MiddlewareHandler<AppBindings> = requireOidc,
): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();

  routes.post("/api/workspaces", requireUser(), async (c) => {
    const body = await c.req.json().catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const slug = typeof body?.slug === "string" ? body.slug.trim().toLowerCase() : "";

    if (!name) {
      throw new HttpError(400, "workspace-name-required", "name is required");
    }
    if (!SLUG_PATTERN.test(slug)) {
      throw new HttpError(400, "workspace-slug-invalid", "slug must be 1-40 lowercase alphanumeric or hyphen characters");
    }

    const result = await workspaceCreator.createWorkspace({
      subject: c.var.user.subject,
      email: c.var.user.email ?? "",
      name,
      slug,
    });

    if (result.kind === "slug-conflict") {
      throw new HttpError(409, "workspace-slug-conflict", "Workspace slug already exists");
    }

    if (result.kind === "scope-update-failed") {
      throw new HttpError(502, "scope-update-failed", "Workspace created but token scope update failed; retry switch-workspace", {
        slug: result.slug,
        dbName: result.dbName,
      });
    }

    return c.json({
      slug: result.slug,
      dbName: result.dbName,
      refreshRequired: result.refreshRequired,
    });
  });

  return routes;
}
