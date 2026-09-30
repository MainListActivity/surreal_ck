import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { createDiscoverRoutes } from "./discover";
import { DiscoverError } from "../discover/service";

const overviewResult = {
  aggregates: { totalItems: 1, kinds: [{ key: "legislation", count: 1 }], jurisdictions: [], collections: [], latestPublishedOn: "2025-01-01" },
  examples: [],
};

const evaluationResult = {
  scope: { kinds: ["legislation"], jurisdictions: ["CN"], collectionKeys: ["core_statutes"], matchedCount: 1, totalListed: 1 },
  matchedItems: [],
  examples: [],
  coverage: "partial" as const,
  coveredCollections: ["core_statutes"],
  gapCollections: ["pro_cases"],
  suggestion: { kind: "plan" as const, planKey: "lawyer_pro", planName: "Pro", coversCollections: ["pro_cases"], purchaseAvailable: false },
  entry: { kind: "request_admin" as const, planKey: "lawyer_pro" },
  retainedNote: "note",
};

function fakeService() {
  const events: unknown[] = [];
  return {
    events,
    overview: async () => overviewResult,
    publicQuery: async (_question: string) => ({ scope: evaluationResult.scope, matchedItems: [], examples: [] }),
    evaluateMember: async (input: { question: string; subject: string; workspaceDb: string }) => {
      if (input.subject === "nobody") throw new DiscoverError("not-member", "not a member");
      return evaluationResult;
    },
    rebuildProjection: async (_actor: string, _req: unknown) => ({ listed: 2, delisted: 0, examples: 1 }),
    recordEvent: async (_kind: "visitor" | "member", event: unknown) => { events.push(event); },
  };
}

function authMiddleware(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const token = c.req.header("authorization");
    if (!token) {
      const { HttpError } = await import("../http-error");
      throw new HttpError(401, "oidc-missing", "Missing bearer token");
    }
    const subject = token.includes("member") ? "alice" : "nobody";
    c.set("user", { subject, rawToken: "t", raw: { db: "ws_acme" } });
    await next();
  };
}

function opsMiddleware(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    if (!c.req.header("x-ops")) {
      const { HttpError } = await import("../http-error");
      throw new HttpError(403, "platform-operator-required", "需要平台运营身份");
    }
    c.set("platformOperator", { subject: "ops:a", capabilities: ["content.publish"] });
    await next();
  };
}

function app(service = fakeService()) {
  const h = new Hono<AppBindings>();
  h.onError(handleError);
  h.route("/", createDiscoverRoutes({ service: service as never, requireUser: authMiddleware, requireOperator: opsMiddleware }));
  return h;
}

describe("discover routes", () => {
  test("overview 与 query 对未登录访客开放", async () => {
    const a = app();
    expect((await a.request("/api/discover/overview")).status).toBe(200);
    const res = await a.request("/api/discover/query", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "建设工程" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ scope: { matchedCount: 1 } });
  });

  test("query 参数校验失败 → 400", async () => {
    const res = await app().request("/api/discover/query", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "" }),
    });
    expect(res.status).toBe(400);
  });

  test("evaluate 需要成员身份；非成员 → 403", async () => {
    const a = app();
    const noAuth = await a.request("/api/discover/evaluate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "q" }),
    });
    expect(noAuth.status).toBe(401);
    const outsider = await a.request("/api/discover/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: "Bearer outsider" },
      body: JSON.stringify({ question: "q" }),
    });
    expect(outsider.status).toBe(403);
    const member = await a.request("/api/discover/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: "Bearer member-token" },
      body: JSON.stringify({ question: "建设工程" }),
    });
    expect(member.status).toBe(200);
    expect(await member.json()).toMatchObject({ coverage: "partial", entry: { kind: "request_admin" } });
  });

  test("事件契约是 strictObject：夹带问题原文等自由字段被拒", async () => {
    const a = app();
    const clean = await a.request("/api/discover/events", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "suggestion_dismissed", scopeKinds: ["legislation"], scopeCollections: [], planKey: "lawyer_pro", moduleKey: null, conversion: "dismissed" }),
    });
    expect(clean.status).toBe(200);
    const dirty = await a.request("/api/discover/events", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "question", scopeKinds: [], scopeCollections: [], question: "机密案情", note: "free text" }),
    });
    expect(dirty.status).toBe(400);
  });

  test("rebuild 需要运营能力；正常请求透传重建结果", async () => {
    const a = app();
    const denied = await a.request("/api/ops/discover/rebuild", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ examples: [], reason: "r" }),
    });
    expect(denied.status).toBe(403);
    const ok = await a.request("/api/ops/discover/rebuild", {
      method: "POST", headers: { "Content-Type": "application/json", "x-ops": "1" },
      body: JSON.stringify({ examples: [{ key: "ex", title: "t", summary: "s", citationLabels: [], position: 0 }], reason: "r" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ listed: 2, delisted: 0, examples: 1 });
  });
});
