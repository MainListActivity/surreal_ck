import { expect, test } from "bun:test";
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
