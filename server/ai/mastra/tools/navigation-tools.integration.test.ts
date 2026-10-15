import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Surreal } from "surrealdb";
import { RequestContext } from "@mastra/core/request-context";
import { setExecutionContext } from "../execution-context";

// 针对公司 fork 的真实回归：searchRecord 的 filterClause 必须能在 fork 上解析并返回行。
// 运行：SURREAL_BINARY=$HOME/.surrealdb/surreal RUN_LOCAL_SURREALDB_NAVIGATION_TOOLS_TESTS=1 \
//   bun test ./ai/mastra/tools/navigation-tools.integration.test.ts --preload ./test/setup-env.ts
const RUN_INTEGRATION =
  process.env.RUN_LOCAL_SURREALDB_NAVIGATION_TOOLS_TESTS === "1";
const localTest = test.skipIf(!RUN_INTEGRATION);
const surrealBinary = process.env.SURREAL_BINARY ?? "surreal";
const namespace = "main";
const database = "ws_navigation_tools_test";

let endpoint = "";
let workingDirectory = "";
let server: ReturnType<typeof Bun.spawn> | undefined;
let db: Surreal | undefined;

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("failed to allocate SurrealDB port"));
        return;
      }
      listener.close((error) =>
        error ? reject(error) : resolve(address.port)
      );
    });
  });
}

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = Bun.spawn([
      surrealBinary,
      "is-ready",
      "--endpoint",
      endpoint,
    ], { stdout: "ignore", stderr: "ignore" });
    if (await probe.exited === 0) return;
    await Bun.sleep(100);
  }
  throw new Error("local SurrealDB did not become ready");
}

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;
  workingDirectory = await mkdtemp(
    join(tmpdir(), "surreal-ck-navigation-tools-"),
  );
  const port = await allocatePort();
  endpoint = `ws://127.0.0.1:${port}`;
  server = Bun.spawn([
    surrealBinary,
    "start",
    "--no-banner",
    "--log",
    "none",
    "--bind",
    `127.0.0.1:${port}`,
    "--user",
    "root",
    "--pass",
    "root",
    `rocksdb:${join(workingDirectory, "data")}`,
  ], {
    cwd: workingDirectory,
    stdout: "ignore",
    stderr: "pipe",
  });
  await waitUntilReady();

  db = new Surreal();
  await db.connect(`${endpoint}/rpc`, {
    authentication: { username: "root", password: "root" },
    namespace,
    database,
  });
  await db.query(`
    DEFINE NAMESPACE IF NOT EXISTS ${namespace};
    DEFINE DATABASE IF NOT EXISTS ${database};
    DEFINE TABLE sheet SCHEMALESS;
    DEFINE TABLE ent_pump SCHEMALESS;
    CREATE sheet:pumps SET
      table_name = "ent_pump",
      column_defs = [
        { key: "name", label: "名称", field_type: "text" },
        { key: "code", label: "编码", field_type: "text" },
        { key: "serial", label: "序列号", field_type: "number" }
      ];
    CREATE ent_pump:one SET name = "离心泵A", code = "PUMP-01", serial = 8842;
    CREATE ent_pump:two SET name = "离心泵B", code = "PUMP-02", serial = 9917;
    CREATE ent_pump:three SET display_name = "轴流风机", code = "FAN-77";
  `);
});

afterAll(async () => {
  await db?.close();
  server?.kill();
  if (server) await server.exited;
  if (workingDirectory) {
    await rm(workingDirectory, { force: true, recursive: true });
  }
});

function ctxWithSession(session: Surreal): { requestContext: RequestContext } {
  const requestContext = new RequestContext();
  setExecutionContext(requestContext, { surrealSession: session });
  return { requestContext };
}

type SearchRecordResult = {
  intent:
    | { type: "ambiguous"; candidates: { label: string; id: string }[] }
    | { type: "open-record"; workbookId: string; sheetId: string; recordId: string; label: string };
};

async function executeSearchRecord(input: {
  sheetId: string;
  workbookId: string;
  query: string;
  fieldKey?: string;
}): Promise<SearchRecordResult> {
  if (!db) throw new Error("integration database not initialized");
  const { searchRecordTool } = await import("./navigation-tools");
  const execute = searchRecordTool.execute as unknown as (
    input: typeof input,
    ctx: { requestContext: RequestContext },
  ) => Promise<SearchRecordResult>;
  return await execute(input, ctxWithSession(db));
}

describe("searchRecord tool against local SurrealDB fork", () => {
  localTest(
    "无 fieldKey：按 name 检索在 fork 上返回行而非 Parse error",
    async () => {
      const result = await executeSearchRecord({
        sheetId: "sheet:pumps",
        workbookId: "workbook:wb1",
        query: "离心泵A",
      });
      expect(result.intent.type).toBe("open-record");
      expect(
        (result.intent as { type: "open-record"; recordId: string }).recordId,
      ).toBe("ent_pump:one");

      const multi = await executeSearchRecord({
        sheetId: "sheet:pumps",
        workbookId: "workbook:wb1",
        query: "离心泵",
      });
      expect(multi.intent.type).toBe("ambiguous");
      expect(
        (multi.intent as { type: "ambiguous"; candidates: unknown[] }).candidates,
      ).toHaveLength(2);
    },
  );

  localTest(
    "有 fieldKey：文本字段检索在 fork 上返回行而非 Parse error",
    async () => {
      const result = await executeSearchRecord({
        sheetId: "sheet:pumps",
        workbookId: "workbook:wb1",
        query: "fan",
        fieldKey: "code",
      });
      expect(result.intent.type).toBe("open-record");
      expect(
        (result.intent as { type: "open-record"; recordId: string }).recordId,
      ).toBe("ent_pump:three");
    },
  );

  localTest(
    "有 fieldKey：数值字段经 <string> cast 后可被检索（cast 语义验证）",
    async () => {
      const result = await executeSearchRecord({
        sheetId: "sheet:pumps",
        workbookId: "workbook:wb1",
        query: "8842",
        fieldKey: "serial",
      });
      expect(result.intent.type).toBe("open-record");
      expect(
        (result.intent as { type: "open-record"; recordId: string }).recordId,
      ).toBe("ent_pump:one");
    },
  );
});
