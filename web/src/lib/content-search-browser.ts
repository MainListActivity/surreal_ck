import { Surreal } from "surrealdb";
import { contentExchangeFailure, LegalRetrievalRequestSchema, type LegalRetrievalResponse, type ContentReaderFailure, type ContentSearchExchangeSuccess } from "@surreal-ck/shared";
import { getToken } from "./auth";
import { getCurrentWorkspace } from "./workspace-store.svelte";
import { createContentSearch } from "./content-search";

/** Every search creates a fresh caller-bound authorization window; no result cache. */
export async function searchBrowserLegalSemantics(input: unknown): Promise<LegalRetrievalResponse> {
  const request = LegalRetrievalRequestSchema.parse(input);
  const workspace = getCurrentWorkspace()?.dbName;
  const token = getToken();
  if (!workspace || !token) throw new Error("legal-search-not-member");
  const baseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/+$/, "") ?? "";
  const response = await fetch(`${baseUrl}/api/legal/search`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(request), cache: "no-store",
  });
  if (!response.ok || getCurrentWorkspace()?.dbName !== workspace) throw new Error("legal-search-unavailable");
  return await response.json() as LegalRetrievalResponse;
}

export function createBrowserContentSearch() {
  const baseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/+$/, "") ?? "";
  return createContentSearch({
    surrealUrl: import.meta.env.VITE_SURREAL_URL,
    workspaceDb: () => getCurrentWorkspace()?.dbName ?? null,
    nowSeconds: () => Math.floor(Date.now() / 1000),
    connect: () => new Surreal(),
    async exchange() {
      const token = getToken();
      if (!token) return { ok: false, error: "not_member" };
      const response = await fetch(`${baseUrl}/api/session/content-search`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: "{}", cache: "no-store",
      });
      const value: unknown = await response.json().catch(() => null);
      if (value && typeof value === "object" && (value as { ok?: unknown }).ok === false) {
        return value as ContentReaderFailure;
      }
      const failure = contentExchangeFailure(value, "content-search-");
      if (failure) return failure;
      if (!response.ok || !value || typeof value !== "object") throw new Error("content-search-exchange-failed");
      return value as ContentSearchExchangeSuccess;
    },
  });
}
