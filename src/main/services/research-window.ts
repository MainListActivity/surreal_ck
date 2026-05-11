import type {
  OpenResearchWindowRequest,
  OpenResearchWindowResponse,
  ResearchSessionResponse,
} from "../../shared/rpc.types";
import { ServiceError } from "./errors";
import { getResearchSession } from "./resources";

export type ResearchWindowServiceDeps = {
  getResearchSession(req: { sessionId: string }): Promise<ResearchSessionResponse>;
  openWindow(url: string): Promise<void>;
};

export function isAllowedResearchUrl(value: string | undefined): boolean {
  if (!value?.trim()) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function createResearchWindowService(deps: ResearchWindowServiceDeps) {
  return {
    async openResearchWindow(req: OpenResearchWindowRequest): Promise<OpenResearchWindowResponse> {
      if (!isAllowedResearchUrl(req.initialUrl)) {
        throw new ServiceError("VALIDATION_ERROR", "检索窗口只允许打开 http/https URL");
      }

      if (!req.sessionId) {
        await deps.openWindow(buildResearchWindowUrl(req));
        return { opened: true };
      }

      const { session } = await deps.getResearchSession({ sessionId: req.sessionId });
      if (session.status !== "open") {
        throw new ServiceError("VALIDATION_ERROR", "只能打开 open 状态的检索会话");
      }
      await deps.openWindow(buildResearchWindowUrl(req));
      return { opened: true, session };
    },
  };
}

export function openResearchWindow(req: OpenResearchWindowRequest): Promise<OpenResearchWindowResponse> {
  return createResearchWindowService({
    getResearchSession,
    openWindow: openElectrobunResearchWindow,
  }).openResearchWindow(req);
}

function buildResearchWindowUrl(req: OpenResearchWindowRequest): string {
  const params = new URLSearchParams({
    mode: "research",
  });
  if (req.sessionId) params.set("sessionId", req.sessionId);
  else params.set("resourceType", req.resourceType?.trim() || "generic_note");
  if (req.initialUrl?.trim()) params.set("url", req.initialUrl.trim());
  return `views://mainview/index.html?${params.toString()}`;
}

async function openElectrobunResearchWindow(url: string): Promise<void> {
  const { BrowserWindow } = await import("electrobun/bun");
  new BrowserWindow({
    title: "资源检索",
    url,
    frame: { width: 1180, height: 780, x: 140, y: 120 },
    titleBarStyle: "hiddenInset",
  });
}
