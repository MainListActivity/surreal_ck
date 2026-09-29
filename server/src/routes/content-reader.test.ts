import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppBindings } from "../hono-types";
import type { ContentReaderExchangeSuccess, ContentReaderFailure } from "@surreal-ck/shared";
import { handleError } from "../middleware/error";
import { createContentReaderRoutes } from "./content-reader";

const user = {
  subject: "user-123",
  email: "ada@example.test",
  raw: {},
  rawToken: "test-token",
};

function appFor(result: ContentReaderExchangeSuccess | ContentReaderFailure) {
  const app = new Hono<AppBindings>();
  app.onError(handleError);
  app.route("/", createContentReaderRoutes({
    requireUser: () => async (c, next) => {
      c.set("user", user);
      await next();
    },
    exchange: async () => result,
  }));
  return app;
}

function post(app: Hono<AppBindings>) {
  return app.fetch(new Request("http://localhost/api/session/content-reader", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contentPublicId: "version_example" }),
  }));
}

describe("content reader route", () => {
  test("IdP rejection is a complete 503 application response", async () => {
    const response = await post(appFor({ ok: false, error: "idp_rejected", idpError: "invalid_scope" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "content-reader-idp_rejected",
        message: "内容读取凭证被拒绝",
        details: { idpError: "invalid_scope" },
      },
    });
  });

  test("invalid lifetime is 503 without an IdP code", async () => {
    const response = await post(appFor({ ok: false, error: "invalid_lifetime" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "content-reader-invalid_lifetime",
        message: "内容读取凭证被拒绝",
      },
    });
  });

  test("collection denial stays a 403 application response", async () => {
    const response = await post(appFor({ ok: false, error: "collection_denied" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "content-reader-collection_denied",
        message: "内容读取凭证被拒绝",
      },
    });
  });
});
