import type {
  AiRunCancelledEvent,
  OpenResearchWindowRequest,
  OpenResearchWindowResponse,
  ResearchSessionResponse,
} from "../../shared/rpc.types";
import { normalizeResearchVisitUrl } from "../../shared/research-url";
import { cancelAiWorkflowRun } from "./ai-cancel";
import { ServiceError } from "./errors";
import { getResearchSession } from "./resources";

export type ResearchWindowServiceDeps = {
  getResearchSession(req: { sessionId: string }): Promise<ResearchSessionResponse>;
  openWindow(params: ResearchWindowParams): Promise<void>;
};

export type ResearchWindowParams = {
  sessionId?: string;
  resourceType: string;
  initialUrl?: string;
};

export type ResearchWindowRpc = {
  setTransport(transport: unknown): void;
};

export type ResearchWindowControlTarget = {
  isMaximized(): boolean;
  maximize(): void;
  unmaximize(): void;
};

type ResearchBrowserWindow = ResearchWindowControlTarget & {
  on(event: "close", handler: () => void): void;
  webview: {
    executeJavascript(script: string): void;
  };
};

let researchWindowRpcFactory: ((getWindow?: () => ResearchWindowControlTarget | null) => ResearchWindowRpc) | null = null;
let aiRunCancelledNotifier: ((event: AiRunCancelledEvent) => void | Promise<void>) | null = null;

export function configureResearchWindowRpcFactory(factory: (getWindow?: () => ResearchWindowControlTarget | null) => ResearchWindowRpc): void {
  researchWindowRpcFactory = factory;
}

export function configureResearchWindowAiRunCancelledNotifier(
  notifier: (event: AiRunCancelledEvent) => void | Promise<void>,
): void {
  aiRunCancelledNotifier = notifier;
}

export function isAllowedResearchUrl(value: string | undefined): boolean {
  if (!value?.trim()) return true;
  return normalizeResearchVisitUrl(value) !== null;
}

export function createResearchWindowService(deps: ResearchWindowServiceDeps) {
  return {
    async openResearchWindow(req: OpenResearchWindowRequest): Promise<OpenResearchWindowResponse> {
      const initialUrl = normalizeResearchVisitUrl(req.initialUrl) ?? undefined;
      if (req.initialUrl?.trim() && !initialUrl) {
        throw new ServiceError("VALIDATION_ERROR", "检索窗口只允许打开 http/https URL 或标准域名");
      }

      if (!req.sessionId) {
        await deps.openWindow({
          resourceType: req.resourceType?.trim() || "generic_note",
          initialUrl,
        });
        return { opened: true };
      }

      const { session } = await deps.getResearchSession({ sessionId: req.sessionId });
      if (session.status !== "open") {
        throw new ServiceError("VALIDATION_ERROR", "只能打开 open 状态的检索会话");
      }
      await deps.openWindow({
        sessionId: req.sessionId,
        resourceType: session.resourceType,
        initialUrl,
      });
      return { opened: true, session };
    },
  };
}

export function openResearchWindow(req: OpenResearchWindowRequest): Promise<OpenResearchWindowResponse> {
  return createResearchWindowService({
    getResearchSession,
    openWindow: openRetiredResearchWindow,
  }).openResearchWindow(req);
}

async function openRetiredResearchWindow(_params: ResearchWindowParams): Promise<void> {
  throw new ServiceError("NOT_IMPLEMENTED", "旧桌面检索窗口已退役，请使用 Web 资源检索入口");
}

export async function cancelResearchSessionForClosedWindow(
  sessionId: string | undefined,
  deps: {
    cancelAiWorkflowRun(req: { runId: string; sessionId: string; reason: "research-window-closed" }): Promise<{ event: AiRunCancelledEvent }>;
    getResearchSession(req: { sessionId: string }): Promise<ResearchSessionResponse>;
    notify(event: AiRunCancelledEvent): void | Promise<void>;
  } = {
    cancelAiWorkflowRun,
    getResearchSession,
    notify: async (event) => aiRunCancelledNotifier?.(event),
  },
): Promise<AiRunCancelledEvent | null> {
  if (!sessionId) return null;
  const { session } = await deps.getResearchSession({ sessionId });
  if (session.status !== "open" || !session.originatingRunId) return null;

  const result = await deps.cancelAiWorkflowRun({
    runId: session.originatingRunId,
    sessionId,
    reason: "research-window-closed",
  });
  await deps.notify(result.event);
  return result.event;
}
