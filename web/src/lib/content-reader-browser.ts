import { Surreal } from "surrealdb";
import type { ContentReaderExchangeSuccess, ContentReaderFailure } from "@surreal-ck/shared";
import { getToken } from "./auth";
import { createContentReader, isExchangeSuccess, isFailure, type ContentConnection } from "./content-reader";
import { getCurrentWorkspace } from "./workspace-store.svelte";

export function createBrowserContentReader() {
  const baseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/+$/, "") ?? "";
  return createContentReader({
    surrealUrl: import.meta.env.VITE_SURREAL_URL,
    workspaceDb: () => getCurrentWorkspace()?.dbName ?? null,
    nowSeconds: () => Math.floor(Date.now() / 1000),
    connect: () => new Surreal() as unknown as ContentConnection,
    async exchange(contentPublicId): Promise<ContentReaderExchangeSuccess | ContentReaderFailure> {
      const token = getToken();
      if (!token) return { ok: false, error: "not_member" };
      const response = await fetch(`${baseUrl}/api/session/content-reader`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ contentPublicId }),
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (isFailure(payload)) return payload;
      if (!response.ok || !isExchangeSuccess(payload)) {
        return { ok: false, error: "idp_rejected" };
      }
      return payload;
    },
  });
}
