import { describe, expect, test } from "bun:test";
import {
  createHttpFailureLoggingFetch,
  type HttpFailureLogPayload,
} from "./http-failure-logger";

describe("HTTP failure logger", () => {
  test("logs non-2xx request and response details with redaction", async () => {
    const logs: Array<{ message: string; payload: HttpFailureLogPayload }> = [];
    const responseBody = JSON.stringify({
      error: "invalid_template_id",
      access_token: "remote-secret",
    });
    const wrappedFetch = createHttpFailureLoggingFetch(
      async () => new Response(responseBody, {
        status: 400,
        statusText: "Bad Request",
        headers: { "content-type": "application/json" },
      }),
      (message, payload) => logs.push({ message, payload }),
    );

    const response = await wrappedFetch(
      "https://auth.maplayer.top/api/db/execTemplate?token=url-secret&workspace=workspace:ws1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer request-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: "ddl-entity-table",
          params: { table_name: "ent_workspace_ws1_workbook_wb1_main" },
          apiKey: "request-secret",
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(responseBody);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toBe("[http] non-2xx response");
    expect(logs[0]?.payload.url).toBe(
      "https://auth.maplayer.top/api/db/execTemplate?token=%5Bredacted%5D&workspace=workspace%3Aws1",
    );
    expect(logs[0]?.payload.method).toBe("POST");
    expect(logs[0]?.payload.request.headers.authorization).toBe("[redacted]");
    expect(logs[0]?.payload.request.body).toEqual({
      id: "ddl-entity-table",
      params: { table_name: "ent_workspace_ws1_workbook_wb1_main" },
      apiKey: "[redacted]",
    });
    expect(logs[0]?.payload.response).toEqual({
      status: 400,
      statusText: "Bad Request",
      body: {
        error: "invalid_template_id",
        access_token: "[redacted]",
      },
    });
  });

  test("does not log 2xx responses", async () => {
    const logs: HttpFailureLogPayload[] = [];
    const wrappedFetch = createHttpFailureLoggingFetch(
      async () => new Response("ok", { status: 204 }),
      (_message, payload) => logs.push(payload),
    );

    const response = await wrappedFetch("https://example.test/ok");

    expect(response.status).toBe(204);
    expect(logs).toEqual([]);
  });
});
