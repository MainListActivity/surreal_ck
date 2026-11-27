import { join } from "node:path";

export async function recordingBrowser(executable: string, folder: string) {
  const sdk = Bun.file(join(import.meta.dir, "../../../web/node_modules/livekit-client/dist/livekit-client.esm.mjs"));
  const page = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: (request) => new URL(request.url).pathname === "/sdk.js"
      ? new Response(sdk, { headers: { "Content-Type": "application/javascript" } })
      : new Response('<script type="module">import * as livekit from "/sdk.js"; window.lk = livekit;</script>',
        { headers: { "Content-Type": "text/html" } }),
  });
  const chrome = Bun.spawn([executable, "--headless", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--autoplay-policy=no-user-gesture-required",
    "--remote-debugging-port=0", `--user-data-dir=${folder}`, page.url.href], { stdout: "ignore", stderr: "ignore" });
  let ws: WebSocket | undefined;
  const close = () => { ws?.close(); chrome.kill(); page.stop(true); };
  try {
    const flag = join(folder, "DevToolsActivePort");
    let port: string | undefined;
    for (let i = 0; i < 100 && !port && chrome.exitCode === null; i++) {
      port = (await Bun.file(flag).text().catch(() => "")).match(/^\d+/u)?.[0];
      if (!port) await Bun.sleep(50);
    }
    if (!port) throw new Error("浏览器未启动调试端口");
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
    const debuggerUrl = tabs.find(({ type }) => type === "page")!.webSocketDebuggerUrl;
    const socket = ws = new WebSocket(debuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = reject;
    });
    let id = 0;
    const evaluate = (expression: string) => new Promise<unknown>((resolve, reject) => {
      const current = ++id;
      const timer = setTimeout(() => { socket.removeEventListener("message", onmessage); reject(new Error("浏览器执行超时")); }, 12_000);
      function onmessage(event: MessageEvent) {
        const data = JSON.parse(String(event.data));
        if (data.id !== current) return;
        clearTimeout(timer);
        socket.removeEventListener("message", onmessage);
        if (data.error || data.result.exceptionDetails) reject(new Error(JSON.stringify(data.error ?? data.result.exceptionDetails)));
        else resolve(data.result.result.value);
      }
      socket.addEventListener("message", onmessage);
      socket.send(JSON.stringify({ id: current, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    for (let i = 0; i < 100 && !await evaluate("!!window.lk"); i++) await Bun.sleep(50);
    return { evaluate, close };
  } catch (error) { close(); throw error; }
}
