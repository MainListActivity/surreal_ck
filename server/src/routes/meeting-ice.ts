import { createHmac } from "node:crypto";
import type { MeetingIceServersResponse } from "@surreal-ck/shared";
import { Hono, type MiddlewareHandler } from "hono";
import { env, type ServerEnv } from "../env";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import { introspectOidcAccessToken, type OidcTokenActivityChecker } from "../oidc/introspection";
import type { WorkspaceScopeModule } from "../workspaces/workspace-scope";

type IceConfig = Pick<ServerEnv, "TURN_SHARED_SECRET" | "TURN_URLS" | "STUN_URLS" | "TURN_CREDENTIAL_TTL_SECONDS">;

export function createMeetingIceRoutes({
  workspaceScope,
  requireUser = requireOidc,
  checkTokenActivity = introspectOidcAccessToken,
  config = env,
}: {
  workspaceScope: Pick<WorkspaceScopeModule, "resolveCollaborationScope">;
  requireUser?: () => MiddlewareHandler<AppBindings>;
  checkTokenActivity?: OidcTokenActivityChecker;
  config?: IceConfig;
}) {
  return new Hono<AppBindings>().post("/api/meeting/ice-servers", requireUser(), async (c) => {
    const user = c.var.user;
    const { db, ac, exp } = user.raw;
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= Date.now() / 1000) {
      throw new HttpError(401, "oidc-claim-invalid", "Bearer token claims are invalid");
    }
    if (typeof db !== "string" || !db.trim() || (ac !== "admin" && ac !== "participant")) {
      throw new HttpError(403, "workspace-forbidden", "Workspace is not accessible");
    }

    const membership = await workspaceScope.resolveCollaborationScope({
      subject: user.subject,
      dbName: db,
    });
    if (membership.kind !== "participant" || membership.scope.db !== db) {
      throw new HttpError(403, "workspace-forbidden", "Workspace is not accessible");
    }

    const { TURN_SHARED_SECRET: secret, TURN_URLS: turn, STUN_URLS: stun, TURN_CREDENTIAL_TTL_SECONDS: ttl } = config;
    if (!secret || turn.length === 0) {
      throw new HttpError(503, "meeting-turn-unavailable", "Meeting TURN is not configured");
    }
    if (!(await checkTokenActivity(user.rawToken))) {
      throw new HttpError(401, "oidc-revoked", "Bearer token has been revoked");
    }

    const now = Date.now();
    const nowUnix = Math.floor(now / 1000);
    const expiryUnix = Math.min(Math.floor(exp), nowUnix + ttl);
    if (expiryUnix * 1000 <= now) {
      throw new HttpError(401, "oidc-claim-invalid", "Bearer token claims are invalid");
    }
    const opaqueId = createHmac("sha256", secret)
      .update(JSON.stringify(["meeting-turn", user.subject, db]))
      .digest("hex");
    const username = `${expiryUnix}:${opaqueId}`;
    const credential = createHmac("sha1", secret).update(username).digest("base64");
    const response: MeetingIceServersResponse = {
      iceServers: [...(stun.length > 0 ? [{ urls: stun }] : []), { urls: turn, username, credential }],
      ttlSeconds: expiryUnix - nowUnix,
      expiresAt: new Date(expiryUnix * 1000).toISOString(),
    };

    c.header("Cache-Control", "no-store");
    return c.json(response);
  });
}
