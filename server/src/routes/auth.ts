import { Hono } from "hono";
import { HttpError } from "../http-error";
import type { AppBindings } from "../hono-types";
import { env } from "../env";

export type OidcTokenAuthMethod = "client_secret_basic" | "client_secret_post";

export type OidcTokenExchangeOptions = {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  tokenAuthMethod?: OidcTokenAuthMethod;
  fetch?: typeof fetch;
};

export function createOidcTokenExchangeFromEnv(): OidcTokenExchangeOptions | undefined {
  if (!env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET || !env.OIDC_TOKEN_ENDPOINT) return undefined;

  return {
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    tokenEndpoint: env.OIDC_TOKEN_ENDPOINT,
    tokenAuthMethod: env.OIDC_TOKEN_AUTH_METHOD,
  };
}

export function createAuthRoutes(options?: OidcTokenExchangeOptions): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();

  routes.post("/api/auth/token", async (c) => {
    if (!options) {
      throw new HttpError(501, "oidc-token-exchange-not-configured", "OIDC token exchange is not configured");
    }

    const params = new URLSearchParams(await c.req.text());
    if (!params.get("code")?.trim()) {
      throw new HttpError(400, "oidc-token-code-required", "Authorization code is required");
    }

    params.delete("client_id");
    params.delete("client_secret");

    const tokenAuthMethod = options.tokenAuthMethod ?? "client_secret_basic";
    const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
    if (tokenAuthMethod === "client_secret_post") {
      params.set("client_id", options.clientId);
      params.set("client_secret", options.clientSecret);
    } else {
      headers.set("authorization", `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`);
    }

    let upstream: Response;
    try {
      upstream = await (options.fetch ?? fetch)(options.tokenEndpoint, {
        method: "POST",
        headers,
        body: params.toString(),
      });
    } catch {
      throw new HttpError(502, "oidc-token-exchange-failed", "OIDC token exchange failed");
    }

    const body = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      throw new HttpError(502, "oidc-token-exchange-failed", "OIDC token exchange failed", {
        upstreamStatus: upstream.status,
      });
    }
    if (body === null) {
      throw new HttpError(502, "oidc-token-exchange-failed", "OIDC token exchange failed");
    }

    if (body && typeof body === "object" && !Array.isArray(body)) {
      const { refresh_token: _refreshToken, ...browserTokenResponse } = body as Record<string, unknown>;
      return c.json(browserTokenResponse, upstream.status as never);
    }

    return c.json(body, upstream.status as never);
  });

  return routes;
}
