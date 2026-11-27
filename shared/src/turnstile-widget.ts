type Widget = {
  render(element: HTMLElement, options: {
    sitekey: string;
    action: string;
    callback: (token: string) => void;
    "expired-callback": () => void;
    "error-callback": () => void;
  }): string;
  reset(id: string): void;
  remove(id: string): void;
};

let loading: Promise<Widget> | undefined;

function loadWidget(): Promise<Widget> {
  return loading ??= new Promise<Widget>((resolve, reject) => {
    const browser = window as Window & { turnstile?: Widget };
    const script = document.createElement("script");
    const failed = () => {
      script.remove();
      reject(new Error("安全验证加载失败，请重新加载页面"));
    };
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => browser.turnstile ? resolve(browser.turnstile) : failed();
    script.onerror = failed;
    document.head.append(script);
  }).catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
}

export function mountTurnstile(
  element: HTMLElement, sitekey: string, action: string,
  update: (token: string) => void, failure: (message: string) => void,
) {
  let widget: Widget | undefined;
  let id: string | undefined;
  let disposed = false;
  void loadWidget().then(api => {
    if (disposed) return;
    widget = api;
    id = api.render(element, {
      sitekey,
      action,
      callback: token => { failure(""); update(token); },
      "expired-callback": () => update(""),
      "error-callback": () => { update(""); failure("安全验证暂不可用，请重新加载页面"); },
    });
  }).catch(() => {
    if (!disposed) failure("安全验证加载失败，请重新加载页面");
  });
  return {
    reset() {
      update("");
      if (id !== undefined) widget?.reset(id);
    },
    remove() {
      disposed = true;
      if (id !== undefined) widget?.remove(id);
    },
  };
}
