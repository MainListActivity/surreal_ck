import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringRecordId } from "surrealdb";
import {
  RESOURCE_QUOTA_PLANS,
  buildRecordQuotaGuardSurql,
  type ResourceQuotaPlanKey,
} from "./resource-quota";

const RUN_CLI_QUOTA_TESTS = process.env.RUN_LOCAL_SURREALDB_QUOTA_TESTS === "1";
const localSurrealTest = test.skipIf(!RUN_CLI_QUOTA_TESTS);
const namespace = "main";
const username = "root";
const password = "root";
let endpoint = process.env.LOCAL_SURREAL_URL ?? "";
let surrealServer: ReturnType<typeof Bun.spawn> | null = null;
let cliWorkingDirectory = "";

const gridMigrationUrl = new URL("../sql/workspace-template/006-tables-grid.surql", import.meta.url);
const quotaMigrationUrl = new URL("../sql/workspace-template/020-resource-quota.surql", import.meta.url);

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate local SurrealDB port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = Bun.spawn(["surreal", "is-ready", "--endpoint", endpoint], {
      cwd: cliWorkingDirectory,
      stdout: "ignore",
      stderr: "ignore",
    });
    if (await ready.exited === 0) return;
    await Bun.sleep(100);
  }
  throw new Error(`local SurrealDB did not become ready: ${endpoint}`);
}

beforeAll(async () => {
  if (!RUN_CLI_QUOTA_TESTS) return;
  cliWorkingDirectory = await mkdtemp(join(tmpdir(), "surreal-ck-quota-cli-"));
  if (endpoint) return;
  const port = await allocatePort();
  endpoint = `ws://127.0.0.1:${port}`;
  surrealServer = Bun.spawn([
    "surreal",
    "start",
    "--no-banner",
    "--log",
    "none",
    "--bind",
    `127.0.0.1:${port}`,
    "--user",
    username,
    "--pass",
    password,
    "memory",
  ], {
    cwd: cliWorkingDirectory,
    stdout: "ignore",
    stderr: "pipe",
  });
  await waitUntilReady();
});

afterAll(async () => {
  surrealServer?.kill();
  if (surrealServer) await surrealServer.exited;
  if (cliWorkingDirectory) {
    await rm(cliWorkingDirectory, { force: true, recursive: true });
  }
});

