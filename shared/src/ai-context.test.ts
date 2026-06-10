import { describe, expect, test } from "bun:test";
import { buildAiContextSnapshot } from "./ai-context";

describe("buildAiContextSnapshot — 四种选择状态", () => {
  test("no-selection：只携带路由，workbook/sheet/selectedRow 全空，提示反映路由", () => {
    const snapshot = buildAiContextSnapshot({
      route: { screen: "home" },
    });

    expect(snapshot.route).toEqual({ screen: "home" });
    expect(snapshot.workbook).toBeNull();
    expect(snapshot.sheet).toBeNull();
    expect(snapshot.selectedRow).toBeNull();
    expect(snapshot.contextHint).toBe("当前在应用首页");
  });

  test("workbook-only：进入工作簿未选 sheet，workbook 有值、sheet/selectedRow 为空，提示落回路由标签", () => {
    const snapshot = buildAiContextSnapshot({
      route: { screen: "editor", workbookId: "workbook:case" },
      workbook: { id: "workbook:case", name: "项目台账" },
    });

    expect(snapshot.workbook).toEqual({ id: "workbook:case", name: "项目台账" });
    expect(snapshot.sheet).toBeNull();
    expect(snapshot.selectedRow).toBeNull();
    expect(snapshot.contextHint).toBe("当前在表格工作簿");
  });

  test("sheet-selected：提示为「工作簿 / Sheet」，不携带记录上下文", () => {
    const snapshot = buildAiContextSnapshot({
      route: { screen: "editor", workbookId: "workbook:case", sheetId: "sheet:customers" },
      workbook: { id: "workbook:case", name: "项目台账" },
      sheet: { id: "sheet:customers", label: "客户表", tableName: "ent_customer" },
    });

    expect(snapshot.sheet).toEqual({ id: "sheet:customers", label: "客户表", tableName: "ent_customer" });
    expect(snapshot.selectedRow).toBeNull();
    expect(snapshot.contextHint).toBe("项目台账 / 客户表");
  });

  test("row-selected：携带 record id（RecordId 字符串形态）、可见值与稳定标签，提示为「Sheet / 标签」", () => {
    const snapshot = buildAiContextSnapshot({
      route: { screen: "editor", workbookId: "workbook:case", sheetId: "sheet:customers" },
      workbook: { id: "workbook:case", name: "项目台账" },
      sheet: { id: "sheet:customers", label: "客户表", tableName: "ent_customer" },
      selectedRowId: "ent_customer:abc",
      rows: [
        {
          id: "ent_customer:abc",
          values: { customer_name: "张三", customer_code: "KH-2026-001", amount: 120000 },
        },
      ],
      visibleColumns: [
        { key: "customer_name", label: "客户名称", fieldType: "text" },
        { key: "customer_code", label: "客户编号", fieldType: "text" },
        { key: "amount", label: "金额", fieldType: "decimal" },
      ],
    });

    expect(snapshot.selectedRow).toEqual({
      id: "ent_customer:abc",
      label: "张三 || KH-2026-001 || ent_customer:abc",
      visibleValues: { customer_name: "张三", customer_code: "KH-2026-001", amount: 120000 },
    });
    expect(snapshot.contextHint).toBe("客户表 / 张三 || KH-2026-001 || ent_customer:abc");
  });

  test("row-selected：visibleValues 只含可见列，隐藏列不进快照", () => {
    const snapshot = buildAiContextSnapshot({
      route: { screen: "editor" },
      sheet: { id: "sheet:customers", label: "客户表", tableName: "ent_customer" },
      selectedRowId: "ent_customer:abc",
      rows: [
        { id: "ent_customer:abc", values: { customer_name: "张三", secret_note: "内部备注" } },
      ],
      visibleColumns: [{ key: "customer_name", label: "客户名称", fieldType: "text" }],
    });

    expect(snapshot.selectedRow?.visibleValues).toEqual({ customer_name: "张三" });
  });
});

