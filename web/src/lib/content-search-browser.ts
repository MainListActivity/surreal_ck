import { Surreal } from "surrealdb";
import { contentExchangeFailure, type ContentReaderFailure, type ContentSearchExchangeSuccess } from "@surreal-ck/shared";
import { getToken } from "./auth";
import { getCurrentWorkspace } from "./workspace-store.svelte";
import { createContentSearch } from "./content-search";

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
