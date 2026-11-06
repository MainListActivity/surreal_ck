// 登录弹窗：消息协议解析与 <dialog> 交互逻辑。
// 与 web 端 auth-embed-protocol.ts、ma_hono admin 端 embed.ts 的消息结构保持一致。

export type IdpEmbedMessage = {
  source: "ma_hono";
  type: "login:ready" | "login:resize";
  height: number;
};

export type AuthEmbedMessage =
  | { source: "maplayer-auth"; type: "success"; returnTo: string }
  | { source: "maplayer-auth"; type: "error"; message: string };

type DialogState = "loading" | "ready" | "success" | "error";

const MIN_FRAME_HEIGHT = 320;
const SLOW_HINT_MS = 12_000;
const SUCCESS_REDIRECT_DELAY_MS = 700;

export function parseIdpMessage(data: unknown): IdpEmbedMessage | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.source !== "ma_hono") return null;
  if (
    (message.type === "login:ready" || message.type === "login:resize") &&
    typeof message.height === "number" &&
    Number.isFinite(message.height)
  ) {
    return { source: "ma_hono", type: message.type, height: message.height };
  }
  return null;
}

export function parseAuthMessage(data: unknown): AuthEmbedMessage | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.source !== "maplayer-auth") return null;
  if (message.type === "success" && typeof message.returnTo === "string") {
    return { source: "maplayer-auth", type: "success", returnTo: message.returnTo };
  }
  if (message.type === "error" && typeof message.message === "string") {
    return { source: "maplayer-auth", type: "error", message: message.message };
  }
  return null;
}

export function clampFrameHeight(height: number, available: number): number {
  const max = Math.max(MIN_FRAME_HEIGHT, Math.floor(available));
  if (!Number.isFinite(height) || height <= 0) return MIN_FRAME_HEIGHT;
  return Math.min(Math.max(Math.ceil(height), MIN_FRAME_HEIGHT), max);
}

export function sanitizeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export function initLoginDialog(): void {
  const dialog = document.querySelector<HTMLDialogElement>("[data-login-dialog]");
  if (!dialog || dialog.dataset.initialized === "true") return;
  dialog.dataset.initialized = "true";

  const appUrl = dialog.dataset.appUrl ?? "/";
  const appOrigin = new URL(appUrl, window.location.href).origin;

  const frameWrap = dialog.querySelector<HTMLElement>("[data-region='frame']");
  const slowHint = dialog.querySelector<HTMLElement>("[data-region='slow']");
  const errorMessage = dialog.querySelector<HTMLElement>("[data-error-message]");

  let iframe: HTMLIFrameElement | null = null;
  let state: DialogState = "loading";
  let slowTimer = 0;
  let preconnected = false;

  const setState = (next: DialogState): void => {
    state = next;
    dialog.dataset.state = next;
  };

  const availableFrameHeight = (): number =>
    Math.max(MIN_FRAME_HEIGHT, window.innerHeight - 180);

  const applyFrameHeight = (height: number): void => {
    if (!iframe) return;
    iframe.style.height = `${clampFrameHeight(height, availableFrameHeight())}px`;
  };

  const clearSlowTimer = (): void => {
    if (slowTimer) {
      window.clearTimeout(slowTimer);
      slowTimer = 0;
    }
    if (slowHint) slowHint.hidden = true;
  };

  const removeIframe = (): void => {
    iframe?.remove();
    iframe = null;
  };

  const createIframe = (): void => {
    removeIframe();
    const frame = document.createElement("iframe");
    frame.src = `${appOrigin}/auth/embed?returnTo=${encodeURIComponent("/")}`;
    frame.title = "登录卯豆";
    frame.allow = "publickey-credentials-get *; publickey-credentials-create *";
    frame.className = "dlg-iframe";
    frameWrap?.appendChild(frame);
    iframe = frame;
  };

  const open = (): void => {
    setState("loading");
    createIframe();
    if (!dialog.open) dialog.showModal();
    document.body.style.overflow = "hidden";
    clearSlowTimer();
    slowTimer = window.setTimeout(() => {
      if (state === "loading" && slowHint) slowHint.hidden = false;
    }, SLOW_HINT_MS);
  };

  const close = (): void => {
    if (state === "success" || !dialog.open) return;
    dialog.close();
  };

  const retry = (): void => {
    if (!dialog.open) return;
    setState("loading");
    createIframe();
    clearSlowTimer();
    slowTimer = window.setTimeout(() => {
      if (state === "loading" && slowHint) slowHint.hidden = false;
    }, SLOW_HINT_MS);
  };

  const preconnect = (): void => {
    if (preconnected) return;
    preconnected = true;
    const link = document.createElement("link");
    link.rel = "preconnect";
    link.href = appOrigin;
    document.head.appendChild(link);
  };

  const findTrigger = (target: EventTarget | null): Element | null =>
    target instanceof Element ? target.closest("[data-login-trigger]") : null;

  document.addEventListener("pointerover", (event) => {
    if (findTrigger(event.target)) preconnect();
  });
  document.addEventListener("focusin", (event) => {
    if (findTrigger(event.target)) preconnect();
  });

  document.addEventListener("click", (event) => {
    const trigger = findTrigger(event.target);
    if (!trigger || event.defaultPrevented) return;
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    open();
  });

  dialog.addEventListener("cancel", (event) => {
    if (state === "success") event.preventDefault();
  });

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
    const action = event.target instanceof Element
      ? event.target.closest("[data-dialog-close], [data-action='retry']")
      : null;
    if (!action) return;
    if (action.hasAttribute("data-dialog-close")) close();
    else retry();
  });

  dialog.addEventListener("close", () => {
    clearSlowTimer();
    removeIframe();
    document.body.style.overflow = "";
  });

  window.addEventListener("message", (event) => {
    if (!iframe || event.source !== iframe.contentWindow) return;

    const idpMessage = parseIdpMessage(event.data);
    if (idpMessage) {
      if (idpMessage.type === "login:ready") {
        clearSlowTimer();
        setState("ready");
      }
      applyFrameHeight(idpMessage.height);
      return;
    }

    if (event.origin !== appOrigin) return;
    const authMessage = parseAuthMessage(event.data);
    if (!authMessage) return;

    if (authMessage.type === "success") {
      clearSlowTimer();
      setState("success");
      const returnTo = sanitizeReturnTo(authMessage.returnTo);
      window.setTimeout(() => {
        window.location.assign(`${appOrigin}${returnTo}`);
      }, SUCCESS_REDIRECT_DELAY_MS);
    } else {
      clearSlowTimer();
      setState("error");
      if (errorMessage) errorMessage.textContent = authMessage.message;
    }
  });
}
