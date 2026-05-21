import type { AuthState } from "../../shared/rpc.types";
import type { RouteState, ScreenId } from "./types";

export const RESEARCH_WINDOW_PARAMS_KEY = "__research_window_params";
export const STORED_ROUTE_KEY = "srk_route";

export type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export function readResearchWindowRoute(storage: Pick<StorageLike, "getItem" | "removeItem">): RouteState | null {
  try {
    const raw = storage.getItem(RESEARCH_WINDOW_PARAMS_KEY);
    if (!raw) return null;
    storage.removeItem(RESEARCH_WINDOW_PARAMS_KEY);
    const params = JSON.parse(raw) as Record<string, string>;
    if (params.mode !== "research") return null;
    return {
      screen: "research",
      researchSessionId: params.sessionId ?? undefined,
      resourceType: params.resourceType ?? "generic_note",
      initialUrl: params.initialUrl ?? undefined,
    };
  } catch {
    return null;
  }
}

export function readStoredRoute(
  storage: Pick<StorageLike, "getItem">,
  validStoredScreens: ReadonlySet<ScreenId>,
): RouteState | null {
  try {
    const raw = storage.getItem(STORED_ROUTE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RouteState;
    if (parsed.screen === "editor" && !parsed.workbookId) return { screen: "home" };
    if (validStoredScreens.has(parsed.screen)) return parsed;
  } catch {
    return null;
  }
  return null;
}

export function readInitialRoute(
  storage: Pick<StorageLike, "getItem" | "removeItem">,
  validStoredScreens: ReadonlySet<ScreenId>,
): RouteState {
  return readResearchWindowRoute(storage) ?? readStoredRoute(storage, validStoredScreens) ?? { screen: "home" };
}

export function shouldBypassLoginGate(route: Pick<RouteState, "screen">): boolean {
  return route.screen === "research";
}

export function shouldShowLoginGate(route: Pick<RouteState, "screen">, auth: AuthState): boolean {
  return !shouldBypassLoginGate(route) && !auth.loggedIn && !auth.offlineMode;
}

export function persistRoute(storage: StorageLike, route: RouteState): void {
  if (route.screen === "admin-console" || route.screen === "research") {
    storage.removeItem(STORED_ROUTE_KEY);
    return;
  }
  storage.setItem(STORED_ROUTE_KEY, JSON.stringify(route));
}
