import { describe, expect, test } from "bun:test";
import { buildAiContextSnapshot } from "../../shared/ai-context";

describe("buildAiContextSnapshot", () => {
  test("没有工作簿上下文时只提交当前路由", () => {
    const snapshot = buildAiContextSnapshot({
      route: { screen: "home" },
    });

    expect(snapshot.route).toEqual({ screen: "home" });
    expect(snapshot.workbook).toBeNull();
    expect(snapshot.sheet).toBeNull();
    expect(snapshot.selectedRow).toBeNull();
    expect(snapshot.contextHint).toBe("当前在应用首页");
  });

  test("选中数据表时提交工作簿和数据表上下文，不携带记录上下文", () => {
    const snapshot = buildAiContextSnapshot({
      route: { screen: "editor", workbookId: "workbook:case" },
      workbook: { id: "workbook:case", name: "债权工作簿" },
      sheet: { id: "sheet:claims", label: "债权申报表", tableName: "ent_claim" },
    });

    expect(snapshot.workbook).toEqual({ id: "workbook:case", name: "债权工作簿" });
    expect(snapshot.sheet).toEqual({ id: "sheet:claims", label: "债权申报表", tableName: "ent_claim" });
    expect(snapshot.selectedRow).toBeNull();
    expect(snapshot.contextHint).toBe("债权工作簿 / 债权申报表");
  });

  test("选中记录时提交记录 id、可见值和稳定业务标签", () => {
    const snapshot = buildAiContextSnapshot({
      route: { screen: "editor", workbookId: "workbook:case" },
      workbook: { id: "workbook:case", name: "债权工作簿" },
      sheet: { id: "sheet:claims", label: "债权申报表", tableName: "ent_claim" },
      selectedRowId: "ent_claim:abc",
      rows: [
        {
          id: "ent_claim:abc",
          values: {
            claimant_name: "张三",
            claim_code: "ZQ-2026-001",
            amount: 120000,
          },
        },
      ],
      visibleColumns: [
        { key: "claimant_name", label: "申报人", fieldType: "text" },
        { key: "claim_code", label: "债权编号", fieldType: "text" },
        { key: "amount", label: "申报金额", fieldType: "decimal" },
      ],
    });

    expect(snapshot.selectedRow).toEqual({
      id: "ent_claim:abc",
      label: "张三 || ZQ-2026-001 || ent_claim:abc",
      visibleValues: {
        claimant_name: "张三",
        claim_code: "ZQ-2026-001",
        amount: 120000,
      },
    });
    expect(snapshot.contextHint).toBe("债权申报表 / 张三 || ZQ-2026-001 || ent_claim:abc");
  });

  test("切换数据表后新快照不携带旧记录，但旧消息快照保持不变", () => {
    const previousMessageContext = buildAiContextSnapshot({
      route: { screen: "editor", workbookId: "workbook:case" },
      workbook: { id: "workbook:case", name: "债权工作簿" },
      sheet: { id: "sheet:claims", label: "债权申报表", tableName: "ent_claim" },
      selectedRowId: "ent_claim:abc",
      rows: [{ id: "ent_claim:abc", values: { name: "张三", code: "ZQ-2026-001" } }],
      visibleColumns: [
        { key: "name", label: "姓名", fieldType: "text" },
        { key: "code", label: "编号", fieldType: "text" },
      ],
    });

    const nextMessageContext = buildAiContextSnapshot({
      route: { screen: "editor", workbookId: "workbook:case" },
      workbook: { id: "workbook:case", name: "债权工作簿" },
      sheet: { id: "sheet:payments", label: "回款登记表", tableName: "ent_payment" },
      selectedRowId: "ent_claim:abc",
      rows: [{ id: "ent_payment:def", values: { payer_name: "李四" } }],
      visibleColumns: [{ key: "payer_name", label: "付款人", fieldType: "text" }],
    });

    expect(previousMessageContext.selectedRow?.id).toBe("ent_claim:abc");
    expect(previousMessageContext.contextHint).toBe("债权申报表 / 张三 || ZQ-2026-001 || ent_claim:abc");
    expect(nextMessageContext.sheet?.id).toBe("sheet:payments");
    expect(nextMessageContext.selectedRow).toBeNull();
    expect(nextMessageContext.contextHint).toBe("债权工作簿 / 回款登记表");
  });

  test("消息快照复制提交时的可见值，后续编辑当前行不会改写旧快照", () => {
    const row = {
      id: "ent_claim:abc",
      values: {
        name: "张三",
        attachment: { fileName: "claim.pdf" },
      },
    };
    const snapshot = buildAiContextSnapshot({
      route: { screen: "editor", workbookId: "workbook:case" },
      workbook: { id: "workbook:case", name: "债权工作簿" },
      sheet: { id: "sheet:claims", label: "债权申报表", tableName: "ent_claim" },
      selectedRowId: "ent_claim:abc",
      rows: [row],
      visibleColumns: [
        { key: "name", label: "姓名", fieldType: "text" },
        { key: "attachment", label: "附件", fieldType: "json" },
      ],
    });

    row.values.name = "李四";
    row.values.attachment.fileName = "updated.pdf";

    expect(snapshot.selectedRow?.visibleValues).toEqual({
      name: "张三",
      attachment: { fileName: "claim.pdf" },
    });
  });
});
