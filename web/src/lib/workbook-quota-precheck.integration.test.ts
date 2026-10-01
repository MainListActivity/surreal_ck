import { afterEach, describe, expect, test } from "bun:test";
import { jsonify, Surreal } from "surrealdb";
import { commercialProductRules } from "@surreal-ck/shared/native-quota";
import type { ProductQuotaRule } from "@surreal-ck/shared/native-quota";
import type { QuotaApiResource, QuotaApiWorkspaceView } from "@surreal-ck/shared/native-quota";
import { loadTemplatePackScripts } from "@surreal-ck/shared/template-packs";
import { createBrowserConn, type SurrealConn } from "./surreal";
import {
  createWorkbookTemplatesStore,
  templateSheetsForCreate,
} from "./workbook-templates";
import { createWorkbooksStore } from "./workbooks";

/**
 * CV02 返工真机验证（公司 fork，含原生配额）：
 * - v1 Max（3/9/6 物理口径）下破产债权包被引擎原子拒绝：不装预检依赖时整事务
 *   回滚、不留 workbook/sheet/实体表；装预检依赖时提前给出所需/缺口且零写入。
 * - 正常升级到 Max v2（3/11/12）后同一包立即创建成功，INFO FOR QUOTA 读回
 *   印证新修订的实际限额。
 * - 容量视图由测试内投影器直接按 INFO FOR QUOTA STRUCTURE 装配，复刻
 *   quota-read-service 的 resources 形状（regex selector + 桶用量）。
 */

const localSurrealTest = test.skipIf(process.env.RUN_LOCAL_SURREALDB_TESTS !== "1");
const opened: Surreal[] = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
});

const SURREAL_URL = process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
const SURREAL_NS = process.env.LOCAL_SURREAL_NS ?? "main";
const AUTH = {
  username: process.env.LOCAL_SURREAL_ROOT_USER ?? "root",
  password: process.env.LOCAL_SURREAL_ROOT_PASS ?? "root",
};

function quotaPolicySurql(
  database: string,
  limits: { tables: number; fields: number; records: number },
  expectedGeneration?: number,
): string {
  const rules = commercialProductRules(limits).map((rule: ProductQuotaRule) => {
    const selector = rule.selector.kind === "exact"
      ? `EXACT \`${rule.selector.value.replaceAll("`", "\\`")}\``
      : `REGEX /${rule.selector.value.replaceAll("/", "\\/")}/`;
    const limit = rule.limit.kind === "unlimited" ? "UNLIMITED" : String(rule.limit.value);
    return `RULE \`${rule.rule_key}\` FOR ${rule.resource.toUpperCase()} MATCH ${selector} LIMIT ${limit}`;
  }).join("\n  ");
  const mode = expectedGeneration === undefined
    ? `DEFINE QUOTA ON DATABASE ${database}`
    : `DEFINE QUOTA OVERWRITE ON DATABASE ${database} EXPECT GENERATION ${expectedGeneration}`;
  return `${mode}\n  ${rules};`;
}

type QuotaInfo = {
  latest_change?: { generation?: number } | null;
  policy?: { generation?: number; rules?: Array<{
    rule_id: string;
    resource: "table" | "field" | "record";
    selector: { kind: "exact"; table: string } | { kind: "regex"; pattern: string };
    limit: { kind: "finite"; value: number } | { kind: "unlimited" };
  }> };
  usage?: {
    table_buckets?: Array<{
      rule_id: string;
      limit: { kind: "finite"; value: number } | { kind: "unlimited" };
      used: number;
      remaining: number | null;
    }>;
  };
};

/** 复刻 quota-read-service 的 resources 投影：regex selector + table 桶用量。 */
function projectQuotaResources(info: QuotaInfo): QuotaApiResource[] {
  const rules = info.policy?.rules ?? [];
  const buckets = new Map(
    (info.usage?.table_buckets ?? []).map((bucket) => [bucket.rule_id, bucket]),
  );
  return rules.map((rule): QuotaApiResource => {
    const selector = rule.selector.kind === "exact"
      ? { kind: "exact" as const, description: `表 ${rule.selector.table}`, table: rule.selector.table }
      : {
          kind: "regex" as const,
          description: `匹配该资源规则的业务表`,
          pattern: rule.selector.pattern,
          matched_tables: [],
        };
    if (rule.resource === "table") {
      const bucket = buckets.get(rule.rule_id);
      const usage = rule.limit.kind === "unlimited" || bucket?.limit.kind === "unlimited"
        ? { kind: "unlimited" as const, used: bucket?.used ?? 0, utilization_percent: null, at_limit: false as const, over_limit: false as const }
        : {
            kind: "finite" as const,
            limit: rule.limit.value,
            used: bucket?.used ?? 0,
            remaining: bucket?.remaining ?? rule.limit.value,
            over_by: null,
            utilization_percent: null,
            at_limit: null,
            over_limit: null,
          };
      return { key: rule.rule_id, resource: rule.resource, label: rule.rule_id, selector, usage };
    }
    const usage = rule.limit.kind === "unlimited"
      ? { kind: "unlimited" as const, used: 0, utilization_percent: null, at_limit: false as const, over_limit: false as const }
      : {
          kind: "finite" as const,
          limit: rule.limit.value,
          used: 0,
          remaining: rule.limit.value,
          over_by: null,
          utilization_percent: null,
          at_limit: null,
          over_limit: null,
        };
    return { key: rule.rule_id, resource: rule.resource, label: rule.rule_id, selector, usage };
  });
}

