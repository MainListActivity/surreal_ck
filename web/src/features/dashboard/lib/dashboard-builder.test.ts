import { describe, expect, test } from "bun:test";
import {
  blankBuilderDraft,
  builderFieldOptions,
  draftFromWidget,
  specFromDraft,
  validateBuilderDraft,
  widgetFromDraft,
  type BuilderDraft,
} from "./dashboard-builder";

const barDraft: BuilderDraft = {
  title: "",
  chartType: "bar",
  baseTable: "ent_claim",
  metricOp: "sum",
  metricField: "amount",
  dimensionField: "status",
  timeBucket: "",
  filters: [],
  limit: 12,
};

describe("specFromDraft — builder 草稿编译成 shared BuilderSpec", () => {
  test("柱状图：分组维度无时间桶，指标带字段", () => {
    expect(specFromDraft(barDraft)).toEqual({
      sourceTables: ["ent_claim"],
      baseTable: "ent_claim",
      metric: { op: "sum", field: "amount" },
      dimensions: [{ field: "status" }],
      limit: 12,
    });
  });

  test("数字卡：不带维度；count 指标不带字段", () => {
    expect(specFromDraft({ ...barDraft, chartType: "kpi", metricOp: "count" })).toEqual({
      sourceTables: ["ent_claim"],
      baseTable: "ent_claim",
      metric: { op: "count" },
      limit: 12,
    });
  });

  test("折线图：维度带时间桶", () => {
    const spec = specFromDraft({
      ...barDraft,
      chartType: "line",
      dimensionField: "created_at",
      timeBucket: "month",
    });
    expect(spec.dimensions).toEqual([{ field: "created_at", bucket: "month" }]);
  });

  test("筛选：丢弃缺字段/缺值的行，数字串转 number，in 按逗号拆数组，is_null 不带值", () => {
    const spec = specFromDraft({
      ...barDraft,
      filters: [
        { field: "status", op: "eq", value: "已确认" },
        { field: "amount", op: "gte", value: "1000" },
        { field: "stage", op: "in", value: "一审, 二审" },
        { field: "closed_at", op: "is_null", value: "" },
        { field: "", op: "eq", value: "x" },
        { field: "status", op: "eq", value: "" },
      ],
    });
    expect(spec.filters).toEqual([
      { field: "status", op: "eq", value: "已确认" },
      { field: "amount", op: "gte", value: 1000 },
      { field: "stage", op: "in", value: ["一审", "二审"] },
      { field: "closed_at", op: "is_null" },
    ]);
  });
});

describe("validateBuilderDraft — 非法配置返回中文错误，合法返回 null", () => {
  test("合法草稿返回 null", () => {
    expect(validateBuilderDraft(barDraft)).toBeNull();
  });

  test("未选数据表", () => {
    expect(validateBuilderDraft({ ...barDraft, baseTable: "" })).toBe("请选择数据表");
  });

  test("非 count 指标缺字段", () => {
    expect(validateBuilderDraft({ ...barDraft, metricField: "" })).toBe("当前统计方式需要选择字段");
  });

  test("非数字卡缺分组字段", () => {
    expect(validateBuilderDraft({ ...barDraft, dimensionField: "" })).toBe("请选择分组字段");
  });

  test("非法标识符透传 D3-02 校验的中文错误", () => {
    const message = validateBuilderDraft({ ...barDraft, dimensionField: "status; DROP" });
    expect(message).toContain("非法的分组字段");
  });
});

