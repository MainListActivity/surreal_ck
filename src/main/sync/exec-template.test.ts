import { describe, expect, test } from "bun:test";
import { execTemplate } from "./exec-template";
import { ServiceError } from "../services/errors";

describe("execTemplate DDL 代理", () => {
  test("网络错误映射为 OFFLINE_DDL_FORBIDDEN", async () => {
    await expect(execTemplate("ent.create", {}, {
      accessToken: async () => "token",
      fetch: async () => { throw new Error("network down"); },
    })).rejects.toMatchObject({ code: "OFFLINE_DDL_FORBIDDEN" });
  });

  test("4xx 映射为 TEMPLATE_REJECTED 并保留服务端信息", async () => {
    await expect(execTemplate("ent.create", {}, {
      accessToken: async () => "token",
      fetch: async () => new Response("bad template", { status: 400 }),
    })).rejects.toMatchObject({ code: "TEMPLATE_REJECTED", message: "bad template" });
  });

  test("5xx 映射为 REMOTE_DDL_FAILED", async () => {
    await expect(execTemplate("ent.create", {}, {
      accessToken: async () => "token",
      fetch: async () => new Response("upstream down", { status: 503 }),
    })).rejects.toBeInstanceOf(ServiceError);
    await expect(execTemplate("ent.create", {}, {
      accessToken: async () => "token",
      fetch: async () => new Response("upstream down", { status: 503 }),
    })).rejects.toMatchObject({ code: "REMOTE_DDL_FAILED" });
  });
});
