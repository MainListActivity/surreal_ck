import type { GridColumnDef } from "../../../../shared/rpc.types";

export type DerivedColumns = {
  title: GridColumnDef | null;
  secondary: GridColumnDef | null;
  status: GridColumnDef | null;
  amount: GridColumnDef | null;
  date: GridColumnDef | null;
};

export function deriveColumns(columns: GridColumnDef[]): DerivedColumns {
  return {
    title: columns[0] ?? null,
    secondary: columns[1] ?? null,
    status:
      columns.find((col) => /status|状态/i.test(col.key) || /状态/.test(col.label)) ??
      columns.find((col) => col.options?.length) ??
      null,
    amount:
      columns.find((col) => col.fieldType === "number" || col.fieldType === "decimal") ?? null,
    date: columns.find((col) => col.fieldType === "date") ?? null,
  };
}
