import { describe, expect, test } from "bun:test";
import type { SurrealConn } from "./surreal";
import { createDataCheckService } from "./data-check-runtime";

function harness(options: { stale?: boolean; templateVersion?: { current: string } } = {}) {
  const records = Array.from({ length: 501 }, (_, index) => ({
    id: `ent_claim:r${index + 1}`,
    name: index === 500 ? null : `记录 ${index + 1}`,
    updated_at: "2026-09-22T00:00:00Z",
    legal_name: index === 0 ? " ACME " : index === 500 ? "acme" : `主体 ${index}`,
  }));
  const runs = new Map<string, Record<string, unknown>>();
  const findings = new Map<string, Record<string, unknown>>();
  let runSeq = 0;
  let latestReads = 0;
  const sheet = {
    id: "sheet:s1", workbook: "workbook:w1", label: "债权",
    table_name: "ent_claim", template_sheet_key: "claims",
    column_defs: [
      { key: "name", label: "名称", field_type: "text", required: true },
      { key: "legal_name", label: "主体", field_type: "text" },
    ],
  };
  const conn = {
    status: "connected",
    createRecord: async (table: string, data: Record<string, unknown>) => {
      if (table !== "data_check_run") return { id: `${table}:x`, ...data };
      const id = `data_check_run:r${++runSeq}`;
      const row = { id, ...data };
      runs.set(id, row);
      return row;
    },
    updateRecord: async (id: string, patch: Record<string, unknown>) => {
      const row = { ...(runs.get(id) ?? { id }), ...patch };
      runs.set(id, row);
      return row;
    },
    query: async (sql: string, bindings?: Record<string, unknown>) => {
      if (/FROM sheet WHERE workbook/i.test(sql)) return [sheet];
      if (/SELECT template FROM workbook/i.test(sql)) {
        return options.templateVersion ? [{ template: "workbook_template:claims" }] : [];
      }
      if (/FROM workbook_template/i.test(sql)) return [{
        sheet_defs: [{ key: "claims", label: "债权", column_defs: sheet.column_defs }],
        check_rules: {
          version: options.templateVersion?.current,
          rules: [{
            key: "same_legal_name", type: "duplicate", sheet_key: "claims",
            fields: ["legal_name"], minimum_group_size: 2, explanation: "主体名称相同",
          }],
        },
      }];
      if (/FROM sheet WHERE id/i.test(sql)) return [sheet];
      if (/SELECT count\(\) AS total/i.test(sql)) return [{ total: records.length }];
      if (/SELECT updated_at .*ORDER BY updated_at DESC/i.test(sql)) {
        latestReads += 1;
        return [{ updated_at: options.stale && latestReads > 1 ? "2026-09-22T00:01:00Z" : "2026-09-22T00:00:00Z" }];
      }
      if (/FROM type::table/i.test(sql)) {
        const limit = Number(sql.match(/LIMIT (\d+)/i)?.[1] ?? records.length);
        const start = Number(sql.match(/START (\d+)/i)?.[1] ?? 0);
        return records.slice(start, start + limit);
      }
      if (/INSERT INTO data_check_finding/i.test(sql)) {
        const stable = String(bindings?.stableKey);
        const previous = findings.get(stable);
        const row = previous ?? {
          id: `data_check_finding:${stable}`,
          category: bindings?.category, explanation: bindings?.explanation,
          rule_key: bindings?.ruleKey, rule_version: bindings?.ruleVersion,
          record: bindings?.record, sheet: bindings?.sheet,
          field: bindings?.field, evidence_fingerprint: bindings?.evidenceFingerprint,
        };
        findings.set(stable, row);
        return [row];
      }
      if (/FROM data_check_run WHERE workbook/i.test(sql)) return [{ id: [...runs.keys()].at(-1) }];
      if (/FROM data_check_run/i.test(sql)) return [runs.get(String(bindings?.run))].filter(Boolean);
      if (/FROM data_check_finding/i.test(sql)) return [...findings.values()];
      return [];
    },
    liveTable: async () => () => {},
    close: async () => true,
    connect: async () => true,
    authenticate: async () => ({}),
    use: async () => ({}),
    subscribe: () => () => {},
  } as unknown as SurrealConn;
  return { conn, runs, findings };
}

describe("全范围数据体检公开接口", () => {
  test("扫描 501 条并发现默认窗口外的末尾必填问题，结果可恢复", async () => {
    const h = harness();
    const service = createDataCheckService(h.conn);

    const result = await service.start({ workbookId: "workbook:w1" });
    const recovered = await service.load(result.id);

    expect(result).toMatchObject({ status: "completed", scannedCount: 501, findingCount: 1, stale: false });
    expect(result.findings[0]).toMatchObject({ category: "required", recordId: "ent_claim:r501", field: "name" });
    expect(recovered).toMatchObject({ id: result.id, status: "completed", findingCount: 1 });
    expect(await service.loadLatest("workbook:w1")).toMatchObject({ id: result.id, findingCount: 1 });
  });

  test("同规则版本重扫合并稳定问题；扫描期间变化标记待重检", async () => {
    const h = harness({ stale: true });
    const service = createDataCheckService(h.conn);
    const first = await service.start({ workbookId: "workbook:w1" });
    const second = await service.start({ workbookId: "workbook:w1" });

    expect(first.stale).toBe(true);
    expect(second.findings[0]?.id).toBe(first.findings[0]?.id);
    expect(h.findings.size).toBe(1);
  });

  test("取消后持久化 cancelled，不显示为无问题", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const result = await createDataCheckService(h.conn).start({ workbookId: "workbook:w1", signal: controller.signal });

    expect(result).toMatchObject({ status: "cancelled", stale: true, error: "用户已取消" });
  });

  test("模板规则跨 500 条分页产生候选，升级版本后不复用旧问题身份", async () => {
    const version = { current: "v1" };
    const h = harness({ templateVersion: version });
    const service = createDataCheckService(h.conn);
    const first = await service.start({ workbookId: "workbook:w1" });
    version.current = "v2";
    const second = await service.start({ workbookId: "workbook:w1" });
    const firstDuplicates = first.findings.filter((finding) => finding.category === "duplicate_candidate");
    const secondDuplicates = second.findings.filter((finding) => finding.category === "duplicate_candidate");

    expect(first.rulesVersion).toContain("template:v1");
    expect(firstDuplicates.map((finding) => finding.recordId)).toEqual(["ent_claim:r1", "ent_claim:r501"]);
    expect(second.rulesVersion).toContain("template:v2");
    expect(secondDuplicates[0]?.id).not.toBe(firstDuplicates[0]?.id);
    expect(firstDuplicates.every((finding) => finding.explanation.includes("仅供核验"))).toBe(true);
  });
});
