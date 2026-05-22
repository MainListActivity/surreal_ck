import { createRemoteJWKSet } from "jose";
import { env } from "../env";

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedUrl: string | null = null;

export function getJwks() {
  if (cachedJwks && cachedUrl === env.OIDC_JWKS_URL) {
    return cachedJwks;
  }
  cachedUrl = env.OIDC_JWKS_URL;
  cachedJwks = createRemoteJWKSet(new URL(env.OIDC_JWKS_URL), {
    cacheMaxAge: 5 * 60 * 1000,
    cooldownDuration: 30 * 1000,
  });
  return cachedJwks;
}
