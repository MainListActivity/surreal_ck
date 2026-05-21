import { createRemoteJWKSet } from "jose";
import { env } from "../env";

export const jwks = createRemoteJWKSet(new URL(env.OIDC_JWKS_URL), {
  cacheMaxAge: 5 * 60 * 1000,
  cooldownDuration: 30 * 1000,
});
