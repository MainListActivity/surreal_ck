import { InternalAiRegistration } from "../internal-ai/registration";
import { HttpError } from "../http-error";
import { expect, test, spyOn } from "bun:test";
import { Hono } from "hono";
import { handleError } from "../middleware/error";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { createOpsInternalAiRoutes } from "./ops-internal-ai";
import { InternalAiStore } from "../internal-ai/store";
import { InternalAiGate } from "../internal-ai/gate";
const neverDb = new InternalAiGate(new InternalAiStore(async () => { throw new Error("must not reach store"); }));
const allow: MiddlewareHandler<AppBindings> = async (_c, next) => next();
test("customer without ops auth cannot read runtime or ledger", async () => {
  const app = new Hono<AppBindings>().route("/", createOpsInternalAiRoutes({ gate: neverDb, runtime: {} })).onError(handleError);
  expect((await app.request("/api/ops/internal-ai/runtime")).status).toBe(401);
  expect((await app.request("/api/ops/internal-ai/activities/test")).status).toBe(401);
});
test("runtime reports unavailable balance, strips URL credentials, and never exposes key/query", async () => {
  const app = new Hono<AppBindings>().route("/", createOpsInternalAiRoutes({ gate: neverDb, requireOperator: allow, runtime: { provider: "openai", model: "gpt-4o-mini", endpoint: "https://user:secret@example.com/v1?key=secret" } }));
  const response = await app.request("/api/ops/internal-ai/runtime");
  const body = await response.json();
  expect(body.endpointHost).toBeNull(); expect(body.balance.status).toBe("unavailable"); expect(body.defaultEnabled).toBe(false);
  expect(body.mastraVersion).toBe("1.36.0"); expect(JSON.stringify(body)).not.toContain("secret");
  expect((await app.request("/api/ops/internal-ai/activities/test", { method: "POST" })).status).toBe(404);
});

test("registration endpoints retain ops authentication", async () => {
  const app = new Hono<AppBindings>().route("/", createOpsInternalAiRoutes({ gate: neverDb, runtime: {} })).onError(handleError);
  for (const path of ["company-proof", "activities/test/evidence", "activities/test/enable", "activities/test/disable", "identities/revoke"]) {
    expect((await app.request(`/api/ops/internal-ai/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  }
});
test("company broker proof-only envelope reaches verification; unknown fields cannot pass", async () => {
  const app = new Hono<AppBindings>().route("/", createOpsInternalAiRoutes({ gate: neverDb, runtime: {}, requireOperator: allow })).onError(handleError);
  const send = (body: unknown) => app.request("/api/ops/internal-ai/company-proof", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await send({ proof: "synthetic-invalid-jwt" })).status).toBe(422);
  expect((await send({ proof: "synthetic-invalid-jwt", subject: "forged" })).status).toBe(400);
});
test("supplier probe exposes unsupported current SenseNova without accepting URL/proxy input", async () => {
  const app = new Hono<AppBindings>().route("/", createOpsInternalAiRoutes({ gate: neverDb, runtime: { endpoint: "https://token.sensenova.cn/v1" }, requireOperator: allow })).onError(handleError);
  const response = await app.request("/api/ops/internal-ai/supplier-probe?host=token.sensenova.cn");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ host: "token.sensenova.cn", status: "unsupported", capabilities: [] });
  expect((await app.request("/api/ops/internal-ai/supplier-probe?host=other.example")).status).toBe(403);
  for (const host of ["token.sensenova.cn/path", "user:secret@token.sensenova.cn", "token.sensenova.cn?key=secret"]) {
    expect((await app.request(`/api/ops/internal-ai/supplier-probe?host=${encodeURIComponent(host)}`)).status).toBe(400);
  }
});


test("evidence, enable, disable and revoke forward a strict reason and authenticated operator", async () => {
  const registration = new InternalAiRegistration(async () => { throw new Error("must not touch DB"); });
  const reached = async (input: { operator: string; reason: string }): Promise<never> => {
    expect(input.operator).toBe("synthetic-operator");
    expect(input.reason).toBe("受审操作");
    throw new HttpError(418, "synthetic-reached", "reached service");
  };
  const mocks = [spyOn(registration, "submitEvidence").mockImplementation(reached), spyOn(registration, "enable").mockImplementation(reached),
    spyOn(registration, "disable").mockImplementation(reached), spyOn(registration, "revokeIdentity").mockImplementation(reached)];
  const operator: MiddlewareHandler<AppBindings> = async (c, next) => {
    c.set("platformOperator", { subject: "synthetic-operator", capabilities: ["subscription.manage"] });
    await next();
  };
  const app = new Hono<AppBindings>().route("/", createOpsInternalAiRoutes({ gate: neverDb, registration, runtime: {}, requireOperator: operator })).onError(handleError);
  try {
    for (const [path, body] of [
      ["activities/test/evidence", { revision: 1, document: "{}", reason: "受审操作" }],
      ["activities/test/enable", { revision: 1, reason: "受审操作" }],
      ["activities/test/disable", { reason: "受审操作" }],
      ["identities/revoke", { activity: "test", alias: "LCA04_MEMBER", reason: "受审操作" }],
    ] as const) {
      const request = (payload: unknown) => app.request(`/api/ops/internal-ai/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      expect((await request(body)).status).toBe(418);
      expect((await request({ ...body, budget: 1000000000 })).status).toBe(400);
    }
  } finally { mocks.forEach(mock => mock.mockRestore()); }
});
