import { describe, expect, test } from "bun:test";
import type { QuotaApiResource } from "./api";
import {
  computeEntityCapacityNeed,
  describeCapacityGaps,
  ENTITY_SYSTEM_FIELD_COUNT,
  evaluateEntityCapacity,
} from "./capacity";

function finiteUsage(
  limit: number,
  used: number | null = 0,
): QuotaApiResource["usage"] {
  return {
    kind: "finite",
    limit,
    used,
    remaining: used === null ? null : limit - used,
    over_by: null,
    utilization_percent: null,
    at_limit: null,
    over_limit: null,
  };
}

function regexResource(
  resource: QuotaApiResource["resource"],
  pattern: string,
  limit: number | "unlimited",
  used: number | null = 0,
  reveal = true,
): QuotaApiResource {
  return {
    key: `${resource}-${pattern}`,
    resource,
    label: resource === "table" ? "实体数据表数" : resource === "field" ? "每张实体表字段数" : "每张实体表记录数",
    selector: {
      kind: "regex",
      description: `regex ${pattern}`,
      ...(reveal ? { pattern, matched_tables: [] } : {}),
    },
    usage: limit === "unlimited" ? { kind: "unlimited", used: null, utilization_percent: null, at_limit: false, over_limit: false } : finiteUsage(limit, used),
  };
}

function exactResource(
  resource: QuotaApiResource["resource"],
  table: string,
  limit: number | "unlimited",
): QuotaApiResource {
  return {
    key: `${resource}-exact-${table}`,
    resource,
    label: "精确规则",
    selector: { kind: "exact", description: `表 ${table}`, table },
    usage: limit === "unlimited" ? { kind: "unlimited", used: null, utilization_percent: null, at_limit: false, over_limit: false } : finiteUsage(limit),
  };
}

/** 标准商业规则形状：^ent_ 有限 + .* 无限兜底。 */
function commercialResources(
  limits: { tables: number; fields: number; records: number },
  entUsed = 0,
): QuotaApiResource[] {
  return [
    regexResource("table", ".*", "unlimited"),
    regexResource("table", "^ent_", limits.tables, entUsed),
    regexResource("field", ".*", "unlimited"),
    regexResource("field", "^ent_", limits.fields),
    regexResource("record", ".*", "unlimited"),
    regexResource("record", "^ent_", limits.records),
  ];
}

describe("computeEntityCapacityNeed", () => {
  test("字段需求按物理口径含系统字段，取各表最大值", () => {
    const need = computeEntityCapacityNeed([
      { label: "债权人", businessFields: 6, initialRecords: 6 },
      { label: "债权申报", businessFields: 9, initialRecords: 12 },
    ]);
    expect(need).toEqual({ tables: 2, maxPhysicalFields: 11, maxRecordsPerTable: 12 });
    expect(ENTITY_SYSTEM_FIELD_COUNT).toBe(2);
  });

  test("无样例时记录需求为 0", () => {
    const need = computeEntityCapacityNeed([
      { label: "s", businessFields: 1, initialRecords: 0 },
    ]);
    expect(need).toEqual({ tables: 1, maxPhysicalFields: 3, maxRecordsPerTable: 0 });
  });
});

