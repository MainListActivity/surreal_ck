/**
 * SCK-LCM-10 Codex OAuth 页面脚本。
 *
 * 运行方式（必须在用户明确交还 TaskSpace 后运行）：
 *   ego-browser nodejs .scratch/legal-content-mcp/scripts/ego-mcp-e2e.mjs
 *
 * 脚本只读取本机临时 OAuth 状态，不包含或打印密码、token、授权码。
 */

import { readFile, writeFile } from "node:fs/promises";

const spaceId = Number(process.env.EGO_TASK_SPACE_ID ?? "1");
const task = await takeOverTaskSpace(spaceId);
const page = task.page("p1");

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const safeCallbackPath = "/tmp/sck-mcp-e2e-callback.json";
const authUrl = (await readFile("/tmp/sck-mcp-e2e-auth-url.txt", "utf8")).trim();

const saveCallbackFromPage = async () => {
  const currentUrl = await page.url();
  const callback = new URL(currentUrl);
  if (callback.hostname !== "127.0.0.1" || callback.port !== "43123") return false;
  await writeFile(
    safeCallbackPath,
    JSON.stringify({
      path: callback.pathname,
      params: Object.fromEntries(callback.searchParams.entries()),
      received_at: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  return true;
};

const currentUrl = await page.url();
const current = new URL(currentUrl);
const isCallbackPage = current.hostname === "127.0.0.1" && current.port === "43123";
const isExistingAuthChallenge =
  current.hostname === "auth.maplayer.top" &&
  (current.pathname.startsWith("/login/ck") || current.pathname.startsWith("/consent"));
// 工作区首页的登录态不一定等于 IdP cookie；从业务页进入验收时必须先打开
// 本次 DCR 生成的授权 URL。若 IdP 会话有效，会直接跳到 consent；若当前已在
// challenge 页，则保留用户正在填写的内容。
if (!isCallbackPage && !isExistingAuthChallenge) {
  await page.goto(authUrl);
  await page.waitForLoadState();
}

await page.waitForSelector("loc=css:input[autocomplete='username']", {
  state: "visible",
  timeout: 15_000,
}).catch(() => undefined);

const urlAfterNavigation = await page.url();
if (urlAfterNavigation.includes("/login/ck")) {
  const user = await readJson("/tmp/sck-mcp-e2e-user-safe.json");
  await page.fill("loc=css:input[autocomplete='username']", user.email);

  const passwordLength = await page.evaluate(() => {
    const input = document.querySelector('input[type="password"]');
    return input instanceof HTMLInputElement ? input.value.length : 0;
  });
  if (passwordLength === 0) {
    console.log("等待用户在同一页面输入密码");
    await task.handOff();
    process.exit(0);
  }

  await page.click("loc=role:button[name='登录']", { label: "submit OAuth login" });
  await page.waitForLoadState();
}

if ((await page.url()).includes("/consent")) {
  await page.click("loc=role:button[name='允许']", { label: "approve MCP scopes" });
  await page.waitForLoadState();
}

if (await saveCallbackFromPage()) {
  console.log("OAuth 回调已安全保存");
} else {
  console.log({ url: await page.url(), title: await page.title() });
}

console.log(await page.snapshot());
