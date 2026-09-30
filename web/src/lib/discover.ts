import type {
  DiscoverCoverage,
  DiscoverEvaluation,
  DiscoverEventInput,
  DiscoverOverview,
  DiscoverQueryResult,
} from "@surreal-ck/shared";
import { getToken } from "./auth";

/**
 * LCA11 公开发现客户端。
 * overview / query / events 不带 Authorization 也能用（访客路径）；
 * 已登录时自动带 token，让服务端按成员身份评估覆盖缺口。
 * 事件上报只发送结构化标识，绝不发送问题原文。
 */

const base = (): string =>
  (import.meta as ImportMeta & { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL ?? "";

function headers(authenticated: boolean): Headers {
  const h = new Headers({ "Content-Type": "application/json" });
  if (authenticated) {
    const token = getToken();
    if (token) h.set("Authorization", `Bearer ${token}`);
  }
  return h;
}

async function postJson<T>(path: string, body: unknown, authenticated: boolean): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    method: "POST",
    headers: headers(authenticated),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let code = "request_failed";
    try {
      code = String((await res.json()).code ?? code);
    } catch {
      /* 保持默认 code */
    }
    throw new DiscoverClientError(code, res.status);
  }
  return (await res.json()) as T;
}

export class DiscoverClientError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = "DiscoverClientError";
  }
}

export async function fetchDiscoverOverview(): Promise<DiscoverOverview> {
  const res = await fetch(`${base()}/api/discover/overview`, { headers: headers(true) });
  if (!res.ok) throw new DiscoverClientError("overview_unavailable", res.status);
  return (await res.json()) as DiscoverOverview;
}

export async function askDiscover(question: string, member: boolean): Promise<DiscoverQueryResult> {
  if (member) {
    return await postJson<DiscoverEvaluation>("/api/discover/evaluate", { question }, true);
  }
  return await postJson<DiscoverQueryResult>("/api/discover/query", { question }, false);
}

export async function sendDiscoverEvent(event: DiscoverEventInput): Promise<void> {
  try {
    await postJson("/api/discover/events", event, true);
  } catch {
    /* 事件上报失败不打断页面 */
  }
}

export const KIND_LABELS: Record<string, string> = {
  legislation: "法规",
  judicial_document: "司法文书",
};

export function kindLabel(key: string): string {
  return KIND_LABELS[key] ?? key;
}

export const COVERAGE_LABELS: Record<DiscoverCoverage, string> = {
  full: "已覆盖",
  partial: "部分覆盖",
  locked: "平台有覆盖，当前套餐未授权",
  unavailable: "暂无覆盖证据",
};

export function coverageLabel(coverage: DiscoverCoverage): string {
  return COVERAGE_LABELS[coverage];
}
