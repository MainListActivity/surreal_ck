import { expect, test } from "bun:test";
import type { SurrealConn } from "../surreal";
import { archiveFields, buildRosterArchiveCsv, isRosterArchiveSheet, readRosterArchive } from "./roster-archive";

test("归档仅选择包含所需字段和字段类型的目标表", () => {
  const sheet = {
    id: "sheet:a", label: "统计", table_name: "ent_votes",
    column_defs: Object.entries(archiveFields.vote).map(([key, field_type]) => ({ key, field_type })),
  };
  expect(isRosterArchiveSheet(sheet, "vote")).toBe(true);
  expect(isRosterArchiveSheet(sheet, "attendance")).toBe(false);
  expect(isRosterArchiveSheet({ ...sheet, column_defs: sheet.column_defs.filter(({ key }) => key !== "ballots") }, "vote")).toBe(false);
  expect(isRosterArchiveSheet({ ...sheet, column_defs: sheet.column_defs.map((field) =>
    field.key === "count" ? { ...field, field_type: "text" } : field) }, "vote")).toBe(false);
});

test("浏览器按数据表 ID 解析物理表，再分页读取本场会议的全部归档", async () => {
  const calls: { sql: string; bindings?: Record<string, unknown> }[] = [];
  const first = Array.from({ length: 500 }, (_, count) => ({ count }));
  const last = [{ count: 500, ballots: '[{"note":"保留意见"}]' }];
  const conn: Pick<SurrealConn, "query"> = {
    async query<T>(sql: string, bindings?: Record<string, unknown>): Promise<T[]> {
      calls.push({ sql, bindings });
      const result = calls.length === 1 ? [{ table_name: "ent_votes" }] : calls.length === 2 ? first : last;
      return result as T[];
    },
  };
  const table = await readRosterArchive(conn, "roster_meeting:a", "sheet:a", "vote");
  expect(String(calls[0]?.bindings?.sheet)).toBe("sheet:a");
  expect(calls.slice(1).map(({ bindings }) => bindings)).toEqual([
    { table: "ent_votes", meeting: "roster_meeting:a", limit: 500, offset: 0 },
    { table: "ent_votes", meeting: "roster_meeting:a", limit: 500, offset: 500 },
  ]);
  expect(calls[1]?.sql).toContain("WHERE meeting_id = $meeting ORDER BY id");
  expect(table.rows).toHaveLength(501);
  const csv = buildRosterArchiveCsv(table);
  expect(csv).toStartWith("\uFEFFmeeting_id,poll_id,title,version,option,label,count,weight,ballots\r\n");
  expect(csv).toEndWith('500,,"[{""note"":""保留意见""}]"\r\n');
});

test("归档 CSV 对公式型文本进行转义，保留数字和布尔值", () => {
  expect(buildRosterArchiveCsv({ label: "签到", fields: ["name", "attended", "duration_ms"], rows: [
    { name: " =1+1", attended: false, duration_ms: 0 },
  ] })).toBe("\uFEFFname,attended,duration_ms\r\n' =1+1,false,0\r\n");
});

test("归档 CSV 转义名册中以全角公式字符开头的中文文本", () => {
  const names = ["＝合成债权人", "　＋合成债权人", "－合成债权人", "＠合成债权人", "合成债权人"];
  const csv = buildRosterArchiveCsv({ label: "签到", fields: ["name"], rows: names.map((name) => ({ name })) });
  expect(csv).toBe("\uFEFFname\r\n'＝合成债权人\r\n'　＋合成债权人\r\n'－合成债权人\r\n'＠合成债权人\r\n合成债权人\r\n");
});
