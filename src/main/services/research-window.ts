import type {
  OpenResearchWindowRequest,
  OpenResearchWindowResponse,
  ResearchSessionResponse,
} from "../../shared/rpc.types";
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
  webview: {
    executeJavascript(script: string): void;
  };
};

let researchWindowRpcFactory: ((getWindow?: () => ResearchWindowControlTarget | null) => ResearchWindowRpc) | null = null;

export function configureResearchWindowRpcFactory(factory: (getWindow?: () => ResearchWindowControlTarget | null) => ResearchWindowRpc): void {
  researchWindowRpcFactory = factory;
}

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
        await deps.openWindow({
          resourceType: req.resourceType?.trim() || "generic_note",
          initialUrl: req.initialUrl?.trim(),
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
        initialUrl: req.initialUrl?.trim(),
      });
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

async function openElectrobunResearchWindow(params: ResearchWindowParams): Promise<void> {
  const { BrowserView, BrowserWindow } = await import("electrobun/bun");

  // Electrobun 的 views:// URL scheme handler 用 absoluteString 提取路径，
  // 无法处理 query string 或 hash fragment（会把参数当文件名的一部分去查找）。
  // 解决方案：用纯净 URL 加载窗口，通过主 webview 的 localStorage 传递初始化参数，
  // 两个 webview 共享同一 partition（persist:default），localStorage 跨 webview 可见。
  const payload = JSON.stringify({ mode: "research", ...params });
  const storageKey = "__research_window_params";
  const escapedPayload = JSON.stringify(payload); // double-encode for JS string literal

  // 先通过主窗口 webview 把参数写入共享 localStorage，研究窗口加载后读取
  const mainViews = BrowserView.getAll();
  if (mainViews.length > 0) {
    mainViews[0].executeJavascript(
      `localStorage.setItem(${JSON.stringify(storageKey)}, ${escapedPayload});`
    );
  }

  let win: ResearchBrowserWindow | null = null;
  const rpc = researchWindowRpcFactory?.(() => win);

  win = new BrowserWindow({
    title: "资源检索",
    url: "views://mainview/index.html",
    frame: { width: 1180, height: 780, x: 140, y: 120 },
    titleBarStyle: "hiddenInset",
    rpc,
  });

  // 如果主窗口脚本注入在某些平台上晚于新窗口首屏，这里在研究窗口自身
  // 再写入一次并刷新，让 App 的同步 route 初始化能稳定读到 research 参数。
  setTimeout(() => {
    win.webview.executeJavascript(
      `localStorage.setItem(${JSON.stringify(storageKey)}, ${escapedPayload}); window.location.reload();`
    );
  }, 100);
}
