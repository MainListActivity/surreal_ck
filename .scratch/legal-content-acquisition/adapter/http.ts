/**
 * 礼貌抓取层：普通浏览器式 HTTP GET，标准 cookie 会话处理；
 * 每次采集前强制 robots.txt 检查，且解析出的 Disallow 规则对目标 URL 与
 * 每个重定向目标都强制生效；遇到登录/验证码/403 等访问限制立即停止。
 * 重定向只允许落在准入来源 origin 之内：跨域/出站 3xx 一律按访问限制拒绝，
 * 防止把外站响应当作来源内容、或把站点会话 cookie 发给第三方主机。
 * 不内置任何凭证；不重试除「WAF 首访发 cookie 的同址 302」以外的任何重定向循环。
 */

import { AccessRestrictedError, requireQualifiedSource, QUALIFIED_SOURCES, ROBOTS_FORBIDDEN_SOURCES } from "./sources";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export type FetchTrailEvent = Readonly<{ at: string; step: string; detail: string }>;

export type PoliteFetchResult = Readonly<{
  url: string;
  status: number;
  html: string;
  fetchedAt: string;
  trail: FetchTrailEvent[];
  /** 响应正文 sha256（原始 HTML，证据清单用）。 */
  sha256: string;
}>;

export type RobotsCache = Map<string, string[]>;
const robotsDisallowedPaths: RobotsCache = new Map();

/** 抓取上下文：重定向必须留在准入 origin 内且不得命中 robots Disallow。 */
type FetchPolicy = Readonly<{
  origin: string;
  disallowPrefixes: readonly string[];
  fetchImpl: typeof fetch;
}>;

function nowIso(): string {
  return new Date().toISOString();
}

async function fetchWithCookies(
  url: string,
  cookies: Map<string, string>,
  trail: FetchTrailEvent[],
  policy: FetchPolicy,
  redirectsLeft = 3,
): Promise<{ status: number; body: string; location: string | null; setCookie: string | null }> {
  const cookieHeader = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const response = await policy.fetchImpl(url, {
    redirect: "manual",
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml",
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) {
    // 只记录 cookie 名，不保存敏感值到轨迹之外；值保存在进程内 map（与浏览器会话等效）。
    const [pair] = setCookie.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  trail.push({ at: nowIso(), step: "fetch", detail: `${response.status} ${url}` });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (location) {
      let next: string;
      try {
        next = new URL(location, url).toString();
      } catch {
        trail.push({ at: nowIso(), step: "stop", detail: `重定向目标无法解析：${location}，按访问限制拒绝` });
        throw new AccessRestrictedError(`重定向目标无法解析（${location}），按访问限制停止采集：${url}`);
      }
      if (new URL(next).origin !== policy.origin) {
        trail.push({ at: nowIso(), step: "stop", detail: `重定向目标越出准入来源 origin（${new URL(next).origin}），按访问限制拒绝` });
        throw new AccessRestrictedError(`重定向目标越出准入来源 ${policy.origin}：${next}，按访问限制停止采集（原 URL：${url}）`);
      }
      if (isPathDisallowed(policy.disallowPrefixes, next)) {
        trail.push({ at: nowIso(), step: "stop", detail: `重定向目标命中 robots Disallow：${new URL(next).pathname}，停止采集` });
        throw new AccessRestrictedError(`重定向目标被 robots.txt 禁止采集：${next}（原 URL：${url}）`);
      }
      if (redirectsLeft > 0) {
        return fetchWithCookies(next, cookies, trail, policy, redirectsLeft - 1);
      }
      trail.push({ at: nowIso(), step: "stop", detail: `重定向次数超过上限，按访问限制拒绝：${url}` });
    }
  }
  return { status: response.status, body: await response.text(), location: response.headers.get("location"), setCookie };
}

/** 解析 robots.txt 的 `User-agent: *` 组，返回 Disallow 前缀列表。 */
export function parseRobotsDisallowAll(robotsText: string): string[] {
  const lines = robotsText.split(/\r?\n/u);
  const disallow: string[] = [];
  let appliesToAll = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/u, "").trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") appliesToAll = value === "*";
    else if (key === "disallow" && appliesToAll && value.length > 0) disallow.push(value);
  }
  return disallow;
}

export function isPathDisallowed(disallowPrefixes: readonly string[], url: string): boolean {
  const path = new URL(url).pathname;
  return disallowPrefixes.some((prefix) => prefix === "/" || path.startsWith(prefix));
}

