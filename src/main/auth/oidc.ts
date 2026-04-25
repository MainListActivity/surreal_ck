import { createServer } from "node:http";
import { generatePKCE, generateState } from "./pkce";

const CLIENT_ID = "b10df483-1cd4-4beb-8a01-92e8f4b3fdf4";
const AUTHORIZE_URL = "https://o.maplayer.top/t/ck/authorize";
const TOKEN_URL = "https://o.maplayer.top/t/ck/token";
const USERINFO_URL = "https://o.maplayer.top/t/ck/userinfo";
const SCOPES = "openid profile email";

export interface TokenSet {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

export interface OIDCSession {
  tokens: TokenSet;
  /** access_token 过期的绝对时间（ms since epoch） */
  expires_at: number;
}

// 找一个可用的随机端口
function getRandomPort(): number {
  return 49152 + Math.floor(Math.random() * 16383);
}

function openBrowser(url: string): void {
  const { spawnSync } = require("node:child_process");
  spawnSync("open", [url], { stdio: "ignore" });
}

/**
 * 启动 PKCE 授权流程。
 * 1. 起临时 HTTP server 监听 localhost:{port}
 * 2. 打开系统浏览器到 IDP 授权页
 * 3. 等待 IDP 回调，提取 code
 * 4. 用 code + verifier 换取 tokens
 * 返回 TokenSet，调用方负责写入 SurrealDB。
 */
export function startOidcLogin(): Promise<TokenSet> {
  return new Promise((resolve, reject) => {
    const port = getRandomPort();
    const redirectUri = `http://localhost:${port}/callback`;
    const { verifier, challenge } = generatePKCE();
    const state = generateState();

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      const returnedState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      // 友好的关闭页面，让用户知道可以关闭浏览器
      const html = (msg: string, success: boolean) =>
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>SurrealCK</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">
<div style="text-align:center">
  <div style="font-size:48px">${success ? "✓" : "✗"}</div>
  <p style="font-size:18px;color:${success ? "#16a34a" : "#dc2626"}">${msg}</p>
  <p style="color:#6b7280">可以关闭此标签页</p>
</div></body></html>`;

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(
          html(`登录失败：${error}`, false)
        );
        server.close();
        reject(new Error(`OIDC error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(
          html("无效的回调参数", false)
        );
        server.close();
        reject(new Error("Invalid callback: missing code or state mismatch"));
        return;
      }

      try {
        const tokens = await exchangeCode({ code, verifier, redirectUri });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
          html("登录成功，正在返回应用…", true)
        );
        server.close();
        resolve(tokens);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" }).end(
          html("Token 交换失败，请重试", false)
        );
        server.close();
        reject(err);
      }
    });

    server.on("error", (err) => {
      reject(new Error(`Callback server error: ${err.message}`));
    });

    server.listen(port, "127.0.0.1", () => {
      const params = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        scope: SCOPES,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      openBrowser(`${AUTHORIZE_URL}?${params}`);
    });

    // 5 分钟超时
    setTimeout(() => {
      server.close();
      reject(new Error("Login timed out after 5 minutes"));
    }, 5 * 60 * 1000);
  });
}

async function exchangeCode(params: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: CLIENT_ID,
    code_verifier: params.verifier,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<TokenSet>;
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<TokenSet>;
}

export async function fetchUserInfo(
  accessToken: string
): Promise<Record<string, unknown>> {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`UserInfo fetch failed (${res.status})`);
  return res.json() as Promise<Record<string, unknown>>;
}