describe("widgetFromDraft — 草稿落成 dashboard_page.widgets[] 同口径的 widget", () => {
  test("新建：生成 id，按既有数量两列流式布局，kpi 高度 1 其余 2", () => {
    const existing = [
      { id: "w1", title: "a", viewType: "kpi", spec: specFromDraft(barDraft), grid: { x: 0, y: 0, w: 6, h: 1 } },
    ] as const;
    const widget = widgetFromDraft(barDraft, { widgets: [...existing] });
    expect(widget.id).toMatch(/^widget_/);
    expect(widget.id).not.toBe("w1");
    expect(widget.grid).toEqual({ x: 6, y: 0, w: 6, h: 2 });
    expect(widget.viewType).toBe("bar");
    expect(widget.spec).toEqual(specFromDraft(barDraft));

    const kpi = widgetFromDraft(
      { ...barDraft, chartType: "kpi" },
      { widgets: [...existing, widget] },
    );
    expect(kpi.grid).toEqual({ x: 0, y: 2, w: 6, h: 1 });
  });

  test("新建：标题留空时自动生成「表 维度 指标」标题", () => {
    const widget = widgetFromDraft(barDraft, { widgets: [], tableLabel: "债权表" });
    expect(widget.title).toBe("债权表 status amount 总和");
  });

  test("编辑：保留原 id 与 grid，标题/类型/spec 取草稿", () => {
    const original = {
      id: "w9",
      title: "旧标题",
      viewType: "kpi" as const,
      spec: specFromDraft({ ...barDraft, chartType: "kpi" }),
      grid: { x: 6, y: 4, w: 6, h: 1 },
    };
    const widget = widgetFromDraft({ ...barDraft, title: "新标题" }, { widgets: [original], existing: original });
    expect(widget).toEqual({
      id: "w9",
      title: "新标题",
      viewType: "bar",
      spec: specFromDraft(barDraft),
      grid: { x: 6, y: 4, w: 6, h: 1 },
    });
  });
});

describe("draftFromWidget — 编辑既有 widget 时回填表单（AI 与手工产出同口径）", () => {
  test("折线 widget 回填时间桶与筛选", () => {
    const widget = widgetFromDraft(
      {
        ...barDraft,
        chartType: "line",
        dimensionField: "created_at",
        timeBucket: "month",
        filters: [{ field: "status", op: "eq", value: "已确认" }],
      },
      { widgets: [] },
    );
    const draft = draftFromWidget(widget);
    expect(draft.chartType).toBe("line");
    expect(draft.baseTable).toBe("ent_claim");
    expect(draft.metricOp).toBe("sum");
    expect(draft.metricField).toBe("amount");
    expect(draft.dimensionField).toBe("created_at");
    expect(draft.timeBucket).toBe("month");
    expect(draft.filters).toEqual([{ field: "status", op: "eq", value: "已确认" }]);
    expect(draft.limit).toBe(12);
  });
});

describe("blankBuilderDraft / builderFieldOptions — 表单初值与字段选项", () => {
  const columns = [
    { key: "id", label: "ID", fieldType: "text" },
    { key: "name", label: "名称", fieldType: "text" },
    { key: "amount", label: "金额", fieldType: "currency" },
    { key: "votes", label: "票数", fieldType: "number" },
    { key: "created_at", label: "创建时间", fieldType: "date" },
    { key: "owner", label: "负责人", fieldType: "reference" },
    { key: "meta", label: "元数据", fieldType: "json" },
  ];

  test("空白草稿默认柱状图 + 首表 + count + limit 12", () => {
    expect(blankBuilderDraft("ent_claim")).toEqual({
      title: "",
      chartType: "bar",
      baseTable: "ent_claim",
      metricOp: "count",
      metricField: "",
      dimensionField: "",
      timeBucket: "",
      filters: [],
      limit: 12,
    });
  });

  test("数值指标限 number/currency；维度排除 reference/json/id；日期字段单列", () => {
    const options = builderFieldOptions(columns);
    expect(options.numericFields.map((f) => f.key)).toEqual(["amount", "votes"]);
    expect(options.dimensionFields.map((f) => f.key)).toEqual(["name", "amount", "votes", "created_at"]);
    expect(options.dateFields.map((f) => f.key)).toEqual(["created_at"]);
    expect(options.allFields.map((f) => f.key)).toContain("owner");
  });
});
