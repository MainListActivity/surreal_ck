import { describe, expect, test } from "bun:test";
import type { GridColumnDef } from "@surreal-ck/shared/rpc.types";
import { deriveColumns } from "./derived-columns";

const col = (over: Partial<GridColumnDef> & Pick<GridColumnDef, "key" | "label" | "fieldType">): GridColumnDef =>
  ({ ...over }) as GridColumnDef;

describe("deriveColumns — 从列定义挑出卡片渲染用的语义列", () => {
  test("title/secondary 取前两列", () => {
    const cols = [
      col({ key: "name", label: "名称", fieldType: "text" }),
      col({ key: "note", label: "备注", fieldType: "text" }),
    ];
    const d = deriveColumns(cols);
    expect(d.title?.key).toBe("name");
    expect(d.secondary?.key).toBe("note");
  });

  test("status 优先匹配 key/label 含 status/状态，其次带 options 的列", () => {
    const byKey = deriveColumns([
      col({ key: "name", label: "名称", fieldType: "text" }),
      col({ key: "status", label: "进度", fieldType: "text" }),
    ]);
    expect(byKey.status?.key).toBe("status");

    const byOptions = deriveColumns([
      col({ key: "name", label: "名称", fieldType: "text" }),
      col({ key: "stage", label: "阶段", fieldType: "single_select", options: ["A", "B"] }),
    ]);
    expect(byOptions.status?.key).toBe("stage");
  });

  test("amount 取首个 number/decimal 列，date 取首个 date 列", () => {
    const d = deriveColumns([
      col({ key: "name", label: "名称", fieldType: "text" }),
      col({ key: "due", label: "到期", fieldType: "date" }),
      col({ key: "fee", label: "金额", fieldType: "decimal" }),
    ]);
    expect(d.amount?.key).toBe("fee");
    expect(d.date?.key).toBe("due");
  });

  test("空列表全部为 null", () => {
    expect(deriveColumns([])).toEqual({
      title: null,
      secondary: null,
      status: null,
      amount: null,
      date: null,
    });
  });
});