describe("evaluateEntityCapacity", () => {
  const probe = "ent_probe_abc";

  test("v1 Max（3/9/6）下破产债权包被拒：字段与记录缺口准确", () => {
    const need = computeEntityCapacityNeed([
      { label: "债权人", businessFields: 6, initialRecords: 6 },
      { label: "债权申报", businessFields: 9, initialRecords: 12 },
    ]);
    const verdict = evaluateEntityCapacity(need, commercialResources({ tables: 3, fields: 9, records: 6 }), probe);
    expect(verdict.kind).toBe("insufficient");
    if (verdict.kind !== "insufficient") return;
    const fieldGap = verdict.gaps.find((gap) => gap.resource === "field");
    const recordGap = verdict.gaps.find((gap) => gap.resource === "record");
    expect(fieldGap).toMatchObject({ needed: 11, limit: 9 });
    expect(recordGap).toMatchObject({ needed: 12, limit: 6 });
    expect(verdict.gaps.find((gap) => gap.resource === "table")).toBeUndefined();
  });

  test("v2 Max（3/11/12）下破产债权包通过", () => {
    const need = computeEntityCapacityNeed([
      { label: "债权人", businessFields: 6, initialRecords: 6 },
      { label: "债权申报", businessFields: 9, initialRecords: 12 },
    ]);
    const verdict = evaluateEntityCapacity(need, commercialResources({ tables: 3, fields: 11, records: 12 }), probe);
    expect(verdict.kind).toBe("sufficient");
  });

  test("表桶占用计入剩余量：3 上限已用 2，新建 2 张被拒", () => {
    const need = computeEntityCapacityNeed([
      { label: "a", businessFields: 1, initialRecords: 0 },
      { label: "b", businessFields: 1, initialRecords: 0 },
    ]);
    const verdict = evaluateEntityCapacity(need, commercialResources({ tables: 3, fields: 11, records: 12 }, 2), probe);
    expect(verdict.kind).toBe("insufficient");
    if (verdict.kind !== "insufficient") return;
    expect(verdict.gaps).toHaveLength(1);
    expect(verdict.gaps[0]).toMatchObject({ resource: "table", needed: 2, limit: 3, used: 2, remaining: 1 });
  });

  test("regex_min：多条命中取最小有限上限", () => {
    const resources = [
      regexResource("table", ".*", "unlimited"),
      regexResource("field", ".*", "unlimited"),
      regexResource("field", "^ent_", 20),
      regexResource("field", "^ent_p", 8),
    ];
    const need = computeEntityCapacityNeed([{ label: "x", businessFields: 8, initialRecords: 0 }]);
    const verdict = evaluateEntityCapacity(need, resources, "ent_px");
    expect(verdict.kind).toBe("insufficient");
    if (verdict.kind === "insufficient") {
      expect(verdict.gaps[0]).toMatchObject({ resource: "field", needed: 10, limit: 8 });
    }
  });

  test("exact 规则优先于 regex", () => {
    const resources = [
      ...commercialResources({ tables: 3, fields: 11, records: 12 }),
      exactResource("field", probe, 4),
    ];
    const need = computeEntityCapacityNeed([{ label: "x", businessFields: 4, initialRecords: 0 }]);
    const verdict = evaluateEntityCapacity(need, resources, probe);
    expect(verdict.kind).toBe("insufficient");
    if (verdict.kind === "insufficient") {
      expect(verdict.gaps[0]).toMatchObject({ resource: "field", needed: 6, limit: 4 });
    }
  });

  test("participant 视图（无 pattern）→ unknown，交由引擎强制", () => {
    const need = computeEntityCapacityNeed([{ label: "x", businessFields: 9, initialRecords: 12 }]);
    const verdict = evaluateEntityCapacity(need, commercialResources({ tables: 3, fields: 9, records: 6 }).map(
      (row) => ({ ...row, selector: { kind: "regex", description: row.selector.description } }),
    ), probe);
    expect(verdict.kind).toBe("unknown");
  });

  test("账本用量不可信（used/remaining 为 null）→ unknown", () => {
    const resources = commercialResources({ tables: 3, fields: 11, records: 12 })
      .map((row) => row.resource === "table" && row.selector.kind === "regex" && row.selector.pattern === "^ent_"
        ? { ...row, usage: { kind: "finite" as const, limit: 3, used: null, remaining: null, over_by: null, utilization_percent: null, at_limit: null, over_limit: null } }
        : row);
    const need = computeEntityCapacityNeed([{ label: "x", businessFields: 1, initialRecords: 0 }]);
    expect(evaluateEntityCapacity(need, resources, probe).kind).toBe("unknown");
  });

  test("空 resources / 全部 unlimited → 不阻断", () => {
    const need = computeEntityCapacityNeed([{ label: "x", businessFields: 50, initialRecords: 500 }]);
    expect(evaluateEntityCapacity(need, [], probe).kind).toBe("unknown");
    const unlimitedOnly = [
      regexResource("table", ".*", "unlimited"),
      regexResource("field", ".*", "unlimited"),
      regexResource("record", ".*", "unlimited"),
    ];
    expect(evaluateEntityCapacity(need, unlimitedOnly, probe).kind).toBe("sufficient");
  });
});

describe("describeCapacityGaps", () => {
  test("含所需/上限/剩余的准确缺口文案", () => {
    const text = describeCapacityGaps([
      { resource: "table", label: "实体数据表数", needed: 2, limit: 3, used: 2, remaining: 1 },
      { resource: "field", label: "每张实体表字段数", needed: 11, limit: 9, used: 0, remaining: 9 },
      { resource: "record", label: "每张实体表记录数", needed: 12, limit: 6, used: 0, remaining: 6 },
    ]);
    expect(text).toContain("需要 2");
    expect(text).toContain("上限 3");
    expect(text).toContain("剩余 1");
    expect(text).toContain("需要 11");
    expect(text).toContain("需要 12");
    expect(text).toContain("上限 6");
  });
});
