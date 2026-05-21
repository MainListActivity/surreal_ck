import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createApp } from "./app";
import { handleError } from "./middleware/error";

describe("Hono app", () => {
  test("exposes public health without requiring OIDC", async () => {
    const app = createApp();

    const response = await app.fetch(new Request("http://localhost/health"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "degraded",
      surrealdb: "down",
    });
    expect(typeof body.uptimeSec).toBe("number");
  });
});

describe("HTTP error handling", () => {
  const originalError = console.error;

  afterEach(() => {
    console.error = originalError;
  });

  test("returns normalized 500 bodies without exposing stack traces", async () => {
    const app = new Hono();
    const logs: unknown[] = [];
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };

    app.onError(handleError);
    app.get("/boom", () => {
      throw new Error("database password leaked in stack context");
    });

    const response = await app.fetch(new Request("http://localhost/boom"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "internal",
        message: "Internal server error",
      },
    });
    expect(JSON.stringify(body)).not.toContain("database password");
    expect(logs.length).toBe(1);
  });
});
