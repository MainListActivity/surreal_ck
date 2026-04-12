/**
 * DDL proxy client.
 *
 * Record users cannot execute DEFINE statements directly. This module proxies
 * DDL requests to the backend service which holds root-level credentials and
 * executes pre-approved SQL templates by ID.
 *
 * The proxy endpoint:
 *   POST https://auth.maplayer.top/api/db/execTemplate
 *   Authorization: Bearer <access_token>
 *   Content-Type: application/json
 *   { "id": "<template-id>", "params": { ... } }
 *
 * Template IDs correspond 1-to-1 with files under schema/templates/*.sql.
 */

const DDL_PROXY_URL = 'https://auth.maplayer.top/api/db/execTemplate';

export class DdlProxyError extends Error {
  constructor(
    public readonly templateId: string,
    public readonly status: number,
    message: string,
  ) {
    super(`DDL proxy error [${templateId}] HTTP ${status}: ${message}`);
    this.name = 'DdlProxyError';
  }
}

/**
 * Execute a DDL template via the proxy service.
 *
 * @param accessToken  Valid OIDC access token (Bearer).
 * @param templateId   Template file name without extension, e.g. "ddl-entity-table".
 * @param params       Key-value pairs injected as SurrealQL variables.
 */
export async function execDdlTemplate(
  accessToken: string,
  templateId: string,
  params: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(DDL_PROXY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ id: templateId, params }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new DdlProxyError(templateId, res.status, body);
  }
}
