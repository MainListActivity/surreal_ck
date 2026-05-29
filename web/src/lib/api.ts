import { hc } from "hono/client";
import type { AppType } from "@surreal-ck/server/app-type";
import { getToken as defaultGetToken } from "./auth";

/**
 * OIDC token 过期 / 被 SurrealDB access 拒绝时由 api client 抛出，
 * 上层路由据此触发 silent refresh 或重新登录。
 */
export class OidcExpiredError extends Error {
  readonly status: number;
  constructor(status = 401, message = "OIDC session expired") {
    super(message);
    this.name = "OidcExpiredError";
    this.status = status;
  }
}

export type ApiClientOptions = {
  baseUrl?: string;
  /** 返回当前 access token；为空表示未登录，请求不带 Authorization。 */
  getToken?: () => string | null;
  /** 注入 fetch 便于单测；默认浏览器 fetch。 */
  fetch?: typeof fetch;
};

/** 不带 Authorization 的公开 endpoint 前缀白名单（health 等）。 */
const PUBLIC_PATH_PREFIXES = ["/health"];

function isPublicPath(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export type ApiClient = {
  /** hono/client 实例，端到端类型来自 server 的 AppType。 */
  api: ReturnType<typeof hc<AppType>>;
};

function viteBaseUrl(): string {
  const env = (import.meta as ImportMeta & { env?: { VITE_API_BASE_URL?: string } }).env;
  return env?.VITE_API_BASE_URL ?? "";
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? viteBaseUrl();
  const getToken = options.getToken ?? defaultGetToken;
  const baseFetch = options.fetch ?? globalThis.fetch;

  const authedFetch: typeof fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init.headers);

    if (!isPublicPath(url)) {
      const token = getToken();
      if (token) headers.set("Authorization", `Bearer ${token}`);
    }

    const res = await baseFetch(input, { ...init, headers });
    if (res.status === 401) {
      throw new OidcExpiredError(401);
    }
    return res;
  };

  const api = hc<AppType>(baseUrl, { fetch: authedFetch });

  return { api };
}

const defaultClient = createApiClient();

export const api = defaultClient.api;