async function ensureRobotsChecked(origin: string, trail: FetchTrailEvent[], cache: RobotsCache, fetchImpl: typeof fetch): Promise<string[]> {
  const config = QUALIFIED_SOURCES[new URL(origin).host];
  const forbidden = ROBOTS_FORBIDDEN_SOURCES[new URL(origin).host];
  if (forbidden) throw new AccessRestrictedError(forbidden);
  const cached = cache.get(origin);
  if (cached) return cached;
  const robotsUrl = `${origin}/robots.txt`;
  const response = await fetchImpl(robotsUrl, {
    redirect: "manual",
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {
    trail.push({ at: nowIso(), step: "robots", detail: `robots 检查网络失败（保守拒绝）：${robotsUrl}` });
    throw new AccessRestrictedError(`无法确认 robots 规则，保守停止采集：${robotsUrl}`);
  });
  let disallow: string[];
  if (response.ok) {
    disallow = parseRobotsDisallowAll(await response.text());
  } else if (config?.robotsVerifiedNoRestrictions) {
    // LCAQ-01 已核验该站无 robots 禁令（404/无文件；302 为 WAF 挑战非 robots 应答）。
    disallow = [];
  } else {
    trail.push({ at: nowIso(), step: "robots", detail: `robots 状态 ${response.status} 且无准入核验记录（保守拒绝）` });
    throw new AccessRestrictedError(`robots 状态 ${response.status} 且准入记录未核验过该站 robots，保守停止：${robotsUrl}`);
  }
  trail.push({ at: nowIso(), step: "robots", detail: `${robotsUrl} -> ${response.status}, Disallow 规则 ${disallow.length} 条` });
  cache.set(origin, disallow);
  return disallow;
}

/**
 * 登录/验证码页面的确定性特征：只看「去掉 script/style 后的可见文本」，
 * 避免把页面脚本里引用的组件名（如 captcha SDK）误判为拦截页。
 */
const ACCESS_RESTRICTION_MARKERS = [
  "请输入验证码",
  "验证码输入",
  "请先登录",
  "请登录后",
  "无权访问",
  "access denied",
];

function detectAccessRestriction(html: string): string | null {
  const visibleText = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/giu, " ")
    .replace(/<[^>]*>/gu, " ")
    .toLowerCase();
  for (const marker of ACCESS_RESTRICTION_MARKERS) {
    if (visibleText.includes(marker)) return marker;
  }
  return null;
}

/**
 * 采集入口：robots 检查 → 目标 URL 命中 Disallow 即停 → GET（标准 cookie 会话，
 * 重定向限同 origin 且不越出 robots 规则）→ 限制检测。
 * 返回原始 HTML 快照与采集轨迹（时间、跳转、cookie 名）。
 * `opts.fetchImpl` / `opts.robotsCache` 仅供测试注入，生产调用不传。
 */
export async function politeFetchHtml(
  url: string,
  opts?: Readonly<{ fetchImpl?: typeof fetch; robotsCache?: RobotsCache }>,
): Promise<PoliteFetchResult> {
  const config = requireQualifiedSource(url);
  if (!url.startsWith(`${config.origin}/`)) {
    throw new AccessRestrictedError(`URL 不在准入来源 ${config.origin} 之下：${url}`);
  }
  const trail: FetchTrailEvent[] = [];
  const cache = opts?.robotsCache ?? robotsDisallowedPaths;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const disallow = await ensureRobotsChecked(config.origin, trail, cache, fetchImpl);
  if (isPathDisallowed(disallow, url)) {
    trail.push({ at: nowIso(), step: "stop", detail: `目标路径命中 robots Disallow：${new URL(url).pathname}，停止采集` });
    throw new AccessRestrictedError(`目标路径被 robots.txt 禁止采集（访问限制已变化），停止采集：${url}`);
  }
  const fetchedAt = nowIso();
  const { status, body } = await fetchWithCookies(url, new Map(), trail, { origin: config.origin, disallowPrefixes: disallow, fetchImpl });
  if (status !== 200) {
    trail.push({ at: nowIso(), step: "stop", detail: `HTTP ${status}，按访问限制处理，停止采集` });
    throw new AccessRestrictedError(`来源返回 HTTP ${status}（非 200），访问限制可能已变化，停止采集：${url}`);
  }
  const marker = detectAccessRestriction(body);
  if (marker) {
    trail.push({ at: nowIso(), step: "stop", detail: `页面出现访问限制特征「${marker}」，停止采集` });
    throw new AccessRestrictedError(`页面出现访问限制特征「${marker}」，停止采集：${url}`);
  }
  const digest = await sha256Hex(body);
  return { url, status, html: body, fetchedAt, trail, sha256: digest };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
