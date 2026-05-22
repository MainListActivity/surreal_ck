import { env } from "../env";
import type { SurrealTokenScope } from "./workspace-scope";

export interface IdpTokenScopeAdapter {
  updateUserScope(subject: string, scope: SurrealTokenScope): Promise<void>;
}

export function createIdpTokenScopeAdapter(): IdpTokenScopeAdapter {
  return {
    async updateUserScope(subject, scope) {
      if (!env.IDP_SCOPE_API_URL || !env.IDP_SCOPE_API_TOKEN) {
        throw new Error("IdP scope adapter is not configured");
      }

      const response = await fetch(env.IDP_SCOPE_API_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.IDP_SCOPE_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          subject,
          claims: {
            "https://surrealdb.com/db": scope.db,
            "https://surrealdb.com/ac": scope.ac,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`IdP scope update failed with ${response.status}`);
      }
    },
  };
}
