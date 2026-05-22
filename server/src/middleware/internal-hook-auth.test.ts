import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { handleError } from "./error";
import { requireInternalHook } from "./internal-hook-auth";
import { env } from "../env";

function createHookApp(): Hono {
  const app = new Hono();
  app.onError(handleError);
  app.post("/internal/default-scope", requireInternalHook(), (c) => c.json({ ok: true }));
  return app;
}

describe("internal hook auth", () => {
  const originalError = console.error;

  afterEach(() => {
    console.error = originalError;
  });

  test("accepts the configured bearer secret", async () => {
    const app = createHookApp();

    const response = await app.fetch(
      new Request("http://localhost/internal/default-scope", {
        method: "POST",
        headers: { authorization: `Bearer ${env.IDP_HOOK_SECRET}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("rejects missing or wrong bearer credentials", async () => {
    const app = createHookApp();
    const logs: unknown[] = [];
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };

    const missing = await app.fetch(new Request("http://localhost/internal/default-scope", { method: "POST" }));
    const wrong = await app.fetch(
      new Request("http://localhost/internal/default-scope", {
        method: "POST",
        headers: { authorization: "Bearer wrong-secret" },
        body: JSON.stringify({ secret: "body-secret" }),
      }),
    );

    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({
      error: { code: "internal-hook-auth-invalid" },
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({
      error: { code: "internal-hook-auth-invalid" },
    });
    expect(JSON.stringify(logs)).not.toContain("wrong-secret");
    expect(JSON.stringify(logs)).not.toContain("body-secret");
  });
});
