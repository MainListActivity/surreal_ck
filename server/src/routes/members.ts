import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import type { MemberManager } from "../workspaces/member-manager";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function workspaceErrorToHttp(kind: "forbidden" | "workspace-not-found" | "member-not-found"): HttpError {
  switch (kind) {
    case "forbidden":
      return new HttpError(403, "member-admin-forbidden", "Only a workspace admin can manage members");
    case "workspace-not-found":
      return new HttpError(404, "workspace-not-found", "Workspace does not exist or is not active");
    case "member-not-found":
      return new HttpError(404, "member-not-found", "Member does not exist in this workspace");
  }
}

export function createMemberRoutes(
  memberManager: MemberManager,
  requireUser: () => MiddlewareHandler<AppBindings> = requireOidc,
): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();

  routes.post("/api/workspaces/:slug/members", requireUser(), async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.json().catch(() => null);
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : undefined;
    const isAdmin = body?.isAdmin === true;

    if (!EMAIL_PATTERN.test(email)) {
      throw new HttpError(400, "member-email-invalid", "A valid email is required");
    }

    const result = await memberManager.addMember({
      callerSubject: c.var.user.subject,
      slug,
      email,
      ...(displayName ? { displayName } : {}),
      isAdmin,
    });

    if (result.kind !== "added") {
      throw workspaceErrorToHttp(result.kind);
    }

    return c.json({ ok: true });
  });

  routes.patch("/api/workspaces/:slug/members/:userId", requireUser(), async (c) => {
    const slug = c.req.param("slug");
    const userId = c.req.param("userId");
    const body = await c.req.json().catch(() => null);

    if (typeof body?.isAdmin !== "boolean") {
      throw new HttpError(400, "member-role-invalid", "isAdmin must be a boolean");
    }

    const result = await memberManager.updateMemberRole({
      callerSubject: c.var.user.subject,
      slug,
      userId,
      isAdmin: body.isAdmin,
    });

    if (result.kind !== "updated") {
      throw workspaceErrorToHttp(result.kind);
    }

    return c.json({ ok: true });
  });

  routes.delete("/api/workspaces/:slug/members/:userId", requireUser(), async (c) => {
    const slug = c.req.param("slug");
    const userId = c.req.param("userId");

    const result = await memberManager.removeMember({
      callerSubject: c.var.user.subject,
      slug,
      userId,
    });

    if (result.kind !== "removed") {
      throw workspaceErrorToHttp(result.kind);
    }

    return c.json({ ok: true });
  });

  return routes;
}