function oneLineSurql(sql: string): string {
  return sql
    .replace(/^\s*--.*$/gmu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

async function runSurrealCli(database: string, sql: string): Promise<string> {
  const child = Bun.spawn([
    "surreal",
    "sql",
    "--json",
    "--hide-welcome",
    "--endpoint",
    endpoint,
    "--username",
    username,
    "--password",
    password,
    "--namespace",
    namespace,
    "--database",
    database,
  ], {
    cwd: cliWorkingDirectory,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(`${oneLineSurql(sql)}\n`);
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`surreal sql failed (${exitCode}): ${stderr || stdout}`);
  }
  return `${stdout}\n${stderr}`;
}

function expectSuccessful(output: string): void {
  expect(output).not.toMatch(/Parse error|There was a problem|An error occurred|Error while processing event/i);
}

async function bootstrapWorkspace(database: string, plan: ResourceQuotaPlanKey): Promise<void> {
  const [gridSql, quotaSql] = await Promise.all([
    readFile(gridMigrationUrl, "utf8"),
    readFile(quotaMigrationUrl, "utf8"),
  ]);
  expectSuccessful(await runSurrealCli(database, gridSql));
  expectSuccessful(await runSurrealCli(database, quotaSql));
  expectSuccessful(await runSurrealCli(
    database,
    `UPDATE ONLY workspace_resource_quota:current
       SET plan = resource_quota_plan:${plan}
       RETURN AFTER;`,
  ));
  expectSuccessful(await runSurrealCli(
    database,
    `CREATE workbook:quota_test CONTENT { name: "quota-test" };`,
  ));
}

function columnDefs(count: number): string {
  return `[${Array.from({ length: count }, (_, index) => `{ key: "field_${index + 1}" }`).join(", ")}]`;
}

async function createManagedSheet(
  database: string,
  index: number,
  fieldCount: number,
): Promise<string> {
  const sheetId = `sheet:s${index}`;
  const tableName = `ent_quota_${index}`;
  return await runSurrealCli(
    database,
    `BEGIN TRANSACTION;
     DEFINE TABLE IF NOT EXISTS ${tableName} SCHEMALESS;
     ${buildRecordQuotaGuardSurql({ tableName, sheetId: new StringRecordId(sheetId) })}
     CREATE ${sheetId} CONTENT {
       workbook: workbook:quota_test,
       label: "S${index}",
       table_name: "${tableName}",
       column_defs: ${columnDefs(fieldCount)}
     };
     COMMIT TRANSACTION;`,
  );
}

async function verifyPlanLimits(plan: ResourceQuotaPlanKey): Promise<string> {
  const limits = RESOURCE_QUOTA_PLANS[plan];
  const database = `quota_${plan}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await bootstrapWorkspace(database, plan);

  for (let index = 1; index <= limits.maxSheets; index += 1) {
    expectSuccessful(await createManagedSheet(database, index, index === 1 ? limits.maxFieldsPerSheet : 1));
  }
  expect(await createManagedSheet(database, limits.maxSheets + 1, 1)).toContain("quota-sheets-exceeded");

  const fieldOverflow = await runSurrealCli(
    database,
    `BEGIN TRANSACTION;
     DEFINE FIELD overflow ON TABLE ent_quota_1 TYPE string;
     UPDATE sheet:s1 SET column_defs += { key: "overflow" };
     COMMIT TRANSACTION;`,
  );
  expect(fieldOverflow).toContain("quota-fields-exceeded");
  const fieldRollback = await runSurrealCli(
    database,
    `RETURN (INFO FOR TABLE ent_quota_1).fields.overflow;`,
  );
  expect(fieldRollback).not.toContain("DEFINE FIELD overflow");

  for (let index = 1; index <= limits.maxRecordsPerSheet; index += 1) {
    expectSuccessful(await runSurrealCli(
      database,
      `CREATE ent_quota_1:r${index} CONTENT { field_1: ${index} };`,
    ));
  }
  const recordOverflow = await runSurrealCli(
    database,
    `CREATE ent_quota_1:overflow CONTENT { field_1: 999 };`,
  );
  expect(recordOverflow).toContain("quota-records-exceeded");

  const snapshot = await runSurrealCli(
    database,
    `SELECT plan.key AS plan_key, sheet_count,
       plan.max_sheets AS max_sheets,
       plan.max_fields_per_sheet AS max_fields,
       plan.max_records_per_sheet AS max_records
     FROM ONLY workspace_resource_quota:current;
     SELECT sheet, record_count FROM sheet_resource_usage ORDER BY sheet;`,
  );
  expect(snapshot).toContain(`"plan_key":"${plan}"`);
  expect(snapshot).toContain(`"sheet_count":${limits.maxSheets}`);
  expect(snapshot).toContain(`"record_count":${limits.maxRecordsPerSheet}`);
  return database;
}

describe("resource quota local SurrealDB CLI integration", () => {
  localSurrealTest("Plus 限制 1 张/3 字段/2 记录，改为 2 张后立即允许第二张", async () => {
    const database = await verifyPlanLimits("plus");

    expectSuccessful(await runSurrealCli(
      database,
      `UPDATE ONLY resource_quota_plan:plus SET max_sheets = 2 RETURN AFTER;`,
    ));
    expectSuccessful(await createManagedSheet(database, 2, 1));
    const snapshot = await runSurrealCli(
      database,
      `SELECT plan.max_sheets AS max_sheets, sheet_count
       FROM ONLY workspace_resource_quota:current;`,
    );
    expect(snapshot).toContain('"max_sheets":2');
    expect(snapshot).toContain('"sheet_count":2');
  }, 30_000);

  localSurrealTest("Pro 限制 2 张/6 字段/4 记录", async () => {
    await verifyPlanLimits("pro");
  }, 30_000);

  localSurrealTest("Max 限制 3 张/9 字段/6 记录", async () => {
    await verifyPlanLimits("max");
  }, 30_000);
});