async function quotaInfo(root: Surreal, database: string): Promise<QuotaInfo> {
  const result = await root.query(`INFO FOR QUOTA ON DATABASE ${database} STRUCTURE;`);
  const value = Array.isArray(result) ? result[0] : result;
  return jsonify(value) as QuotaInfo;
}

async function setupDatabase(): Promise<{
  root: Surreal;
  conn: SurrealConn;
  database: string;
}> {
  const database = `cv02_quota_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const root = new Surreal();
  opened.push(root);
  await root.connect(SURREAL_URL, { authentication: AUTH });
  await root.query(
    `DEFINE NAMESPACE IF NOT EXISTS ${SURREAL_NS}; USE NS ${SURREAL_NS}; DEFINE DATABASE IF NOT EXISTS ${database};`,
  ).collect();
  await root.use({ namespace: SURREAL_NS, database });
  await root.query(`
    DEFINE TABLE workbook_template SCHEMALESS;

    DEFINE TABLE workbook SCHEMAFULL;
    DEFINE FIELD name ON TABLE workbook TYPE string;
    DEFINE FIELD template ON TABLE workbook TYPE option<record<workbook_template>>;
    DEFINE FIELD last_opened_sheet ON TABLE workbook TYPE option<record<sheet>>;
    DEFINE FIELD created_at ON TABLE workbook TYPE datetime VALUE time::now() READONLY;
    DEFINE FIELD updated_at ON TABLE workbook TYPE datetime VALUE time::now();

    DEFINE TABLE sheet SCHEMAFULL;
    DEFINE FIELD workbook ON TABLE sheet TYPE record<workbook>;
    DEFINE FIELD label ON TABLE sheet TYPE string;
    DEFINE FIELD table_name ON TABLE sheet TYPE string;
    DEFINE FIELD column_defs ON TABLE sheet TYPE any DEFAULT [];
    DEFINE FIELD template_sheet_key ON TABLE sheet TYPE option<string>;
    DEFINE FIELD created_at ON TABLE sheet TYPE datetime VALUE time::now() READONLY;
    DEFINE FIELD updated_at ON TABLE sheet TYPE datetime VALUE time::now();
    DEFINE INDEX sheet_table_name_unique ON TABLE sheet COLUMNS table_name UNIQUE;

    DEFINE TABLE activity_event SCHEMALESS;
  `).collect();

  // 与既有集成夹具一致：按原样应用 020 并放宽 MVP 额度，legacy 守卫不干扰判定。
  const quotaMigration = await Bun.file(new URL(
    "../../../shared/sql/workspace-template/020-resource-quota.surql",
    import.meta.url,
  )).text();
  await root.query(quotaMigration).collect();
  await root.query(`
    UPDATE resource_quota_plan:plus SET
      max_sheets = 10,
      max_fields_per_sheet = 40,
      max_records_per_sheet = 10000;
  `).collect();

  const [pack] = await loadTemplatePackScripts({ selectedPacks: ["bankruptcy-claims"] });
  await root.query(pack!.sql).collect();

  const browser = new Surreal();
  opened.push(browser);
  const conn = createBrowserConn(browser as never);
  await conn.connect(SURREAL_URL, { authentication: AUTH, namespace: SURREAL_NS, database });
  return { root, conn, database };
}

async function loadClaimsTemplate(conn: SurrealConn) {
  const templates = createWorkbookTemplatesStore({ getConn: () => conn });
  await templates.load();
  const template = templates.byKey("bankruptcy-claims");
  if (!template) throw new Error("bankruptcy-claims template missing");
  return template;
}

const V1_MAX = { tables: 3, fields: 9, records: 6 };
const V2_MAX = { tables: 3, fields: 11, records: 12 };

describe("CV02 — 原生配额下破产债权包创建（公司 fork 真机）", () => {
  localSurrealTest("v1 Max 修订下引擎原子拒绝整包：无残留 workbook/sheet/实体表", async () => {
    const { root, conn, database } = await setupDatabase();
    await root.query(quotaPolicySurql(database, V1_MAX)).collect();

    const template = await loadClaimsTemplate(conn);
    const workbooks = createWorkbooksStore({ getConn: () => conn });
    const workbook = await workbooks.createFromTemplate({
      ...template,
      sheets: templateSheetsForCreate(template),
    });

    expect(workbook).toBeNull();
    expect(workbooks.error).toBeTruthy();
    // 原子性：拒绝后不留任何建簿痕迹。
    const [sheets] = await root.query<[unknown[]]>("SELECT * FROM sheet;").then((r) => [jsonify(r[0])]);
    const [workbookRows] = await root.query<[unknown[]]>("SELECT * FROM workbook;").then((r) => [jsonify(r[0])]);
    expect(sheets).toEqual([]);
    expect(workbookRows).toEqual([]);
    const info = await quotaInfo(root, database);
    // entity-tables 桶（^ent_ 规则）无新增表：拒绝整体回滚，实体表零残留。
    const entBucket = info.usage?.table_buckets?.find((bucket) => bucket.rule_id === "entity-tables");
    expect(entBucket?.used ?? 0).toBe(0);
  }, 30_000);

  localSurrealTest("入口预检在 v1 Max 下给出准确缺口且零写入", async () => {
    const { root, conn, database } = await setupDatabase();
    await root.query(quotaPolicySurql(database, V1_MAX)).collect();

    const template = await loadClaimsTemplate(conn);
    const workbooks = createWorkbooksStore({
      getConn: () => conn,
      getWorkspaceQuotaView: async () => {
        const info = await quotaInfo(root, database);
        return {
          format_version: 1,
          view: "workspace_admin",
          viewer: { subject: "user:test", capabilities: ["workspace_quota.read"] },
          workspace: { id: "workspace:w", slug: "w", name: "W" },
          statuses: { sync: "in_sync", compliance: "compliant", capacity: "normal", service_mode: "standard", ledger: "ready" },
          observed_at: null,
          commercial_state_at: new Date().toISOString(),
          cache_age_ms: null,
          usage_trusted: true,
          stale: false,
          applied: null,
          desired: null,
          billing_account: null,
          resources: projectQuotaResources(info),
          actions: ["refresh"],
        } satisfies QuotaApiWorkspaceView;
      },
    });

    const workbook = await workbooks.createFromTemplate({
      ...template,
      sheets: templateSheetsForCreate(template),
    });

    expect(workbook).toBeNull();
    // 物理口径：claims 9 业务列 + 2 系统字段 = 11 > 9；12 条样例 > 6。
    expect(workbooks.error).toContain("需要 11");
    expect(workbooks.error).toContain("上限 9");
    expect(workbooks.error).toContain("需要 12");
    expect(workbooks.error).toContain("上限 6");
    const [workbookRows] = await root.query<[unknown[]]>("SELECT * FROM workbook;").then((r) => [jsonify(r[0])]);
    expect(workbookRows).toEqual([]);
  }, 30_000);

  localSurrealTest("升级到 Max v2（3/11/12）后同包立即创建成功，INFO 读回印证修订", async () => {
    const { root, conn, database } = await setupDatabase();
    // 先按 v1 应用，再切 v2——复刻既有 workspace 经运营事件升级的路径。
    // OVERWRITE 需 EXPECT GENERATION 乐观并发，从 INFO 读回当前代次。
    await root.query(quotaPolicySurql(database, V1_MAX)).collect();
    const before = await quotaInfo(root, database);
    const generation = before.policy?.generation ?? before.latest_change?.generation;
    if (generation === undefined) throw new Error("quota policy generation missing");
    await root.query(quotaPolicySurql(database, V2_MAX, generation)).collect();

    const template = await loadClaimsTemplate(conn);
    const workbooks = createWorkbooksStore({ getConn: () => conn });
    const workbook = await workbooks.createFromTemplate({
      ...template,
      sheets: templateSheetsForCreate(template),
    });

    expect(workbook).not.toBeNull();
    const sheets = jsonify((await root.query("SELECT * FROM sheet ORDER BY label;"))[0]) as Array<{ table_name: string; label: string }>;
    expect(sheets).toHaveLength(2);
    const claimsTable = sheets.find((sheet) => sheet.label === "债权申报")!.table_name;
    const creditorsTable = sheets.find((sheet) => sheet.label === "债权人")!.table_name;

    const claimCount = jsonify((await root.query(`SELECT count() FROM ${claimsTable} GROUP ALL;`))[0]) as Array<{ count: number }>;
    const creditorCount = jsonify((await root.query(`SELECT count() FROM ${creditorsTable} GROUP ALL;`))[0]) as Array<{ count: number }>;
    expect(claimCount[0]?.count).toBe(12);
    expect(creditorCount[0]?.count).toBe(6);

    // INFO 读回：entity 规则实际限额 ≥ 3/11/12。
    const info = await quotaInfo(root, database);
    const finiteFor = (resource: "table" | "field" | "record") => info.policy?.rules?.find(
      (rule) => rule.resource === resource
        && rule.selector.kind === "regex"
        && rule.selector.pattern === "^ent_"
        && rule.limit.kind === "finite",
    )?.limit;
    expect(finiteFor("table")).toEqual({ kind: "finite", value: 3 });
    expect(finiteFor("field")).toEqual({ kind: "finite", value: 11 });
    expect(finiteFor("record")).toEqual({ kind: "finite", value: 12 });
  }, 30_000);
});
