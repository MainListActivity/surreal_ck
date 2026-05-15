import { describe, expect, test } from "bun:test";
import { EXEC_TEMPLATE_IDS, execTemplate } from "./exec-template";
import { ServiceError } from "../services/errors";

describe("execTemplate DDL 代理", () => {
  test("提交 schema/templates 的 ddl 模板 id 和参数", async () => {
    let body: unknown;
    await execTemplate(EXEC_TEMPLATE_IDS.entityTable, { table_name: "ent_demo" }, {
      accessToken: async () => "token",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 });
      },
    });

    expect(body).toEqual({
      id: "ddl-entity-table",
      params: { table_name: "ent_demo" },
    });
  });

  test("网络错误映射为 OFFLINE_DDL_FORBIDDEN", async () => {
    await expect(execTemplate(EXEC_TEMPLATE_IDS.entityTable, {}, {
      accessToken: async () => "token",
      fetch: async () => { throw new Error("network down"); },
    })).rejects.toMatchObject({ code: "OFFLINE_DDL_FORBIDDEN" });
  });

  test("4xx 映射为 TEMPLATE_REJECTED 并保留服务端信息", async () => {
    await expect(execTemplate(EXEC_TEMPLATE_IDS.entityTable, {}, {
      accessToken: async () => "token",
      fetch: async () => new Response("bad template", { status: 400 }),
    })).rejects.toMatchObject({ code: "TEMPLATE_REJECTED", message: "bad template" });
  });

  test("5xx 映射为 REMOTE_DDL_FAILED", async () => {
    await expect(execTemplate(EXEC_TEMPLATE_IDS.entityTable, {}, {
      accessToken: async () => "token",
      fetch: async () => new Response("upstream down", { status: 503 }),
    })).rejects.toBeInstanceOf(ServiceError);
    await expect(execTemplate(EXEC_TEMPLATE_IDS.entityTable, {}, {
      accessToken: async () => "token",
      fetch: async () => new Response("upstream down", { status: 503 }),
    })).rejects.toMatchObject({ code: "REMOTE_DDL_FAILED" });
  });
});