describe("buildAiContextSnapshot — 陈旧态清除", () => {
  test("切 sheet 后旧 selectedRowId 不在新行集里：selectedRow 清空，提示退回「工作簿 / Sheet」", () => {
    const snapshot = buildAiContextSnapshot({
      route: { screen: "editor", workbookId: "workbook:case", sheetId: "sheet:orders" },
      workbook: { id: "workbook:case", name: "项目台账" },
      sheet: { id: "sheet:orders", label: "订单表", tableName: "ent_order" },
      selectedRowId: "ent_customer:abc",
      rows: [{ id: "ent_order:o1", values: { order_code: "DD-001" } }],
      visibleColumns: [{ key: "order_code", label: "订单编号", fieldType: "text" }],
    });

    expect(snapshot.sheet?.id).toBe("sheet:orders");
    expect(snapshot.selectedRow).toBeNull();
    expect(snapshot.contextHint).toBe("项目台账 / 订单表");
  });

  test("切 workbook 后未选 sheet：sheet 与 selectedRow 都清空，提示退回路由标签", () => {
    const snapshot = buildAiContextSnapshot({
      route: { screen: "editor", workbookId: "workbook:next" },
      workbook: { id: "workbook:next", name: "新台账" },
      selectedRowId: null,
    });

    expect(snapshot.workbook?.id).toBe("workbook:next");
    expect(snapshot.sheet).toBeNull();
    expect(snapshot.selectedRow).toBeNull();
    expect(snapshot.contextHint).toBe("当前在表格工作簿");
  });

  test("取消选行（selectedRowId 为 null）：即使行数据仍在，也退回 sheet-selected 形态", () => {
    const snapshot = buildAiContextSnapshot({
      route: { screen: "editor", workbookId: "workbook:case", sheetId: "sheet:customers" },
      workbook: { id: "workbook:case", name: "项目台账" },
      sheet: { id: "sheet:customers", label: "客户表", tableName: "ent_customer" },
      selectedRowId: null,
      rows: [{ id: "ent_customer:abc", values: { customer_name: "张三" } }],
      visibleColumns: [{ key: "customer_name", label: "客户名称", fieldType: "text" }],
    });

    expect(snapshot.selectedRow).toBeNull();
    expect(snapshot.contextHint).toBe("项目台账 / 客户表");
  });
});

describe("buildAiContextSnapshot — 选中行标签优先级（name > code > id）", () => {
  const sheet = { id: "sheet:customers", label: "客户表", tableName: "ent_customer" } as const;

  function rowSnapshot(values: Record<string, unknown>, columns: Array<{ key: string; label: string }>) {
    return buildAiContextSnapshot({
      route: { screen: "editor" },
      sheet,
      selectedRowId: "ent_customer:abc",
      rows: [{ id: "ent_customer:abc", values }],
      visibleColumns: columns.map((c) => ({ ...c, fieldType: "text" })),
    });
  }

  test("name 存在时主标签取 name，不落到 code 或 id", () => {
    const snapshot = rowSnapshot(
      { customer_name: "张三", customer_code: "KH-001" },
      [
        { key: "customer_name", label: "客户名称" },
        { key: "customer_code", label: "客户编号" },
      ],
    );

    expect(snapshot.selectedRow?.label.startsWith("张三")).toBe(true);
    expect(snapshot.selectedRow?.label).toBe("张三 || KH-001 || ent_customer:abc");
  });

  test("name 缺失时落到 code，id 始终以 RecordId 字符串形态垫底", () => {
    const snapshot = rowSnapshot(
      { customer_code: "KH-001" },
      [{ key: "customer_code", label: "客户编号" }],
    );

    expect(snapshot.selectedRow?.label).toBe("KH-001 || ent_customer:abc");
  });

  test("name 与 code 都缺失时只剩 RecordId 字符串", () => {
    const snapshot = rowSnapshot(
      { amount: 100 },
      [{ key: "amount", label: "金额" }],
    );

    expect(snapshot.selectedRow?.label).toBe("ent_customer:abc");
  });
});

describe("buildAiContextSnapshot — 快照独立性", () => {
  test("提交后编辑原始行对象不会改写已建快照（消息历史不被污染）", () => {
    const row = {
      id: "ent_customer:abc" as const,
      values: { customer_name: "张三", attachment: { fileName: "a.pdf" } },
    };
    const snapshot = buildAiContextSnapshot({
      route: { screen: "editor" },
      sheet: { id: "sheet:customers", label: "客户表", tableName: "ent_customer" },
      selectedRowId: "ent_customer:abc",
      rows: [row],
      visibleColumns: [
        { key: "customer_name", label: "客户名称", fieldType: "text" },
        { key: "attachment", label: "附件", fieldType: "json" },
      ],
    });

    row.values.customer_name = "李四";
    (row.values.attachment as { fileName: string }).fileName = "b.pdf";

    expect(snapshot.selectedRow?.visibleValues).toEqual({
      customer_name: "张三",
      attachment: { fileName: "a.pdf" },
    });
  });
});
